// Deterministic world layout + island heightfield. Pure, no three.js.
//
// One IRREGULAR landmass (domain-warped noise coastline: bays, headlands,
// uneven beaches; a larger day lobe and a smaller night lobe joined by a
// natural neck), two districts, FIXED GEOGRAPHY:
//   - the day village: 16 pre-planned plots on two loose rings around the
//     central plaza;
//   - the unconscious night quarter: 8 pre-planned plots around its hub,
//     across a ridge, joined by the ridge road.
//
// The streets form a real GRAPH (layout.graph = {nodes, edges, adjacency}):
// the plaza is the main node, seeded junction nodes are jittered across each
// district, edges are curved jittered polylines (loops allowed, width tiers:
// mains wide, house spurs narrow), and every plot hangs off the network at
// its own angle with the door facing its spur. Every plot also carries a
// tiny GARDEN (a small dirt loop around the cottage attached to the spur,
// plus 2-3 seeded garden props). Walkers travel the graph (routeOnGraph,
// makeGraphWanderPlanner); the join cinematic routes home over the same
// graph (world.routeToDoorFrom).
//
// Everything above exists independently of which keepers exist. layoutWorld
// (keepers) only decides OCCUPANCY: keepers are assigned to plots
// deterministically and stably (arrival order + first-fit probing), so an
// keeper keeps her plot when others are added or removed. Empty plots stay
// visible as "undiscovered" sites (the render layer draws a faint stone
// circle + a VACANT signpost + mist).
//
// heightAt(x, z) samples seeded smooth noise with the coastline (softened
// into a beach shelf near the waterline), the ridge, every plot, the plaza
// and all streets flattened into it, so keepers, houses, props, street
// ribbons and the selection ring all sit on the ground.

export function hashString(str) {
  // FNV-1a 32-bit.
  let h = 0x811c9dc5;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Small math helpers (exported for tests and the render layer)
// ---------------------------------------------------------------------------

export function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// Seeded 2D value noise: hashed lattice values, smooth-interpolated.
// Returns values in [0, 1); continuous everywhere, deterministic per seed.
export function makeNoise2D(seed = 1) {
  const s = seed >>> 0;
  function lattice(ix, iz) {
    let h = (Math.imul(ix, 0x9e3779b1) ^ Math.imul(iz, 0x85ebca77) ^ s) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967296;
  }
  return function noise(x, z) {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const fx = x - ix;
    const fz = z - iz;
    const ux = fx * fx * (3 - 2 * fx);
    const uz = fz * fz * (3 - 2 * fz);
    const a = lattice(ix, iz);
    const b = lattice(ix + 1, iz);
    const c = lattice(ix, iz + 1);
    const d = lattice(ix + 1, iz + 1);
    return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
  };
}

// Fractal (multi-octave) value noise in [0, 1], deterministic per seed.
export function makeFbm2D(seed = 1, octaves = 3) {
  const layers = [];
  for (let i = 0; i < octaves; i++) layers.push(makeNoise2D((seed + i * 101) >>> 0));
  return function fbm(x, z) {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += layers[i](x * freq, z * freq) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.13;
    }
    return sum / norm;
  };
}

// Smooth maximum (IQ polynomial): max(a, b) with a rounded crease.
function smax(a, b, k) {
  const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (a - b)) / k));
  return b + (a - b) * h + k * h * (1 - h);
}

function segDist(x, z, a, b) {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const q = abx * abx + abz * abz || 1e-9;
  let t = ((x - a.x) * abx + (z - a.z) * abz) / q;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - (a.x + abx * t), z - (a.z + abz * t));
}

// Soften the coast into a beach shelf: heights near the waterline are pulled
// toward a flat sandy band (grass -> sand -> shallow -> deep, like the
// reference), while heights away from the shore pass through unchanged.
// Strictly monotonic (no terrain inversions). Pure; tested.
export function shoreProfile(h, waterLevel = 0, { center = 0.12, width = 0.55, strength = 0.62 } = {}) {
  const u = (h - waterLevel - center) / width;
  const w = strength * Math.exp(-u * u);
  return h - (h - waterLevel - center) * w;
}

// Blend a raw height toward each plot's level inside its (smoothly feathered)
// radius. Pure; used by heightAt and tested directly.
export function flattenPlots(h, x, z, plots) {
  let out = h;
  for (const p of plots) {
    const d = Math.hypot(x - p.x, z - p.z);
    const w = 1 - smoothstep(p.radius, p.radius * 1.9, d);
    if (w > 0) out += (p.y - out) * w;
  }
  return out;
}

// Clamp a point into a sector disc (center + radius). NPCs never cross
// districts: walkers run every wander/goto target AND their live position
// through this, so even a bad sample or a steering push cannot leak an keeper
// across the ridge. Pure; tested.
export function clampToSector(sector, point, margin = 1.0) {
  const { center, radius } = sector;
  const maxR = Math.max(0.5, radius - margin);
  const dx = point.x - center.x;
  const dz = point.z - center.z;
  const d = Math.hypot(dx, dz);
  if (d <= maxR) return { x: point.x, z: point.z };
  const s = maxR / d;
  return { x: center.x + dx * s, z: center.z + dz * s };
}

// Waypoint route for the join choreography: from the nearest street waypoint,
// follow the street to its end, then step to the door. Pure; tested.
export function routeToDoor(points = [], from = { x: 0, z: 0 }, door = null) {
  let start = 0;
  let best = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = Math.hypot(points[i].x - from.x, points[i].z - from.z);
    if (d < best) {
      best = d;
      start = i;
    }
  }
  const route = [];
  for (let i = start; i < points.length; i++) route.push({ x: points[i].x, z: points[i].z });
  if (door && Number.isFinite(door.x) && Number.isFinite(door.z)) route.push({ x: door.x, z: door.z });
  return route;
}

// ---------------------------------------------------------------------------
// Street-graph routing (pure; the graph itself is built by layoutWorld)
// ---------------------------------------------------------------------------

// The nearest graph node to a point, optionally filtered by sector and node
// kinds. -> node or null.
export function nearestNode(graph, x, z, { sector = null, kinds = null } = {}) {
  let best = null;
  let bd = Infinity;
  for (const n of graph?.nodes ?? []) {
    if (sector && n.sector !== sector) continue;
    if (kinds && !kinds.includes(n.kind)) continue;
    const d = Math.hypot(n.x - x, n.z - z);
    if (d < bd) {
      bd = d;
      best = n;
    }
  }
  return best;
}

// Shortest route over the street graph (Dijkstra over edge lengths).
// Returns the concatenated waypoint polyline ({x, z} list, correctly
// oriented, deduped at the joins), [] when from === to, or null when no
// route exists. Passing `sector` restricts travel to that district's edges
// (the ridge road carries sector "ridge", so district-bound walkers can
// never route across).
export function routeOnGraph(graph, fromId, toId, { sector = null } = {}) {
  if (!graph || fromId == null || toId == null) return null;
  if (fromId === toId) return [];
  const edgesById = new Map(graph.edges.map((e) => [e.id, e]));
  const lengthOf = (e) => {
    if (Number.isFinite(e.length)) return e.length;
    let len = 0;
    for (let i = 1; i < e.points.length; i++) {
      len += Math.hypot(e.points[i].x - e.points[i - 1].x, e.points[i].z - e.points[i - 1].z);
    }
    return len;
  };
  const dist = new Map([[fromId, 0]]);
  const prev = new Map(); // nodeId -> { from, edgeId }
  const visited = new Set();
  for (;;) {
    let cur = null;
    let best = Infinity;
    for (const [id, d] of dist) {
      if (!visited.has(id) && d < best) {
        best = d;
        cur = id;
      }
    }
    if (cur == null) return null; // exhausted: unreachable
    if (cur === toId) break;
    visited.add(cur);
    for (const link of graph.adjacency[cur] ?? []) {
      const e = edgesById.get(link.edgeId);
      if (!e) continue;
      if (sector != null && e.sector !== sector) continue;
      const nd = best + lengthOf(e);
      if (nd < (dist.get(link.to) ?? Infinity)) {
        dist.set(link.to, nd);
        prev.set(link.to, { from: cur, edgeId: link.edgeId });
      }
    }
  }
  const hops = [];
  for (let id = toId; id !== fromId; ) {
    const p = prev.get(id);
    hops.unshift(p);
    id = p.from;
  }
  const out = [];
  let at = fromId;
  for (const hop of hops) {
    const e = edgesById.get(hop.edgeId);
    let pts = e.points;
    if (e.a !== at) pts = [...pts].reverse();
    for (const p of pts) {
      const last = out[out.length - 1];
      if (!last || Math.hypot(last.x - p.x, last.z - p.z) > 1e-6) out.push({ x: p.x, z: p.z });
    }
    at = e.a === at ? e.b : e.a;
  }
  return out;
}

// Bend a waypoint polyline around a hard circle (the plaza well, the night
// obelisk): waypoints inside the circle are lifted radially onto its rim,
// and any segment cutting through it gets a detour waypoint at the closest
// approach, pushed just outside the radius. Routes THROUGH a hub node jump
// rim-to-rim straight across the disc, so without this walkers would march
// into the centerpiece and wedge. Pure; tested.
export function routeClearOf(points = [], center, radius) {
  if (!center || !(radius > 0)) return points.map((p) => ({ x: p.x, z: p.z }));
  const lift = (p) => {
    const dx = p.x - center.x;
    const dz = p.z - center.z;
    const d = Math.hypot(dx, dz);
    if (d >= radius) return { x: p.x, z: p.z };
    if (d < 1e-6) return { x: center.x + radius, z: center.z };
    const s = radius / d;
    return { x: center.x + dx * s, z: center.z + dz * s };
  };
  const out = [];
  for (const point of points) {
    const p = lift(point);
    if (out.length) {
      const a = out[out.length - 1];
      const abx = p.x - a.x;
      const abz = p.z - a.z;
      const q = abx * abx + abz * abz;
      if (q > 1e-9) {
        const t = ((center.x - a.x) * abx + (center.z - a.z) * abz) / q;
        if (t > 0 && t < 1) {
          const cx = a.x + abx * t;
          const cz = a.z + abz * t;
          const d = Math.hypot(cx - center.x, cz - center.z);
          if (d < radius) {
            let dirx;
            let dirz;
            if (d < 1e-6) {
              // Dead through the middle: step aside perpendicular to travel.
              const len = Math.sqrt(q);
              dirx = -abz / len;
              dirz = abx / len;
            } else {
              dirx = (cx - center.x) / d;
              dirz = (cz - center.z) / d;
            }
            out.push({ x: center.x + dirx * radius * 1.05, z: center.z + dirz * radius * 1.05 });
          }
        }
      }
    }
    out.push(p);
  }
  return out;
}

// Route planner for a wandering walker (its `sampleRoute`): from the nearest
// graph node, pick a reachable destination in the SAME district (the keeper's
// own garden, the plaza/night hub, or a random junction), route along the
// edges, and, for garden trips, wander a stretch of the garden loop. Pure
// given the world; randomness comes from the walker's own seeded `random`.
export function makeGraphWanderPlanner(world, { sector, plotId = null } = {}) {
  const graph = world.graph;
  const hubId = sector === "night" ? "hub" : "plaza";
  const junctions = (graph?.nodes ?? []).filter((n) => n.sector === sector && n.kind === "junction");
  const plot = (world.plots ?? []).find((p) => p.id === plotId) ?? null;
  const centerpieceR =
    (world.centerpieceR ?? WORLD_DEFAULTS.centerpieceR)[sector === "night" ? "night" : "day"];
  const clear = centerpieceR + (world.centerpieceClearance ?? WORLD_DEFAULTS.centerpieceClearance);
  return (random, pos) => {
    const from = nearestNode(graph, pos.x, pos.z, { sector });
    if (!from) return [];
    const roll = random();
    let destId = null;
    const tail = [];
    let hubTrip = false;
    if (plot && roll < 0.34) {
      // Home: walk to the plot's gate, then idle along the garden loop.
      destId = "plot:" + plot.id;
      const loop = plot.garden?.loop ?? [];
      const take = Math.min(Math.max(0, loop.length - 1), 3 + Math.floor(random() * 6));
      for (let i = 1; i <= take; i++) tail.push({ x: loop[i].x, z: loop[i].z });
    } else if (roll < 0.56) {
      // The main node: plaza (day) or the night hub, then a point on the disc.
      destId = hubId;
      hubTrip = true;
    } else if (junctions.length) {
      const cands = junctions.filter((j) => j.id !== from.id);
      destId = (cands[Math.floor(random() * cands.length)] ?? junctions[0]).id;
    }
    const route =
      destId && destId !== from.id ? (routeOnGraph(graph, from.id, destId, { sector }) ?? []) : [];
    if (hubTrip) {
      // A stroll point on the disc, with hard routing clearance around the
      // centerpiece (the well / obelisk): the point keeps `clear` distance
      // from the center AND stays on the entry side (within ~63 degrees of
      // where the walker steps onto the disc), so the chord from the rim to
      // the point can never cross the centerpiece circle.
      const hub = sector === "night" ? world.hub : world.plaza;
      const entry = route.length ? route[route.length - 1] : pos;
      const entryA = Math.atan2(entry.z - hub.center.z, entry.x - hub.center.x);
      const a = entryA + (random() - 0.5) * Math.PI * 0.7;
      const maxR = hub.radius * 0.55;
      const r = clear + Math.sqrt(random()) * Math.max(0.3, maxR - clear);
      tail.push({ x: hub.center.x + Math.cos(a) * r, z: hub.center.z + Math.sin(a) * r });
    }
    // Bend the whole plan around the centerpiece: routes THROUGH the hub
    // node cross the disc rim-to-rim, straight over the well otherwise.
    const hubCenter = (sector === "night" ? world.hub : world.plaza).center;
    if (!destId || destId === from.id) return routeClearOf(tail, hubCenter, clear);
    return routeClearOf([...route, ...tail], hubCenter, clear);
  };
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

export const WORLD_DEFAULTS = {
  size: 170, // square footprint the heightfield mesh should cover
  waterLevel: 0,
  seaFloor: -3,
  plateau: 0.7, // base land height above water before hills
  hillAmp: 1.7,
  ridgeAmp: 1.5,
  neckRadius: 8, // half-width of the land bridge between the districts
  day: { center: { x: 14, z: 10 }, radius: 26 },
  night: { center: { x: -32, z: -28 }, radius: 17 },
  plazaRadius: 4.6,
  hubRadius: 3.4,
  plotRadius: 2.6, // flattened ground under each plot
  dayPlots: 16, // pre-planned plot capacity, day village
  nightPlots: 8, // pre-planned plot capacity, night quarter
  streetStep: 1.7, // waypoint spacing along streets
  // Street width tiers (world units): winding sandy lanes, wider mains.
  streetWidths: { ridge: 2.2, avenue: 1.9, lane: 1.5, spur: 1.05, garden: 0.6 },
  // Irregular coastline: per-lobe radius modulation + domain warp. The core
  // fraction is the guaranteed-solid disc under each district (bays can
  // never cut inside it, so plots and streets always sit on land).
  coast: { warpAmp: 5.5, warpFreq: 0.045, lobeAmp: 0.34, coreFrac: 0.93 },
  // Hard obstacle radius of each hub's centerpiece (the plaza well, the
  // night obelisk). Walkers steer out of these circles and the wander
  // planner keeps its hub-disc targets clear of them (plus a margin), so
  // nobody ever wedges against the well.
  centerpieceR: { day: 1.15, night: 0.85 },
  centerpieceClearance: 0.45, // extra routing margin around the centerpiece
  propCount: 64,
  propKinds: ["rock", "flower", "bush", "stump", "flower"],
  nightPropKinds: ["rock", "crystal", "stump", "wisp"],
  treeCount: 190, // instanced vegetation layer (groves + singles)
};

// Camera limits for the bigger island. config.js owns the base camera
// config (off-limits here); the overworld scene merges these on top when it
// creates its own rig.
export const CAMERA_OVERRIDES = {
  maxDistance: 95,
  minDistance: 4,
};

// ---------------------------------------------------------------------------
// The plot grid (fixed geography, independent of the keepers)
// ---------------------------------------------------------------------------

// Pre-planned plot sites: 16 in the day village on two gentle rings around
// the plaza, 8 in the night quarter around its hub. Each ring leaves a clear
// wedge where the ridge road exits, and every plot faces its hub.
// Deterministic; keepers play no part here. -> [{id, sector, x, z, angle}]
export function planPlots(options = {}) {
  const opts = { ...WORLD_DEFAULTS, ...options };
  const day = opts.day;
  const night = opts.night;
  const ridgeOut = Math.atan2(night.center.z - day.center.z, night.center.x - day.center.x);
  const ridgeIn = Math.atan2(day.center.z - night.center.z, day.center.x - night.center.x);

  const inner = Math.max(2, Math.round(opts.dayPlots * 0.375)); // 6 of 16
  const rings = [
    { sector: "day", count: inner, radius: day.radius * 0.42, gapAt: ridgeOut, gapHalf: 0.52, seed: "plots:day:inner" },
    { sector: "day", count: opts.dayPlots - inner, radius: day.radius * 0.72, gapAt: ridgeOut, gapHalf: 0.36, seed: "plots:day:outer" },
    { sector: "night", count: opts.nightPlots, radius: night.radius * 0.62, gapAt: ridgeIn, gapHalf: 0.46, seed: "plots:night" },
  ];

  const plots = [];
  const counters = { day: 0, night: 0 };
  for (const ring of rings) {
    const rng = mulberry32(hashString(ring.seed));
    const center = ring.sector === "day" ? day.center : night.center;
    const hub = center; // hubs sit at the sector centers
    const span = Math.PI * 2 - ring.gapHalf * 2;
    for (let i = 0; i < ring.count; i++) {
      const t = (i + 0.5) / ring.count;
      const jitterA = (rng() - 0.5) * (span / ring.count) * 0.4;
      const angle = ring.gapAt + ring.gapHalf + span * t + jitterA;
      const r = ring.radius * (1 + (rng() - 0.5) * 0.09);
      const x = center.x + Math.cos(angle) * r;
      const z = center.z + Math.sin(angle) * r;
      plots.push({
        id: `${ring.sector}-${counters[ring.sector]++}`,
        sector: ring.sector,
        x,
        z,
        angle: Math.atan2(hub.z - z, hub.x - x), // face the hub
      });
    }
  }
  return plots;
}

// Assign keepers to plots deterministically and stably. Keepers are processed
// in arrival order (created_at, which every real keeper carries; keepers
// without one fall back to stable hash order), and each probes the plots of
// its sector starting at its own hash-preferred index; the first free plot
// wins. Arrival ordering makes first-fit add-stable: a new keeper is always
// processed after everyone already placed, so adding her can never move
// anyone; removing an keeper simply frees her plot. Keepers beyond plot
// capacity land in `unplaced` (sorted). Pure; tested.
export function assignPlots(keepers = [], plots = planPlots()) {
  const pools = { day: plots.filter((p) => p.sector === "day"), night: plots.filter((p) => p.sector === "night") };
  const order = [...keepers].sort((a, b) => {
    const ca = String(a.created_at ?? "");
    const cb = String(b.created_at ?? "");
    if (ca !== cb) return ca < cb ? -1 : 1;
    const ha = hashString(String(a.id));
    const hb = hashString(String(b.id));
    if (ha !== hb) return ha - hb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const used = new Set();
  const assigned = new Map(); // keeperId -> plot
  const unplaced = [];
  for (const keeper of order) {
    const pool = pools[keeper.kind === "unconscious" ? "night" : "day"];
    if (!pool.length) {
      unplaced.push(keeper.id);
      continue;
    }
    const start = hashString("plot:" + keeper.id) % pool.length;
    let got = null;
    for (let k = 0; k < pool.length && !got; k++) {
      const plot = pool[(start + k) % pool.length];
      if (!used.has(plot.id)) got = plot;
    }
    if (got) {
      used.add(got.id);
      assigned.set(keeper.id, got);
    } else {
      unplaced.push(keeper.id);
    }
  }
  unplaced.sort();
  return { assigned, unplaced };
}

// ---------------------------------------------------------------------------
// Street plumbing
// ---------------------------------------------------------------------------

// A curved, jittered polyline between two points: two seeded sine harmonics
// (endpoints exact) so lanes wander like hand-laid dirt roads, never rulers.
function streetPath(from, to, seed, step, wiggle = 1) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dz) || 1e-6;
  const nx = -dz / len;
  const nz = dx / len;
  const rng = mulberry32(seed >>> 0);
  const bow = (rng() - 0.5) * Math.min(3.2, len * 0.3) * wiggle;
  const bow2 = (rng() - 0.5) * Math.min(1.7, len * 0.16) * wiggle;
  const phase = rng() * Math.PI * 2;
  const n = Math.max(2, Math.round(len / step));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const env = Math.sin(Math.PI * t);
    const arc = env * bow + Math.sin(Math.PI * 2 * t + phase) * env * bow2;
    pts.push({ x: from.x + dx * t + nx * arc, z: from.z + dz * t + nz * arc, y: 0 });
  }
  return pts;
}

function smoothLineHeights(pts, passes = 2) {
  for (let p = 0; p < passes; p++) {
    for (let i = 1; i < pts.length - 1; i++) {
      pts[i].y = (pts[i - 1].y + pts[i].y * 2 + pts[i + 1].y) / 4;
    }
  }
}

// Uniform-grid index over street segments so heightAt/streetWeightAt stay
// cheap on the big island (the terrain mesh samples them ~85k times).
function buildSegIndex(segs, cell = 6, pad = 3.2) {
  const map = new Map();
  segs.forEach((seg, idx) => {
    const minX = Math.min(seg.a.x, seg.b.x) - pad;
    const maxX = Math.max(seg.a.x, seg.b.x) + pad;
    const minZ = Math.min(seg.a.z, seg.b.z) - pad;
    const maxZ = Math.max(seg.a.z, seg.b.z) + pad;
    for (let i = Math.floor(minX / cell); i <= Math.floor(maxX / cell); i++) {
      for (let j = Math.floor(minZ / cell); j <= Math.floor(maxZ / cell); j++) {
        const k = i + ":" + j;
        let bucket = map.get(k);
        if (!bucket) {
          bucket = [];
          map.set(k, bucket);
        }
        bucket.push(idx);
      }
    }
  });
  const EMPTY = [];
  return (x, z) => map.get(Math.floor(x / cell) + ":" + Math.floor(z / cell)) ?? EMPTY;
}

// ---------------------------------------------------------------------------
// layoutWorld
// ---------------------------------------------------------------------------

// layoutWorld(keepers, opts) -> {
//   plots: [{ id, sector, x, z, y, angle, plotRadius, occupied: keeperId|null,
//             door: {x,z,y},
//             garden: { gate:{x,z}, loop:[{x,z,y},...], props:[...] } }],
//   unplaced: [keeperId, ...] (keepers beyond plot capacity),
//   homes: { [keeperId]: { x, z, y, angle, sector, plotId,
//                        door: {x,z,y}, spawn: {x,z}, plotRadius } },
//   streets: [{ id, sector, kind: "spur"|"avenue"|"lane"|"ridge", width,
//               plotId?, ends: {head, tail} (node kinds at each terminal),
//               points: [{x,z,y}, ...] }],
//   graph: { nodes: [{id, kind: "plaza"|"hub"|"junction"|"plot", sector,
//                     x, z}],
//            edges: [{id, a, b, kind, sector, width, length, points}],
//            adjacency: { [nodeId]: [{edgeId, to}] } },
//   routeToDoorFrom(from, plotId) -> [{x,z}, ...] graph route to the door,
//   props: [{ kind, x, z, y, scale, rotation, sector }],
//   trees: [{ kind: "round"|"pine"|"tall"|"bush", x, z, y, scale, rotation,
//             sector, night }],
//   sectors: { day: {center,radius,hub,hubRadius}, night: {...} },
//   plaza: {center,radius}, hub: {center,radius},
//   heightAt(x,z), normalAt(x,z), nightMaskAt(x,z),
//   streetWeightAt(x,z), hubWeightAt(x,z), waterLevel, size,
// }
// Geography (plots, streets, terrain, props, trees) is FIXED: only plot
// occupancy (homes / plots[].occupied / unplaced) depends on the keepers.
export function layoutWorld(keepers = [], options = {}) {
  const opts = { ...WORLD_DEFAULTS, ...options };

  const day = {
    center: { ...opts.day.center },
    radius: opts.day.radius,
    hub: { ...opts.day.center },
    hubRadius: opts.plazaRadius,
  };
  const night = {
    center: { ...opts.night.center },
    radius: opts.night.radius,
    hub: { ...opts.night.center },
    hubRadius: opts.hubRadius,
  };
  const sectors = { day, night };

  // --- base terrain field (coast + hills + ridge, before plots/streets) ---
  const hills = makeFbm2D(hashString("terrain:hills"), 3);
  const detail = makeNoise2D(hashString("terrain:detail"));
  const beachiness = makeNoise2D(hashString("terrain:beach"));
  const axisA = day.center;
  const axisB = night.center;
  const axisLen2 =
    (axisB.x - axisA.x) * (axisB.x - axisA.x) + (axisB.z - axisA.z) * (axisB.z - axisA.z);

  // Irregular coastline: the two lobes get an angular radius modulation
  // (periodic noise sampled on a circle: bays and headlands per direction)
  // and the whole field is domain-warped (small-scale coves and spits). A
  // "core" disc per lobe plus a core neck corridor is smax'd back in so the
  // coast can never cut under the plot rings or the ridge road.
  const coast = opts.coast;
  const warpNX = makeFbm2D(hashString("coast:warpx"), 3);
  const warpNZ = makeFbm2D(hashString("coast:warpz"), 3);
  const lobeNDay = makeNoise2D(hashString("coast:day"));
  const lobeNNight = makeNoise2D(hashString("coast:night"));
  const neckN = makeNoise2D(hashString("coast:neck"));

  function lobeRadiusMod(noiseFn, angle, amp) {
    // Periodic in the angle by construction (noise sampled on a circle).
    // Biased slightly outward so headlands outgrow what the bays give back
    // (the playable landmass never shrinks below the old two-circle area).
    const nx = Math.cos(angle);
    const nz = Math.sin(angle);
    const n1 = noiseFn(nx * 1.6 + 7.3, nz * 1.6 - 2.9);
    const n2 = noiseFn(nx * 3.4 - 4.1, nz * 3.4 + 6.2);
    return 1.09 + (n1 - 0.5) * amp * 2.4 + (n2 - 0.5) * amp * 0.9;
  }

  function coverageAt(x, z) {
    const f = coast.warpFreq;
    const wx = x + (warpNX(x * f, z * f) - 0.5) * coast.warpAmp;
    const wz = z + (warpNZ(x * f + 41, z * f - 17) - 0.5) * coast.warpAmp;
    const aDay = Math.atan2(wz - day.center.z, wx - day.center.x);
    const rDay = day.radius * lobeRadiusMod(lobeNDay, aDay, coast.lobeAmp);
    const cDay = 1 - Math.hypot(wx - day.center.x, wz - day.center.z) / rDay;
    const aNight = Math.atan2(wz - night.center.z, wx - night.center.x);
    const rNight = night.radius * lobeRadiusMod(lobeNNight, aNight, coast.lobeAmp * 1.15);
    const cNight = 1 - Math.hypot(wx - night.center.x, wz - night.center.z) / rNight;
    // The natural neck: width breathes along its length.
    const t = Math.min(1, Math.max(0, ((wx - axisA.x) * (axisB.x - axisA.x) + (wz - axisA.z) * (axisB.z - axisA.z)) / axisLen2));
    const neckR = opts.neckRadius * (0.8 + 0.5 * neckN(t * 3.1 + 11, 0.5));
    const cNeck = 1 - segDist(wx, wz, axisA, axisB) / neckR;
    const irregular = smax(smax(cDay, cNight, 0.25), cNeck, 0.25);
    // The guaranteed core (unwarped): plots and the ridge road stay dry.
    const core = Math.max(
      1 - Math.hypot(x - day.center.x, z - day.center.z) / (day.radius * coast.coreFrac),
      1 - Math.hypot(x - night.center.x, z - night.center.z) / (night.radius * coast.coreFrac),
      1 - segDist(x, z, axisA, axisB) / (opts.neckRadius * 0.85),
    );
    return smax(irregular, core, 0.2);
  }

  // 0 in the day village, 1 in the unconscious quarter, smooth across the
  // ridge (a wide band so the camera-driven lighting blend never pops).
  function nightMaskAt(x, z) {
    const dd = Math.hypot(x - day.center.x, z - day.center.z) / day.radius;
    const nd = Math.hypot(x - night.center.x, z - night.center.z) / night.radius;
    return smoothstep(-0.45, 0.45, dd - nd);
  }

  function sectorNameAt(x, z) {
    return nightMaskAt(x, z) >= 0.5 ? "night" : "day";
  }

  function baseHeightAt(x, z) {
    const c = coverageAt(x, z);
    const land = smoothstep(-0.18, 0.26, c); // wide falloff: room for beaches
    let h = opts.seaFloor + (opts.plateau - opts.seaFloor) * land;
    if (land > 0) {
      h += land * (opts.hillAmp * hills(x * 0.05, z * 0.05) + 0.4 * (detail(x * 0.22, z * 0.22) - 0.5));
      // The ridge separating the two districts.
      const t = ((x - axisA.x) * (axisB.x - axisA.x) + (z - axisA.z) * (axisB.z - axisA.z)) / axisLen2;
      const bell = smoothstep(0.2, 0.42, t) * (1 - smoothstep(0.58, 0.8, t));
      const near = 1 - smoothstep(3, opts.neckRadius + 3, segDist(x, z, axisA, axisB));
      h += opts.ridgeAmp * bell * near * land;
      // The night quarter broods a little lower.
      h -= 0.3 * nightMaskAt(x, z) * land;
    }
    // Beach shelves: inside a horizontal band around the waterline the
    // terrain blends toward a gently tilted sand shelf, so the coast reads
    // grass -> sand -> shallow -> deep like the reference. A bimodal
    // low-frequency noise decides which stretches of coast are decisively
    // beach and which stay rocky little cliffs.
    const bump = smoothstep(-0.12, 0.0, c) * (1 - smoothstep(0.18, 0.3, c));
    if (bump > 0) {
      const beach = 0.92 * smoothstep(0.42, 0.6, beachiness(x * 0.035 + 3, z * 0.035 - 8));
      if (beach > 0) {
        const shelf = opts.waterLevel - 0.45 + 0.9 * smoothstep(-0.1, 0.32, c);
        h += (shelf - h) * bump * beach;
      }
    }
    // A final touch of waterline softening everywhere (rocky coasts still
    // meet the sea without a razor edge).
    return shoreProfile(h, opts.waterLevel, { strength: 0.4 });
  }

  // --- the fixed plot grid + occupancy ---
  const plotSites = planPlots(opts);

  // Junction nodes: seeded, jittered across each district. The street graph
  // hangs off these; plots attach to their nearest junction, so houses sit
  // at varied angles instead of all staring at the hub.
  const ridgeOutA = Math.atan2(night.center.z - day.center.z, night.center.x - day.center.x);
  const ridgeInA = Math.atan2(day.center.z - night.center.z, day.center.x - night.center.x);
  const junctionNodes = (() => {
    const rng = mulberry32(hashString("graph:junctions"));
    const defs = [
      { sector: "day", ring: "inner", count: 3, rlo: 0.3, rhi: 0.4, gapAt: ridgeOutA, gapHalf: 0.5 },
      { sector: "day", ring: "outer", count: 5, rlo: 0.54, rhi: 0.66, gapAt: ridgeOutA, gapHalf: 0.42 },
      { sector: "night", ring: "outer", count: 3, rlo: 0.46, rhi: 0.6, gapAt: ridgeInA, gapHalf: 0.55 },
    ];
    const out = [];
    const counters = { day: 0, night: 0 };
    for (const def of defs) {
      const sec = sectors[def.sector];
      const span = Math.PI * 2 - def.gapHalf * 2;
      for (let i = 0; i < def.count; i++) {
        const t = (i + 0.5) / def.count;
        const a = def.gapAt + def.gapHalf + span * t + (rng() - 0.5) * (span / def.count) * 0.55;
        const r = sec.radius * (def.rlo + rng() * (def.rhi - def.rlo));
        out.push({
          id: `j:${def.sector}-${counters[def.sector]++}`,
          kind: "junction",
          sector: def.sector,
          ring: def.ring,
          x: sec.center.x + Math.cos(a) * r,
          z: sec.center.z + Math.sin(a) * r,
        });
      }
    }
    return out;
  })();
  const nearestJunctionTo = (x, z, sectorName) => {
    let best = null;
    let bd = Infinity;
    for (const j of junctionNodes) {
      if (j.sector !== sectorName) continue;
      const d = Math.hypot(j.x - x, j.z - z);
      if (d < bd) {
        bd = d;
        best = j;
      }
    }
    return best;
  };

  // Doors face the spur: each plot turns toward its nearest junction, with a
  // seeded jitter so the village never lines up like soldiers.
  for (const p of plotSites) {
    const jn = nearestJunctionTo(p.x, p.z, p.sector);
    if (!jn) continue;
    const rngA = mulberry32(hashString("plotangle:" + p.id));
    p.angle = Math.atan2(jn.z - p.z, jn.x - p.x) + (rngA() - 0.5) * 0.7;
  }

  const { assigned, unplaced } = assignPlots(keepers, plotSites);
  const occupiedBy = new Map(); // plotId -> keeperId
  for (const [keeperId, plot] of assigned) occupiedBy.set(plot.id, keeperId);

  // --- flattened ground plots: plaza, night hub, every plot site ---
  const flat = [
    { x: day.hub.x, z: day.hub.z, radius: opts.plazaRadius * 1.25, y: 0 },
    { x: night.hub.x, z: night.hub.z, radius: opts.hubRadius * 1.25, y: 0 },
  ];
  for (const p of plotSites) flat.push({ x: p.x, z: p.z, radius: opts.plotRadius, y: 0, plotId: p.id });
  for (const p of flat) p.y = Math.max(opts.waterLevel + 0.55, baseHeightAt(p.x, p.z));
  const flatByPlot = new Map();
  for (const p of flat) if (p.plotId) flatByPlot.set(p.plotId, p);

  const plots = plotSites.map((p) => ({
    id: p.id,
    sector: p.sector,
    x: p.x,
    z: p.z,
    y: flatByPlot.get(p.id).y,
    angle: p.angle,
    plotRadius: opts.plotRadius,
    occupied: occupiedBy.get(p.id) ?? null,
    door: {
      x: p.x + Math.cos(p.angle) * 1.4,
      z: p.z + Math.sin(p.angle) * 1.4,
      y: flatByPlot.get(p.id).y,
    },
  }));
  const plotById = new Map(plots.map((p) => [p.id, p]));

  const homes = {};
  for (const [keeperId, site] of assigned) {
    const plot = plotById.get(site.id);
    homes[keeperId] = {
      x: plot.x,
      z: plot.z,
      y: plot.y,
      angle: plot.angle,
      sector: plot.sector,
      isle: plot.sector === "night" ? "unconscious" : "main", // legacy alias (minimap)
      plotId: plot.id,
      plotRadius: opts.plotRadius,
      door: { ...plot.door },
      spawn: { x: plot.x + Math.cos(plot.angle) * 3.0, z: plot.z + Math.sin(plot.angle) * 3.0 },
    };
  }

  function groundAt(x, z) {
    return flattenPlots(baseHeightAt(x, z), x, z, flat);
  }

  // --- the street GRAPH (fixed): plaza + hub + junction nodes + one gate
  // node per plot, edges as curved jittered polylines (loops allowed) ---
  function rimPoint(sector, toward) {
    const dx = toward.x - sector.hub.x;
    const dz = toward.z - sector.hub.z;
    const d = Math.hypot(dx, dz) || 1e-6;
    const r = sector.hubRadius * 0.85;
    return { x: sector.hub.x + (dx / d) * r, z: sector.hub.z + (dz / d) * r };
  }

  const nodes = [
    { id: "plaza", kind: "plaza", sector: "day", x: day.hub.x, z: day.hub.z },
    { id: "hub", kind: "hub", sector: "night", x: night.hub.x, z: night.hub.z },
    ...junctionNodes.map(({ ring, ...n }) => n),
  ];
  for (const plot of plots) {
    nodes.push({
      id: "plot:" + plot.id,
      kind: "plot",
      sector: plot.sector,
      plotId: plot.id,
      x: plot.x + Math.cos(plot.angle) * 2.1,
      z: plot.z + Math.sin(plot.angle) * 2.1,
    });
  }
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const edges = [];
  function addEdge(aId, bId, kind, { id = null, points = null, wiggle = 1, plotId = null, step = opts.streetStep } = {}) {
    const na = nodeById.get(aId);
    const nb = nodeById.get(bId);
    if (!na || !nb) return;
    const eid = id ?? `e:${aId}>${bId}`;
    if (edges.some((e) => e.id === eid)) return;
    const pts =
      points ?? streetPath({ x: na.x, z: na.z }, { x: nb.x, z: nb.z }, hashString("street:" + eid), step, wiggle);
    let length = 0;
    for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    edges.push({
      id: eid,
      a: aId,
      b: bId,
      kind,
      sector: kind === "ridge" ? "ridge" : na.sector,
      width: opts.streetWidths[kind] ?? opts.streetWidths.lane,
      plotId,
      length,
      points: pts,
    });
  }
  const byAngle = (list, center) =>
    [...list].sort(
      (a, b) => Math.atan2(a.z - center.z, a.x - center.x) - Math.atan2(b.z - center.z, b.x - center.x),
    );
  const linkRng = mulberry32(hashString("graph:links"));

  // Day: plaza -> inner junctions (avenues), a messy web of lanes between
  // the junction rings (loops allowed, some links seeded away).
  const dayInner = byAngle(junctionNodes.filter((j) => j.sector === "day" && j.ring === "inner"), day.center);
  const dayOuter = byAngle(junctionNodes.filter((j) => j.sector === "day" && j.ring === "outer"), day.center);
  for (const j of dayInner) {
    const rim = rimPoint(day, j);
    addEdge("plaza", j.id, "avenue", {
      points: streetPath(rim, { x: j.x, z: j.z }, hashString("street:e:plaza>" + j.id), opts.streetStep, 0.9),
    });
  }
  for (let i = 0; i < dayInner.length; i++) {
    addEdge(dayInner[i].id, dayInner[(i + 1) % dayInner.length].id, "lane");
  }
  for (const j of dayOuter) {
    const near = dayInner.reduce((acc, n) => {
      const d = Math.hypot(n.x - j.x, n.z - j.z);
      return !acc || d < acc.d ? { n, d } : acc;
    }, null);
    if (near) addEdge(near.n.id, j.id, "lane");
  }
  for (let i = 0; i < dayOuter.length; i++) {
    // Consecutive outer junctions mostly link up (loops), a few gaps stay
    // open so the network reads grown, not drafted.
    if (linkRng() < 0.72) addEdge(dayOuter[i].id, dayOuter[(i + 1) % dayOuter.length].id, "lane");
  }
  if (dayOuter.length >= 4 && linkRng() < 0.6) {
    addEdge(dayOuter[0].id, dayOuter[2].id, "lane", { wiggle: 1.3 });
  }

  // Night: hub -> junctions, junctions chained (a lopsided loop).
  const nightJ = byAngle(junctionNodes.filter((j) => j.sector === "night"), night.center);
  for (const j of nightJ) {
    const rim = rimPoint(night, j);
    addEdge("hub", j.id, "lane", {
      points: streetPath(rim, { x: j.x, z: j.z }, hashString("street:e:hub>" + j.id), opts.streetStep, 0.9),
    });
  }
  for (let i = 0; i + 1 < nightJ.length; i++) addEdge(nightJ[i].id, nightJ[i + 1].id, "lane");
  if (nightJ.length >= 3 && linkRng() < 0.6) addEdge(nightJ[nightJ.length - 1].id, nightJ[0].id, "lane");

  // Spurs: every plot's gate hangs off its nearest junction (empty plots
  // included; the network is pre-routed geography).
  for (const plot of plots) {
    const gateId = "plot:" + plot.id;
    const gate = nodeById.get(gateId);
    const jn = nearestJunctionTo(gate.x, gate.z, plot.sector);
    if (!jn) continue;
    addEdge(jn.id, gateId, "spur", { id: plot.id, plotId: plot.id, wiggle: 0.8 });
  }

  // The ridge road between the districts (sector "ridge": walkers bound to
  // a district can never route over it).
  addEdge("plaza", "hub", "ridge", {
    id: "ridge",
    points: streetPath(rimPoint(day, night.hub), rimPoint(night, day.hub), hashString("street:ridge"), opts.streetStep * 1.4, 0.6),
  });

  // Safety net: any node left unreachable from its district's main node
  // gets a direct lane (never expected, guaranteed anyway).
  const adjacency = {};
  for (const n of nodes) adjacency[n.id] = [];
  const relink = () => {
    for (const id of Object.keys(adjacency)) adjacency[id] = [];
    for (const e of edges) {
      adjacency[e.a].push({ edgeId: e.id, to: e.b });
      adjacency[e.b].push({ edgeId: e.id, to: e.a });
    }
  };
  relink();
  for (const [root, sectorName] of [["plaza", "day"], ["hub", "night"]]) {
    const seen = new Set([root]);
    const queue = [root];
    while (queue.length) {
      const cur = queue.shift();
      for (const link of adjacency[cur]) {
        if (!seen.has(link.to)) {
          seen.add(link.to);
          queue.push(link.to);
        }
      }
    }
    for (const n of nodes) {
      if (n.sector !== sectorName || seen.has(n.id)) continue;
      let best = null;
      for (const o of nodes) {
        if (!seen.has(o.id) || o.sector !== sectorName) continue;
        const d = Math.hypot(o.x - n.x, o.z - n.z);
        if (!best || d < best.d) best = { o, d };
      }
      if (best) {
        addEdge(best.o.id, n.id, "lane");
        relink();
        seen.add(n.id);
      }
    }
  }

  const graph = { nodes, edges, adjacency };

  // The streets list the render layer and minimap consume: one ribbon per
  // edge, same {id, kind, width, points} shape as ever (spurs carry plotId).
  // `ends` carries the junction hints (the node KIND each terminal lands
  // on): the render layer fades ribbon ends that collide with the plaza,
  // the hub or another lane, while plot ends (door approaches) stay solid.
  const streets = edges.map((e) => ({
    id: e.id,
    ...(e.plotId ? { plotId: e.plotId } : {}),
    sector: e.sector,
    kind: e.kind,
    width: e.width,
    ends: { head: nodeById.get(e.a)?.kind ?? null, tail: nodeById.get(e.b)?.kind ?? null },
    points: e.points,
  }));

  for (const st of streets) {
    // Streets never dip underwater, even where a bay noses at the network.
    for (const p of st.points) p.y = Math.max(groundAt(p.x, p.z), opts.waterLevel + 0.2);
    smoothLineHeights(st.points);
    // Smoothing can drift a waypoint off a plot's level; plots always win.
    for (const p of st.points) p.y = flattenPlots(p.y, p.x, p.z, flat);
  }

  const segs = [];
  for (const st of streets) {
    const halfW = st.width * 0.5;
    for (let i = 0; i + 1 < st.points.length; i++) {
      segs.push({ a: st.points[i], b: st.points[i + 1], halfW });
    }
  }
  const segsNear = buildSegIndex(segs);

  function streetSample(x, z) {
    let bestW = 0;
    let bestY = 0;
    let bestD = Infinity;
    for (const idx of segsNear(x, z)) {
      const { a, b, halfW } = segs[idx];
      const abx = b.x - a.x;
      const abz = b.z - a.z;
      const q = abx * abx + abz * abz || 1e-9;
      let t = ((x - a.x) * abx + (z - a.z) * abz) / q;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(x - (a.x + abx * t), z - (a.z + abz * t));
      const w = 1 - smoothstep(halfW, halfW + 1.6, d);
      if (w > bestW || (w === bestW && d < bestD)) {
        bestW = w;
        bestD = d;
        bestY = a.y + (b.y - a.y) * t;
      }
    }
    return { weight: bestW, y: bestY };
  }

  function streetWeightAt(x, z) {
    return streetSample(x, z).weight;
  }

  function heightAt(x, z) {
    // Streets carve into the raw terrain; plots win over both, so yards stay
    // dead level even where a street runs up to the door.
    let h = baseHeightAt(x, z);
    const s = streetSample(x, z);
    if (s.weight > 0) h += (s.y - h) * s.weight * 0.9;
    return flattenPlots(h, x, z, flat);
  }

  function normalAt(x, z, eps = 0.4) {
    const sx = heightAt(x - eps, z) - heightAt(x + eps, z);
    const sz = heightAt(x, z - eps) - heightAt(x, z + eps);
    const nx = sx / (2 * eps);
    const nz = sz / (2 * eps);
    const inv = 1 / Math.hypot(nx, 1, nz);
    return { x: nx * inv, y: inv, z: nz * inv };
  }

  function hubWeightAt(x, z) {
    // Wide feather: the cobbled discs dissolve into the meadow over ~2.6
    // units instead of a hard rim (the render layer dithers on top).
    const dDay = Math.hypot(x - day.hub.x, z - day.hub.z);
    const dNight = Math.hypot(x - night.hub.x, z - night.hub.z);
    return Math.max(
      1 - smoothstep(opts.plazaRadius, opts.plazaRadius + 2.6, dDay),
      1 - smoothstep(opts.hubRadius, opts.hubRadius + 2.6, dNight),
    );
  }

  // --- gardens (fixed geography, one per plot): a tiny dirt loop around the
  // cottage spot, attached at the spur gate, plus 2-3 seeded garden props
  // from the existing prop kinds. The render layer only draws a garden when
  // the plot is occupied; walkers idle along their own loop. ---
  for (const plot of plots) {
    const rng = mulberry32(hashString("garden:" + plot.id));
    const gate = {
      x: plot.x + Math.cos(plot.angle) * 2.1,
      z: plot.z + Math.sin(plot.angle) * 2.1,
    };
    const loop = [];
    const n = 12;
    for (let i = 0; i <= n; i++) {
      const a = plot.angle + (i / n) * Math.PI * 2;
      const r = i === 0 || i === n ? 2.1 : 1.9 + (rng() - 0.5) * 0.3;
      const x = plot.x + Math.cos(a) * r;
      const z = plot.z + Math.sin(a) * r;
      loop.push({ x, z, y: heightAt(x, z) });
    }
    const kinds = plot.sector === "night" ? ["crystal", "rock", "bush"] : ["flower", "bush", "rock"];
    const count = 2 + Math.floor(rng() * 2);
    const gardenProps = [];
    for (let i = 0; i < count; i++) {
      const a = plot.angle + 0.8 + rng() * (Math.PI * 2 - 1.6); // keep the gate clear
      const r = 2.15 + rng() * 0.3;
      const x = plot.x + Math.cos(a) * r;
      const z = plot.z + Math.sin(a) * r;
      gardenProps.push({
        kind: kinds[Math.floor(rng() * kinds.length)],
        x,
        z,
        y: heightAt(x, z),
        scale: 0.5 + rng() * 0.35,
        rotation: rng() * Math.PI * 2,
        sector: plot.sector,
      });
    }
    plot.garden = { gate, loop, props: gardenProps };
  }

  // Join-cinematic and sleep-walk routing over the same graph: nearest node
  // -> the plot's gate node along district edges, then the doorstep. The
  // route is bent around the district hub's centerpiece (routeClearOf): a
  // route through the hub node crosses the disc, and these are GOAL walks
  // the walkers never abandon, so they must never wedge on the well.
  function routeToDoorFrom(from, targetPlotId) {
    const plot = plotById.get(targetPlotId);
    if (!plot) return [];
    const nodeId = "plot:" + plot.id;
    const start = nearestNode(graph, from?.x ?? plot.x, from?.z ?? plot.z, { sector: plot.sector });
    let pts = [];
    if (start && start.id !== nodeId) {
      pts = (routeOnGraph(graph, start.id, nodeId, { sector: plot.sector }) ?? []).map((p) => ({
        x: p.x,
        z: p.z,
      }));
    }
    pts.push({ x: plot.door.x, z: plot.door.z });
    const hubCenter = plot.sector === "night" ? night.hub : day.hub;
    const clear =
      opts.centerpieceR[plot.sector === "night" ? "night" : "day"] + opts.centerpieceClearance;
    return routeClearOf(pts, hubCenter, clear);
  }

  // --- props (fixed geography: seeded independently of the keepers) ---
  const rng = mulberry32(hashString("props:fixed"));
  const props = [];
  const nightShare = Math.round(opts.propCount * 0.32);
  for (let i = 0; i < opts.propCount; i++) {
    const sectorName = i < nightShare ? "night" : "day";
    const sector = sectors[sectorName];
    const kinds = sectorName === "night" ? opts.nightPropKinds : opts.propKinds;
    let placed = null;
    for (let attempt = 0; attempt < 30 && !placed; attempt++) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * sector.radius * 0.92;
      const x = sector.center.x + Math.cos(a) * r;
      const z = sector.center.z + Math.sin(a) * r;
      if (heightAt(x, z) < opts.waterLevel + 0.35) continue;
      if (normalAt(x, z).y < 0.86) continue; // keep props off steep faces (no floating bases)
      if (streetWeightAt(x, z) > 0.25) continue;
      if (hubWeightAt(x, z) > 0.1) continue;
      if (plots.some((p) => Math.hypot(p.x - x, p.z - z) < opts.plotRadius + 0.6)) continue;
      if (props.some((p) => Math.hypot(p.x - x, p.z - z) < 1.5)) continue;
      placed = { x, z };
    }
    if (!placed) continue;
    props.push({
      kind: kinds[Math.floor(rng() * kinds.length)],
      x: placed.x,
      z: placed.z,
      y: heightAt(placed.x, placed.z),
      scale: 0.7 + rng() * 0.7,
      rotation: rng() * Math.PI * 2,
      sector: sectorName,
    });
  }

  // --- trees (fixed): clustered groves + scattered singles, 4 species,
  // rendered instanced. Groves mostly keep one species (diorama look). ---
  const treeRng = mulberry32(hashString("trees:fixed"));
  const trees = [];
  const SPECIES = ["round", "pine", "tall", "bush"];
  const treeOk = (x, z) => {
    if (heightAt(x, z) < opts.waterLevel + 0.4) return false;
    if (normalAt(x, z).y < 0.8) return false;
    // Trees may line the lanes (diorama look) but never stand on the roadbed.
    if (streetWeightAt(x, z) > 0.55) return false;
    if (hubWeightAt(x, z) > 0.05) return false;
    if (plots.some((p) => Math.hypot(p.x - x, p.z - z) < opts.plotRadius + 1.2)) return false;
    if (trees.some((t) => Math.hypot(t.x - x, t.z - z) < 0.95)) return false;
    return true;
  };
  const pushTree = (x, z, kind, sectorName) => {
    trees.push({
      kind,
      x,
      z,
      y: heightAt(x, z),
      scale: 0.55 + treeRng() * 0.9,
      rotation: treeRng() * Math.PI * 2,
      sector: sectorName,
      night: nightMaskAt(x, z),
    });
  };
  const groveShare = Math.round(opts.treeCount * 0.7);
  const groveCount = Math.max(4, Math.round(opts.treeCount / 16));
  for (let g = 0; g < groveCount; g++) {
    const sectorName = g % 3 === 2 ? "night" : "day";
    const sector = sectors[sectorName];
    const ga = treeRng() * Math.PI * 2;
    const gr = (0.3 + treeRng() * 0.62) * sector.radius;
    const gx = sector.center.x + Math.cos(ga) * gr;
    const gz = sector.center.z + Math.sin(ga) * gr;
    const species = SPECIES[Math.floor(treeRng() * 3)]; // groves: round/pine/tall
    const n = 4 + Math.floor(treeRng() * 7);
    for (let i = 0; i < n && trees.length < groveShare; i++) {
      let done = false;
      for (let attempt = 0; attempt < 8 && !done; attempt++) {
        const a = treeRng() * Math.PI * 2;
        const r = 1.1 + Math.sqrt(treeRng()) * 4.6;
        const x = gx + Math.cos(a) * r;
        const z = gz + Math.sin(a) * r;
        if (!treeOk(x, z)) continue;
        const kind = treeRng() < 0.82 ? species : SPECIES[Math.floor(treeRng() * SPECIES.length)];
        pushTree(x, z, kind, sectorNameAt(x, z));
        done = true;
      }
    }
  }
  let treeAttempts = 0;
  const maxTreeAttempts = opts.treeCount * 30;
  while (trees.length < opts.treeCount && treeAttempts < maxTreeAttempts) {
    treeAttempts++;
    const sector = treeRng() < 0.32 ? night : day;
    const a = treeRng() * Math.PI * 2;
    const r = Math.sqrt(treeRng()) * sector.radius * 1.02;
    const x = sector.center.x + Math.cos(a) * r;
    const z = sector.center.z + Math.sin(a) * r;
    if (!treeOk(x, z)) continue;
    pushTree(x, z, SPECIES[Math.floor(treeRng() * SPECIES.length)], sectorNameAt(x, z));
  }

  // --- solid obstacles (occupied houses, hub centerpieces, chunky props,
  // tree trunks): walkers steer out of these circles ---
  const SOLID_PROP_RADII = { rock: 0.5, stump: 0.32, crystal: 0.4, bush: 0.38 };
  const TREE_RADII = { round: 0.34, pine: 0.3, tall: 0.3 }; // bushes are soft
  const obstacles = [
    { x: day.hub.x, z: day.hub.z, r: opts.centerpieceR.day },
    { x: night.hub.x, z: night.hub.z, r: opts.centerpieceR.night },
  ];
  for (const plot of plots) {
    // Occupied plots hold a solid cottage; empty ones only a low stone
    // circle keepers may wander across (keeps empty plots "discoverable").
    if (plot.occupied) obstacles.push({ x: plot.x, z: plot.z, r: 1.1 });
  }
  for (const p of props) {
    const r = SOLID_PROP_RADII[p.kind];
    if (r) obstacles.push({ x: p.x, z: p.z, r: r * p.scale + 0.18 });
  }
  for (const t of trees) {
    const r = TREE_RADII[t.kind];
    if (r) obstacles.push({ x: t.x, z: t.z, r: r * t.scale + 0.14 });
  }

  return {
    plots,
    unplaced,
    homes,
    streets,
    graph,
    routeToDoorFrom,
    props,
    trees,
    sectors,
    obstacles,
    // Legacy alias kept for the minimap: the "isles" are now the two
    // districts of the single landmass.
    isles: {
      main: { center: { ...day.center }, radius: day.radius },
      unconscious: { center: { ...night.center }, radius: night.radius },
    },
    plaza: { center: { ...day.hub }, radius: opts.plazaRadius },
    hub: { center: { ...night.hub }, radius: opts.hubRadius },
    centerpieceR: { ...opts.centerpieceR },
    centerpieceClearance: opts.centerpieceClearance,
    waterLevel: opts.waterLevel,
    size: opts.size,
    heightAt,
    normalAt,
    nightMaskAt,
    sectorNameAt,
    streetWeightAt,
    hubWeightAt,
  };
}

// Sample a wander point inside a sector, biased toward the middle, kept on
// land (world.heightAt above the waterline) and out of solid obstacles.
// Suitable as a walker's sampleTarget.
export function makeWanderSampler(sector, world = null, margin = 2, obstacles = null) {
  const { center, radius } = sector;
  const solids = obstacles ?? world?.obstacles ?? [];
  return (random) => {
    for (let i = 0; i < 18; i++) {
      const angle = random() * Math.PI * 2;
      const r = Math.sqrt(random()) * Math.max(1, radius - margin);
      const x = center.x + Math.cos(angle) * r;
      const z = center.z + Math.sin(angle) * r;
      if (world && world.heightAt(x, z) <= (world.waterLevel ?? 0) + 0.3) continue;
      if (solids.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + 0.35)) continue;
      return { x, z };
    }
    return { x: center.x, z: center.z };
  };
}
