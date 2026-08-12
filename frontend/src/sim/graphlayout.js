// Deterministic seeded 3D force layout for the consolidation graph, plus the
// assembly timeline that drives "the movie". Pure logic: no three.js, no DOM,
// no module-level side effects.
//
//   const { positions, timeline } = computeGraphLayout(graph);
//     positions: Map(nodeId -> {x, y, z})
//     timeline:  ordered waves [{t, nodeIds: [...]}, ..., {t, edgeIds: [...]}]
//                keepers first, then each keeper's books, then entities, then edges
//                grouped by weight descending. t normalized in (0..1], last = 1.
//
// Same graph in -> identical positions and timeline out. Seeding is derived from
// node/edge content (not array identity), and per-node initial placement hashes
// the node id, so the result is stable across runs and node orderings.

import { hashString, mulberry32 } from "./rand.js";

// Stable synthetic id for an edge (the Graph shape carries none).
export function edgeId(edge, index) {
  return `e${index}:${edge.source}->${edge.target}`;
}

// --- layout ------------------------------------------------------------------

const DEFAULTS = {
  seed: 1337,
  iterations: 240,
  repulsion: 14, // pairwise push strength
  springLength: 5, // rest length for edges
  springK: 0.06,
  centering: 0.012, // mild pull of everything to the origin
  clusterGravity: 0.05, // books toward their keeper node
  anchorGravity: 0.045, // keeper nodes toward their ring anchor
  entityGravity: 0.02, // entities toward the centroid of their neighbors
  maxStep: 0.9, // displacement cap per iteration (cooled)
  bound: 40, // hard clamp on final coordinate radius
};

function byWeightDescThenId(a, b) {
  return (b.weight ?? 0) - (a.weight ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function computeGraphLayout(graph, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const nodes = (graph?.nodes ?? []).filter((n) => n && typeof n.id === "string");
  const rawEdges = (graph?.edges ?? []).filter((e) => e && e.source && e.target);

  const index = new Map(); // nodeId -> array index
  nodes.forEach((n, i) => index.set(n.id, i));

  const edges = [];
  rawEdges.forEach((e, i) => {
    const a = index.get(e.source);
    const b = index.get(e.target);
    if (a === undefined || b === undefined || a === b) return;
    edges.push({ id: edgeId(e, i), a, b, weight: e.weight ?? 1, edge: e });
  });

  const n = nodes.length;
  const positions = new Map();
  if (n === 0) return { positions, timeline: [] };

  // Content-derived seed: same graph -> same layout, regardless of call site.
  let contentSeed = cfg.seed >>> 0;
  for (const node of nodes) contentSeed = (contentSeed ^ hashString(node.id)) >>> 0;

  // Keeper nodes anchor a deterministic ring; their books start (and stay) nearby.
  const keeperNodes = nodes.filter((nd) => nd.kind === "keeper").sort((a, b) => (a.id < b.id ? -1 : 1));
  const ringRadius = Math.max(9, 5 + 3 * keeperNodes.length);
  const anchors = new Map(); // keeper_id -> {x, y, z}
  keeperNodes.forEach((nd, i) => {
    const angle = (i / Math.max(1, keeperNodes.length)) * Math.PI * 2;
    const lift = (mulberry32(hashString(nd.id) ^ contentSeed)() * 2 - 1) * 3;
    anchors.set(nd.keeper_id ?? nd.id, {
      x: Math.cos(angle) * ringRadius,
      y: lift,
      z: Math.sin(angle) * ringRadius,
    });
  });

  // Initial positions: hash the node id so placement is order-independent.
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const pz = new Float64Array(n);
  nodes.forEach((nd, i) => {
    const rand = mulberry32(hashString(nd.id) ^ contentSeed);
    const jitter = () => (rand() - 0.5) * 2;
    const home =
      nd.kind === "keeper"
        ? anchors.get(nd.keeper_id ?? nd.id)
        : nd.kind === "book" && anchors.has(nd.keeper_id)
          ? anchors.get(nd.keeper_id)
          : { x: 0, y: 0, z: 0 };
    const spread = nd.kind === "keeper" ? 0.001 : nd.kind === "book" ? 3 : 4;
    px[i] = home.x + jitter() * spread;
    py[i] = home.y + jitter() * spread;
    pz[i] = home.z + jitter() * spread;
  });

  // Adjacency for the entity centroid pull.
  const neighbors = nodes.map(() => []);
  for (const e of edges) {
    neighbors[e.a].push(e.b);
    neighbors[e.b].push(e.a);
  }

  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  const dz = new Float64Array(n);

  for (let it = 0; it < cfg.iterations; it++) {
    const cooling = 1 - it / cfg.iterations;
    dx.fill(0);
    dy.fill(0);
    dz.fill(0);

    // Pairwise repulsion (inverse square, softened).
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let vx = px[i] - px[j];
        let vy = py[i] - py[j];
        let vz = pz[i] - pz[j];
        let d2 = vx * vx + vy * vy + vz * vz;
        if (d2 < 1e-6) {
          // Deterministic tiny separation for coincident nodes.
          const r = mulberry32((hashString(nodes[i].id) ^ hashString(nodes[j].id) ^ it) >>> 0);
          vx = r() - 0.5;
          vy = r() - 0.5;
          vz = r() - 0.5;
          d2 = vx * vx + vy * vy + vz * vz;
        }
        const f = cfg.repulsion / (d2 + 0.5);
        const d = Math.sqrt(d2);
        const fx = (vx / d) * f;
        const fy = (vy / d) * f;
        const fz = (vz / d) * f;
        dx[i] += fx;
        dy[i] += fy;
        dz[i] += fz;
        dx[j] -= fx;
        dy[j] -= fy;
        dz[j] -= fz;
      }
    }

    // Springs on edges (weight tightens the link).
    for (const e of edges) {
      const vx = px[e.b] - px[e.a];
      const vy = py[e.b] - py[e.a];
      const vz = pz[e.b] - pz[e.a];
      const d = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1e-6;
      const k = cfg.springK * (1 + 0.25 * Math.min(e.weight, 6));
      const f = k * (d - cfg.springLength);
      const fx = (vx / d) * f;
      const fy = (vy / d) * f;
      const fz = (vz / d) * f;
      dx[e.a] += fx;
      dy[e.a] += fy;
      dz[e.a] += fz;
      dx[e.b] -= fx;
      dy[e.b] -= fy;
      dz[e.b] -= fz;
    }

    // Mild centering + cluster gravity.
    for (let i = 0; i < n; i++) {
      const nd = nodes[i];
      dx[i] -= px[i] * cfg.centering;
      dy[i] -= py[i] * cfg.centering;
      dz[i] -= pz[i] * cfg.centering;

      if (nd.kind === "keeper") {
        const a = anchors.get(nd.keeper_id ?? nd.id);
        if (a) {
          dx[i] += (a.x - px[i]) * cfg.anchorGravity;
          dy[i] += (a.y - py[i]) * cfg.anchorGravity;
          dz[i] += (a.z - pz[i]) * cfg.anchorGravity;
        }
      } else if (nd.kind === "book") {
        const owner = index.get(`keeper:${nd.keeper_id}`);
        const target =
          owner !== undefined
            ? { x: px[owner], y: py[owner], z: pz[owner] }
            : anchors.get(nd.keeper_id);
        if (target) {
          dx[i] += (target.x - px[i]) * cfg.clusterGravity;
          dy[i] += (target.y - py[i]) * cfg.clusterGravity;
          dz[i] += (target.z - pz[i]) * cfg.clusterGravity;
        }
      } else if (neighbors[i].length > 0) {
        // Entities drift toward the centroid of the books they bridge.
        let cx = 0;
        let cy = 0;
        let cz = 0;
        for (const j of neighbors[i]) {
          cx += px[j];
          cy += py[j];
          cz += pz[j];
        }
        const m = neighbors[i].length;
        dx[i] += (cx / m - px[i]) * cfg.entityGravity * m;
        dy[i] += (cy / m - py[i]) * cfg.entityGravity * m;
        dz[i] += (cz / m - pz[i]) * cfg.entityGravity * m;
      }
    }

    // Apply displacements, capped and cooled.
    const cap = cfg.maxStep * (0.25 + 0.75 * cooling);
    for (let i = 0; i < n; i++) {
      const len = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i] + dz[i] * dz[i]);
      if (len > 1e-9) {
        const s = Math.min(len, cap) / len;
        px[i] += dx[i] * s;
        py[i] += dy[i] * s;
        pz[i] += dz[i] * s;
      }
    }
  }

  // Recenter on the centroid and hard-clamp to the bound.
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    cx += px[i];
    cy += py[i];
    cz += pz[i];
  }
  cx /= n;
  cy /= n;
  cz /= n;
  for (let i = 0; i < n; i++) {
    let x = px[i] - cx;
    let y = py[i] - cy;
    let z = pz[i] - cz;
    if (!Number.isFinite(x)) x = 0;
    if (!Number.isFinite(y)) y = 0;
    if (!Number.isFinite(z)) z = 0;
    const r = Math.sqrt(x * x + y * y + z * z);
    if (r > cfg.bound) {
      const s = cfg.bound / r;
      x *= s;
      y *= s;
      z *= s;
    }
    positions.set(nodes[i].id, { x, y, z });
  }

  return { positions, timeline: buildTimeline(nodes, edges) };
}

// --- assembly timeline -------------------------------------------------------

function buildTimeline(nodes, edges) {
  const waves = [];

  const keepers = nodes.filter((n) => n.kind === "keeper").sort(byWeightDescThenId);
  if (keepers.length) waves.push({ nodeIds: keepers.map((n) => n.id) });

  // One book wave per keeper (in keeper wave order), then any orphaned books.
  const books = nodes.filter((n) => n.kind === "book");
  const claimed = new Set();
  for (const keeper of keepers) {
    const own = books
      .filter((b) => b.keeper_id === (keeper.keeper_id ?? keeper.id.replace(/^keeper:/, "")))
      .sort(byWeightDescThenId);
    if (own.length) {
      waves.push({ nodeIds: own.map((b) => b.id) });
      own.forEach((b) => claimed.add(b.id));
    }
  }
  const orphans = books.filter((b) => !claimed.has(b.id)).sort(byWeightDescThenId);
  if (orphans.length) waves.push({ nodeIds: orphans.map((b) => b.id) });

  const entities = nodes
    .filter((n) => n.kind !== "keeper" && n.kind !== "book")
    .sort(byWeightDescThenId);
  if (entities.length) waves.push({ nodeIds: entities.map((n) => n.id) });

  // Edges grouped by weight, heaviest first; one wave per distinct weight.
  const sortedEdges = [...edges].sort(
    (a, b) => b.weight - a.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  let bucket = null;
  for (const e of sortedEdges) {
    if (!bucket || bucket.weight !== e.weight) {
      bucket = { weight: e.weight, edgeIds: [] };
      waves.push(bucket);
    }
    bucket.edgeIds.push(e.id);
  }

  const count = waves.length;
  return waves.map((w, i) => {
    const out = { t: (i + 1) / count };
    if (w.nodeIds) out.nodeIds = w.nodeIds;
    if (w.edgeIds) out.edgeIds = w.edgeIds;
    return out;
  });
}
