import { describe, it, expect } from "vitest";
import {
  hashString,
  mulberry32,
  smoothstep,
  makeNoise2D,
  makeFbm2D,
  flattenPlots,
  shoreProfile,
  routeToDoor,
  clampToSector,
  planPlots,
  assignPlots,
  layoutWorld,
  makeWanderSampler,
  nearestNode,
  routeOnGraph,
  routeClearOf,
  makeGraphWanderPlanner,
  WORLD_DEFAULTS,
  CAMERA_OVERRIDES,
} from "../src/sim/world.js";

// Real keepers always carry created_at (library/CONTRACT.md); assignment stability
// leans on that arrival order, so the fixtures carry it too.
const keeper = (id, kind = "conscious", i = 0) => ({
  id,
  kind,
  created_at: `2026-07-01T${String(10 + i).padStart(2, "0")}:00:00Z`,
});

const MANY = [
  keeper("dreams", "conscious", 0),
  keeper("meetings", "conscious", 1),
  keeper("music", "conscious", 2),
  keeper("films", "conscious", 3),
  keeper("books", "conscious", 4),
  keeper("places", "conscious", 5),
  keeper("podcasts", "conscious", 6),
  keeper("recipes", "conscious", 7),
  keeper("people", "conscious", 8),
  keeper("ideas", "conscious", 9),
  keeper("fear-of-heights", "unconscious", 10),
  keeper("desire-to-fly", "unconscious", 11),
  keeper("obsession-mars", "unconscious", 12),
];

// Deterministic sample points spread over the landmass footprint.
function samplePoints(n = 120) {
  const rng = mulberry32(1234);
  const pts = [];
  for (let i = 0; i < n; i++) {
    pts.push({ x: (rng() - 0.5) * 140, z: (rng() - 0.5) * 140 });
  }
  return pts;
}

describe("sim/world primitives", () => {
  it("hashString is deterministic and spreads ids", () => {
    expect(hashString("dreams")).toBe(hashString("dreams"));
    expect(hashString("dreams")).not.toBe(hashString("meetings"));
    expect(hashString("a")).not.toBe(hashString("b"));
  });

  it("mulberry32 yields a reproducible [0,1) stream", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 20; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("smoothstep clamps and eases", () => {
    expect(smoothstep(0, 1, -5)).toBe(0);
    expect(smoothstep(0, 1, 5)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 9);
    expect(smoothstep(2, 4, 3)).toBeCloseTo(0.5, 9);
  });

  it("makeNoise2D is deterministic per seed, bounded, and smooth", () => {
    const n1 = makeNoise2D(7);
    const n2 = makeNoise2D(7);
    const other = makeNoise2D(8);
    let differs = false;
    const rng = mulberry32(99);
    for (let i = 0; i < 200; i++) {
      const x = (rng() - 0.5) * 100;
      const z = (rng() - 0.5) * 100;
      const v = n1(x, z);
      expect(v).toBe(n2(x, z)); // deterministic
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      if (Math.abs(v - other(x, z)) > 1e-9) differs = true;
      // continuity: a tiny step moves the value only a little
      expect(Math.abs(n1(x + 0.01, z) - v)).toBeLessThan(0.06);
      expect(Math.abs(n1(x, z + 0.01) - v)).toBeLessThan(0.06);
    }
    expect(differs).toBe(true); // the seed matters
  });

  it("makeFbm2D is deterministic and stays in [0,1]", () => {
    const f1 = makeFbm2D(11, 3);
    const f2 = makeFbm2D(11, 3);
    const rng = mulberry32(5);
    for (let i = 0; i < 100; i++) {
      const x = (rng() - 0.5) * 60;
      const z = (rng() - 0.5) * 60;
      const v = f1(x, z);
      expect(v).toBe(f2(x, z));
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("flattenPlots levels the ground inside a plot and leaves far ground alone", () => {
    const plots = [{ x: 0, z: 0, radius: 2, y: 1.5 }];
    expect(flattenPlots(0.4, 0, 0, plots)).toBeCloseTo(1.5, 9); // dead center
    expect(flattenPlots(0.4, 1.9, 0, plots)).toBeCloseTo(1.5, 6); // inside radius
    expect(flattenPlots(0.4, 50, 0, plots)).toBeCloseTo(0.4, 9); // far away
    const mid = flattenPlots(0.4, 2.9, 0, plots); // in the feather band
    expect(mid).toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(1.5);
  });

  it("shoreProfile flattens the beach band, is monotonic, and passes far heights through", () => {
    // near the waterline: slope is compressed (a beach shelf)
    const a = shoreProfile(0.0);
    const b = shoreProfile(0.3);
    expect(b - a).toBeLessThan(0.3); // flatter than the raw profile
    expect(b - a).toBeGreaterThan(0); // but still rising
    // strictly monotonic across the whole range: no terrain inversions
    let prev = shoreProfile(-3);
    for (let h = -2.95; h <= 4; h += 0.05) {
      const v = shoreProfile(h);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
    // far from the shore the profile passes through nearly unchanged
    expect(shoreProfile(3.5)).toBeCloseTo(3.5, 1);
    expect(shoreProfile(-2.8)).toBeCloseTo(-2.8, 1);
  });

  it("routeToDoor starts at the nearest waypoint and always ends at the door", () => {
    const pts = [
      { x: 0, z: 0 },
      { x: 2, z: 0 },
      { x: 4, z: 0 },
      { x: 6, z: 0 },
    ];
    const door = { x: 7, z: 1 };
    const route = routeToDoor(pts, { x: 4.2, z: 0.5 }, door);
    expect(route[0]).toEqual({ x: 4, z: 0 }); // nearest, not the start
    expect(route[route.length - 1]).toEqual({ x: 7, z: 1 });
    expect(route).toHaveLength(3);
    for (const p of route) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.z)).toBe(true);
    }
    // no street at all: still walks to the door
    expect(routeToDoor([], { x: 0, z: 0 }, door)).toEqual([{ x: 7, z: 1 }]);
  });
});

describe("sim/world plot grid (fixed geography)", () => {
  const sites = planPlots();

  it("plans 16 day plots + 8 night plots, deterministically", () => {
    expect(sites.filter((p) => p.sector === "day")).toHaveLength(16);
    expect(sites.filter((p) => p.sector === "night")).toHaveLength(8);
    expect(planPlots()).toEqual(sites);
    expect(new Set(sites.map((p) => p.id)).size).toBe(24);
  });

  it("plots ring their hubs with comfortable spacing", () => {
    for (let i = 0; i < sites.length; i++) {
      for (let j = i + 1; j < sites.length; j++) {
        if (sites[i].sector !== sites[j].sector) continue;
        const d = Math.hypot(sites[i].x - sites[j].x, sites[i].z - sites[j].z);
        expect(d).toBeGreaterThan(5); // houses never cramp
      }
    }
    for (const p of sites) {
      const sector = p.sector === "day" ? WORLD_DEFAULTS.day : WORLD_DEFAULTS.night;
      const d = Math.hypot(p.x - sector.center.x, p.z - sector.center.z);
      expect(d).toBeGreaterThan(sector.radius * 0.3);
      expect(d).toBeLessThan(sector.radius * 0.85);
      // every plot faces its hub
      const facing = Math.atan2(sector.center.z - p.z, sector.center.x - p.x);
      expect(Math.abs(p.angle - facing)).toBeLessThan(1e-9);
    }
  });

  it("geography is identical no matter which keepers exist", () => {
    const empty = layoutWorld([]);
    const full = layoutWorld(MANY);
    expect(empty.plots.map(({ occupied, ...rest }) => rest)).toEqual(
      full.plots.map(({ occupied, ...rest }) => rest),
    );
    expect(empty.streets).toEqual(full.streets);
    expect(empty.props).toEqual(full.props);
    expect(empty.trees).toEqual(full.trees);
    for (const p of samplePoints(60)) {
      expect(empty.heightAt(p.x, p.z)).toBe(full.heightAt(p.x, p.z));
    }
  });
});

describe("sim/world plot assignment (stable)", () => {
  it("adding a keeper never moves anyone already placed", () => {
    let prev = new Map();
    const seq = [];
    for (const a of MANY) {
      seq.push(a);
      const { assigned } = assignPlots(seq);
      for (const [id, plot] of prev) {
        expect(assigned.get(id).id).toBe(plot.id);
      }
      prev = new Map(assigned);
    }
  });

  it("stays add-stable through a full 16-keeper day village", () => {
    const seq = [];
    let prev = new Map();
    for (let i = 0; i < 16; i++) {
      seq.push(keeper(`topic-${i}`, "conscious", i));
      const { assigned } = assignPlots(seq);
      for (const [id, plot] of prev) expect(assigned.get(id).id).toBe(plot.id);
      prev = new Map(assigned);
    }
    expect(new Set([...prev.values()].map((p) => p.id)).size).toBe(16);
  });

  it("removing a keeper frees her plot", () => {
    const { assigned: before } = assignPlots(MANY);
    const { assigned: after } = assignPlots(MANY.filter((a) => a.id !== "music"));
    expect(after.has("music")).toBe(false);
    expect(after.size).toBe(before.size - 1);
    // no double-occupancy after the removal
    expect(new Set([...after.values()].map((p) => p.id)).size).toBe(after.size);
    // keepers created before the removed one provably keep their plots
    // (arrival-order processing: their prefix is untouched)
    const musicAt = MANY.findIndex((a) => a.id === "music");
    for (const a of MANY.slice(0, musicAt)) {
      expect(after.get(a.id).id).toBe(before.get(a.id).id);
    }
    // and a re-created keeper with the same id lands on her old plot
    const { assigned: again } = assignPlots(MANY);
    expect(again.get("music").id).toBe(before.get("music").id);
  });

  it("the 17th conscious keeper gets no plot and the layout exposes that", () => {
    const seventeen = [...Array(17)].map((_, i) => keeper(`t${i}`, "conscious", i));
    const world = layoutWorld(seventeen);
    expect(world.unplaced).toEqual(["t16"]); // newest arrival misses out
    expect(world.homes["t16"]).toBeUndefined();
    expect(Object.keys(world.homes)).toHaveLength(16);
    // same rule in the night quarter: 9th unconscious keeper is unplaced
    const nine = [...Array(9)].map((_, i) => keeper(`u${i}`, "unconscious", i));
    expect(layoutWorld(nine).unplaced).toEqual(["u8"]);
  });

  it("assignment is deterministic regardless of input order", () => {
    const { assigned: a } = assignPlots(MANY);
    const { assigned: b } = assignPlots([...MANY].reverse());
    expect([...a.entries()].map(([id, p]) => [id, p.id]).sort()).toEqual(
      [...b.entries()].map(([id, p]) => [id, p.id]).sort(),
    );
  });
});

describe("sim/world layout: two districts on one landmass", () => {
  const world = layoutWorld(MANY);

  it("layout is identical for the same keeper set regardless of order", () => {
    const w2 = layoutWorld([...MANY].reverse());
    expect(w2.homes).toEqual(world.homes);
    expect(w2.plots).toEqual(world.plots);
    expect(w2.props).toEqual(world.props);
    expect(w2.trees).toEqual(world.trees);
    expect(w2.streets).toEqual(world.streets);
    expect(w2.sectors).toEqual(world.sectors);
  });

  it("is a BIGGER island: at least 2x the old playable area", () => {
    // the old world: size 110, day radius 17, night radius 11.5
    const area = (r) => Math.PI * r * r;
    const playable = area(world.sectors.day.radius) + area(world.sectors.night.radius);
    const oldPlayable = area(17) + area(11.5);
    expect(playable).toBeGreaterThanOrEqual(oldPlayable * 2);
    expect(world.size).toBeGreaterThanOrEqual(160);
    // and the camera limits keep up (consumed by the overworld scene)
    expect(CAMERA_OVERRIDES.maxDistance).toBeGreaterThan(60);
  });

  it("has a day village and a night quarter, apart from each other", () => {
    expect(world.sectors.day).toBeTruthy();
    expect(world.sectors.night).toBeTruthy();
    const d = Math.hypot(
      world.sectors.day.center.x - world.sectors.night.center.x,
      world.sectors.day.center.z - world.sectors.night.center.z,
    );
    // districts do not overlap: separated by more than the radii sum
    expect(d).toBeGreaterThan(world.sectors.day.radius + world.sectors.night.radius);
  });

  it("assigns unconscious keepers to night plots, the rest to day plots", () => {
    for (const a of MANY) {
      expect(world.homes[a.id].sector).toBe(a.kind === "unconscious" ? "night" : "day");
    }
  });

  it("marks occupancy on the plots and none twice", () => {
    const occupied = world.plots.filter((p) => p.occupied);
    expect(occupied).toHaveLength(MANY.length);
    expect(new Set(occupied.map((p) => p.occupied)).size).toBe(MANY.length);
    for (const a of MANY) {
      const plot = world.plots.find((p) => p.occupied === a.id);
      expect(plot.id).toBe(world.homes[a.id].plotId);
      expect(plot.x).toBe(world.homes[a.id].x);
    }
    // empty plots read as unoccupied, with their geometry intact
    for (const p of world.plots.filter((pl) => !pl.occupied)) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.door.x)).toBe(true);
    }
  });

  it("homes stay inside their sector and above the waterline", () => {
    for (const home of Object.values(world.homes)) {
      const sector = world.sectors[home.sector];
      const d = Math.hypot(home.x - sector.center.x, home.z - sector.center.z);
      expect(d).toBeLessThanOrEqual(sector.radius);
      expect(home.y).toBeGreaterThan(world.waterLevel + 0.4);
      expect(world.heightAt(home.x, home.z)).toBeGreaterThan(world.waterLevel + 0.4);
    }
  });

  it("door and spawn sit in front of the house, along the plot's own angle", () => {
    for (const home of Object.values(world.homes)) {
      // door at 1.4 units out, spawn at 3.0, both on the facing ray
      expect(home.door.x).toBeCloseTo(home.x + Math.cos(home.angle) * 1.4, 6);
      expect(home.door.z).toBeCloseTo(home.z + Math.sin(home.angle) * 1.4, 6);
      expect(home.spawn.x).toBeCloseTo(home.x + Math.cos(home.angle) * 3.0, 6);
      expect(home.spawn.z).toBeCloseTo(home.z + Math.sin(home.angle) * 3.0, 6);
    }
  });

  it("houses face their spur at varied angles (not all staring at the hub)", () => {
    const deltas = world.plots.map((p) => {
      const hub = world.sectors[p.sector].hub;
      const toHub = Math.atan2(hub.z - p.z, hub.x - p.x);
      let d = p.angle - toHub;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      return Math.abs(d);
    });
    // plenty of plots point clearly away from the pure hub direction
    expect(deltas.filter((d) => d > 0.15).length).toBeGreaterThanOrEqual(world.plots.length * 0.4);
    // and the doors face the spur: the spur's last stretch approaches along
    // the facing ray (the gate sits 2.1 units out on that ray)
    for (const p of world.plots) {
      const spur = world.streets.find((s) => s.kind === "spur" && s.plotId === p.id);
      const gate = spur.points[spur.points.length - 1];
      expect(gate.x).toBeCloseTo(p.x + Math.cos(p.angle) * 2.1, 4);
      expect(gate.z).toBeCloseTo(p.z + Math.sin(p.angle) * 2.1, 4);
    }
  });

  it("flattens the ground across every plot (occupied or not)", () => {
    for (const plot of world.plots) {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const x = plot.x + Math.cos(a) * plot.plotRadius * 0.7;
        const z = plot.z + Math.sin(a) * plot.plotRadius * 0.7;
        expect(Math.abs(world.heightAt(x, z) - plot.y)).toBeLessThan(0.15);
      }
    }
  });
});

describe("sim/world heightAt + streets", () => {
  const world = layoutWorld(MANY);

  it("heightAt is deterministic across layouts of the same set", () => {
    const w2 = layoutWorld([...MANY].reverse());
    for (const p of samplePoints()) {
      expect(w2.heightAt(p.x, p.z)).toBe(world.heightAt(p.x, p.z));
    }
  });

  it("heightAt is continuous (no cliffs between close samples)", () => {
    for (const p of samplePoints()) {
      const h = world.heightAt(p.x, p.z);
      expect(Number.isFinite(h)).toBe(true);
      expect(Math.abs(world.heightAt(p.x + 0.05, p.z) - h)).toBeLessThan(0.25);
      expect(Math.abs(world.heightAt(p.x, p.z + 0.05) - h)).toBeLessThan(0.25);
    }
  });

  it("falls below the waterline away from the island and rises on it", () => {
    expect(world.heightAt(300, 300)).toBeLessThan(world.waterLevel);
    const day = world.sectors.day.center;
    expect(world.heightAt(day.x, day.z)).toBeGreaterThan(world.waterLevel);
    const night = world.sectors.night.center;
    expect(world.heightAt(night.x, night.z)).toBeGreaterThan(world.waterLevel);
  });

  it("normalAt returns a unit-ish, upward normal", () => {
    for (const p of samplePoints(40)) {
      const n = world.normalAt(p.x, p.z);
      expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 5);
      expect(n.y).toBeGreaterThan(0);
    }
  });

  it("nightMaskAt is ~1 in the night quarter, ~0 in the village", () => {
    const day = world.sectors.day.center;
    const night = world.sectors.night.center;
    expect(world.nightMaskAt(night.x, night.z)).toBeGreaterThan(0.95);
    expect(world.nightMaskAt(day.x, day.z)).toBeLessThan(0.05);
  });

  it("nightMaskAt blends continuously and monotonically along the ridge crossing", () => {
    const a = world.sectors.day.center;
    const b = world.sectors.night.center;
    let prev = world.nightMaskAt(a.x, a.z);
    for (let i = 1; i <= 500; i++) {
      const t = i / 500;
      const m = world.nightMaskAt(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(1);
      expect(Math.abs(m - prev)).toBeLessThan(0.03); // no popping between close samples
      expect(m).toBeGreaterThanOrEqual(prev - 1e-9); // day -> night, one direction
      prev = m;
    }
    expect(prev).toBeGreaterThan(0.95); // it does arrive in the night
  });

  it("sectorNameAt splits the map into the two districts", () => {
    const day = world.sectors.day.center;
    const night = world.sectors.night.center;
    expect(world.sectorNameAt(day.x, day.z)).toBe("day");
    expect(world.sectorNameAt(night.x, night.z)).toBe("night");
    for (const home of Object.values(world.homes)) {
      expect(world.sectorNameAt(home.x, home.z)).toBe(home.sector);
    }
  });

  it("clampToSector keeps outside points on the rim and interior points untouched", () => {
    const sector = { center: { x: 4, z: -2 }, radius: 10 };
    expect(clampToSector(sector, { x: 5, z: -1 }, 1)).toEqual({ x: 5, z: -1 });
    const far = clampToSector(sector, { x: 50, z: -2 }, 1);
    expect(Math.hypot(far.x - 4, far.z + 2)).toBeCloseTo(9, 6); // radius - margin
    // direction preserved: still due +x of the center
    expect(far.z).toBeCloseTo(-2, 6);
    expect(far.x).toBeGreaterThan(4);
  });

  it("EVERY plot has a pre-routed spur ending at its door, even empty ones", () => {
    for (const plot of world.plots) {
      const spur = world.streets.find((s) => s.kind === "spur" && s.plotId === plot.id);
      expect(spur).toBeTruthy();
      const last = spur.points[spur.points.length - 1];
      expect(Math.hypot(last.x - plot.door.x, last.z - plot.door.z)).toBeLessThan(1.5);
    }
  });

  it("spurs attach to the street network (hub rim, lane or another street)", () => {
    const others = world.streets.filter((s) => s.kind !== "spur");
    for (const spur of world.streets.filter((s) => s.kind === "spur")) {
      const first = spur.points[0];
      const nearHub = ["day", "night"].some((name) => {
        const sec = world.sectors[name];
        return Math.hypot(first.x - sec.hub.x, first.z - sec.hub.z) <= sec.hubRadius + 0.7;
      });
      const nearStreet = others.some((o) =>
        o.points.some((p) => Math.hypot(p.x - first.x, p.z - first.z) < 1.2),
      );
      expect(nearHub || nearStreet).toBe(true);
    }
  });

  it("streets carry width tiers: spurs narrower than mains and the ridge road", () => {
    const widths = WORLD_DEFAULTS.streetWidths;
    expect(widths.spur).toBeLessThan(widths.lane);
    expect(widths.lane).toBeLessThan(widths.avenue);
    expect(widths.avenue).toBeLessThanOrEqual(widths.ridge);
    for (const s of world.streets) {
      expect(s.width).toBe(widths[s.kind]);
    }
    expect(world.streets.some((s) => s.kind === "lane")).toBe(true);
    expect(world.streets.some((s) => s.kind === "avenue")).toBe(true);
  });

  it("a ridge road connects the two districts", () => {
    const road = world.streets.find((s) => s.id === "ridge");
    expect(road).toBeTruthy();
    const first = road.points[0];
    const last = road.points[road.points.length - 1];
    const day = world.sectors.day.hub;
    const night = world.sectors.night.hub;
    expect(Math.hypot(first.x - day.x, first.z - day.z)).toBeLessThan(world.sectors.day.hubRadius + 0.5);
    expect(Math.hypot(last.x - night.x, last.z - night.z)).toBeLessThan(world.sectors.night.hubRadius + 0.5);
  });

  it("street waypoints sit on the terrain and climb gently", () => {
    for (const street of world.streets) {
      for (const p of street.points) {
        // the ground under the street tracks the street's own level
        expect(Math.abs(world.heightAt(p.x, p.z) - p.y)).toBeLessThan(0.3);
        expect(world.streetWeightAt(p.x, p.z)).toBeGreaterThan(0.85);
        expect(p.y).toBeGreaterThan(world.waterLevel);
      }
      for (let i = 1; i < street.points.length; i++) {
        const a = street.points[i - 1];
        const b = street.points[i];
        const run = Math.hypot(b.x - a.x, b.z - a.z);
        if (run < 1e-6) continue; // the lane loop closes on itself
        // walkable grade everywhere, including the ridge road
        expect(Math.abs(b.y - a.y) / run).toBeLessThan(0.45);
      }
    }
  });

  it("routeToDoor over a plot spur walks the spur and arrives at the door", () => {
    const home = world.homes["dreams"];
    const spur = world.streets.find((s) => s.plotId === home.plotId);
    const route = routeToDoor(spur.points, home.spawn, home.door);
    expect(route.length).toBeGreaterThan(1);
    const last = route[route.length - 1];
    expect(last.x).toBe(home.door.x);
    expect(last.z).toBe(home.door.z);
    // the walked lane stays on the street: every hop lands near the network
    for (const p of route.slice(0, -1)) {
      expect(world.streetWeightAt(p.x, p.z)).toBeGreaterThan(0.85);
    }
  });
});

describe("sim/world props + trees + wander", () => {
  const world = layoutWorld(MANY);

  it("props are deterministic, fixed geography, on land, and off the plots", () => {
    const w2 = layoutWorld([keeper("someone-else", "conscious", 0)]);
    expect(w2.props).toEqual(world.props); // geography does not follow the keepers
    expect(world.props.length).toBeGreaterThan(0);
    const kinds = new Set([...WORLD_DEFAULTS.propKinds, ...WORLD_DEFAULTS.nightPropKinds]);
    let nightCount = 0;
    for (const p of world.props) {
      expect(kinds.has(p.kind)).toBe(true);
      expect(["day", "night"]).toContain(p.sector);
      if (p.sector === "night") nightCount++;
      expect(p.y).toBeGreaterThan(world.waterLevel + 0.3);
      for (const plot of world.plots) {
        expect(Math.hypot(p.x - plot.x, p.z - plot.z)).toBeGreaterThanOrEqual(plot.plotRadius + 0.5);
      }
    }
    expect(nightCount).toBeGreaterThan(0); // the quarter is furnished too
  });

  it("trees: 4 species, deterministic, dense, both districts, never on plots or roadbeds", () => {
    expect(world.trees.length).toBeGreaterThanOrEqual(150);
    const w2 = layoutWorld([]);
    expect(w2.trees).toEqual(world.trees);
    const species = new Set(world.trees.map((t) => t.kind));
    for (const s of ["round", "pine", "tall", "bush"]) expect(species.has(s)).toBe(true);
    const nightTrees = world.trees.filter((t) => t.sector === "night");
    expect(nightTrees.length).toBeGreaterThan(20);
    for (const t of world.trees) {
      expect(t.y).toBeGreaterThan(world.waterLevel + 0.35);
      expect(t.night).toBeGreaterThanOrEqual(0);
      expect(t.night).toBeLessThanOrEqual(1);
      expect(t.scale).toBeGreaterThan(0.4);
      expect(world.streetWeightAt(t.x, t.z)).toBeLessThanOrEqual(0.55);
      for (const plot of world.plots) {
        expect(Math.hypot(t.x - plot.x, t.z - plot.z)).toBeGreaterThan(plot.plotRadius + 1.1);
      }
    }
  });

  it("trees cluster into groves (many trees have a close neighbor)", () => {
    let clustered = 0;
    for (const t of world.trees) {
      if (
        world.trees.some(
          (o) => o !== t && Math.hypot(o.x - t.x, o.z - t.z) < 3.2 && o.kind === t.kind,
        )
      ) {
        clustered++;
      }
    }
    expect(clustered / world.trees.length).toBeGreaterThan(0.4);
  });

  it("makeWanderSampler stays within the sector and on land", () => {
    const sampler = makeWanderSampler(world.sectors.night, world);
    const rng = mulberry32(7);
    for (let i = 0; i < 200; i++) {
      const p = sampler(rng);
      const d = Math.hypot(p.x - world.sectors.night.center.x, p.z - world.sectors.night.center.z);
      expect(d).toBeLessThanOrEqual(world.sectors.night.radius);
      expect(world.heightAt(p.x, p.z)).toBeGreaterThan(world.waterLevel + 0.25);
    }
  });

  it("makeWanderSampler NEVER samples the other district (both directions)", () => {
    const rng = mulberry32(31);
    for (const name of ["day", "night"]) {
      const sampler = makeWanderSampler(world.sectors[name], world);
      for (let i = 0; i < 150; i++) {
        const p = sampler(rng);
        expect(world.sectorNameAt(p.x, p.z)).toBe(name);
      }
    }
  });

  it("makeWanderSampler keeps sampled targets out of solid obstacles", () => {
    const sampler = makeWanderSampler(world.sectors.day, world);
    const rng = mulberry32(13);
    for (let i = 0; i < 150; i++) {
      const p = sampler(rng);
      for (const o of world.obstacles) {
        expect(Math.hypot(o.x - p.x, o.z - p.z)).toBeGreaterThan(o.r);
      }
    }
  });

  it("garden props never become obstacles (keepers can idle in their garden)", () => {
    for (const plot of world.plots) {
      for (const gp of plot.garden.props) {
        expect(world.obstacles.find((o) => o.x === gp.x && o.z === gp.z)).toBeUndefined();
      }
    }
  });

  it("obstacles are deterministic, cover every OCCUPIED plot, and leave doors reachable", () => {
    const w2 = layoutWorld([...MANY].reverse());
    expect(w2.obstacles).toEqual(world.obstacles);
    for (const home of Object.values(world.homes)) {
      const ob = world.obstacles.find((o) => o.x === home.x && o.z === home.z);
      expect(ob).toBeTruthy(); // the house is solid
      // the door sits outside the house circle so join walks can arrive
      expect(Math.hypot(home.door.x - home.x, home.door.z - home.z)).toBeGreaterThan(ob.r);
    }
    // empty plots stay walkable (keepers can discover them)
    for (const plot of world.plots.filter((p) => !p.occupied)) {
      expect(world.obstacles.find((o) => o.x === plot.x && o.z === plot.z)).toBeUndefined();
    }
    for (const o of world.obstacles) {
      expect(Number.isFinite(o.x)).toBe(true);
      expect(Number.isFinite(o.z)).toBe(true);
      expect(o.r).toBeGreaterThan(0);
      expect(o.r).toBeLessThan(2); // circles stay local, never wall off a street
    }
  });
});

// ---------------------------------------------------------------------------
// Irregular coastline (owner: no more two perfect circles)
// ---------------------------------------------------------------------------

describe("sim/world irregular coastline", () => {
  const world = layoutWorld(MANY);

  // The waterline radius around a lobe center at a given angle, found by
  // bisection on heightAt. Angles pointing at the other lobe (the neck) are
  // excluded by the callers.
  function coastRadius(sector, angle) {
    let lo = sector.radius * 0.4;
    let hi = sector.radius * 2.4;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      const h = world.heightAt(
        sector.center.x + Math.cos(angle) * mid,
        sector.center.z + Math.sin(angle) * mid,
      );
      if (h > world.waterLevel) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  function scanLobe(name) {
    const sec = world.sectors[name];
    const other = world.sectors[name === "day" ? "night" : "day"];
    const toOther = Math.atan2(other.center.z - sec.center.z, other.center.x - sec.center.x);
    const radii = [];
    for (let k = 0; k < 72; k++) {
      const a = (k / 72) * Math.PI * 2;
      let d = Math.abs(a - toOther);
      while (d > Math.PI) d = Math.abs(d - 2 * Math.PI);
      if (d < 0.7) continue; // skip the neck wedge
      radii.push(coastRadius(sec, a));
    }
    return radii;
  }

  it.each(["day", "night"])("the %s lobe's coast is no circle: radius variance above threshold", (name) => {
    const radii = scanLobe(name);
    const mean = radii.reduce((s, r) => s + r, 0) / radii.length;
    const sd = Math.sqrt(radii.reduce((s, r) => s + (r - mean) ** 2, 0) / radii.length);
    // relative deviation: a perfect circle scores ~0
    expect(sd / mean).toBeGreaterThan(0.05);
    // and no circle of ANY radius fits: the worst residual from the best-fit
    // circle (the mean radius) is large in world units
    const worst = Math.max(...radii.map((r) => Math.abs(r - mean)));
    expect(worst).toBeGreaterThan(2.5);
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(4);
  });

  it("keeps at least the old two-circle playable land area", () => {
    // old geography: two exact discs r=26 and r=17 plus the neck
    const oldArea = Math.PI * (26 * 26 + 17 * 17);
    let land = 0;
    const N = 140;
    const half = 88;
    const cell = (2 * half) / N;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = -half + (i + 0.5) * cell;
        const z = -half + (j + 0.5) * cell;
        if (world.heightAt(x, z) > world.waterLevel) land++;
      }
    }
    expect(land * cell * cell).toBeGreaterThanOrEqual(oldArea);
  });

  it("coastline is deterministic across layouts", () => {
    const w2 = layoutWorld([]);
    const rng = mulberry32(77);
    for (let i = 0; i < 60; i++) {
      const x = (rng() - 0.5) * 170;
      const z = (rng() - 0.5) * 170;
      expect(w2.heightAt(x, z)).toBe(world.heightAt(x, z));
    }
  });
});

// ---------------------------------------------------------------------------
// The street graph (organic node network)
// ---------------------------------------------------------------------------

describe("sim/world street graph", () => {
  const world = layoutWorld(MANY);
  const graph = world.graph;

  it("exposes nodes, edges and a consistent adjacency", () => {
    expect(graph.nodes.length).toBeGreaterThan(10);
    expect(graph.edges.length).toBeGreaterThan(20);
    const ids = new Set(graph.nodes.map((n) => n.id));
    expect(ids.size).toBe(graph.nodes.length);
    for (const e of graph.edges) {
      expect(ids.has(e.a)).toBe(true);
      expect(ids.has(e.b)).toBe(true);
      expect(e.points.length).toBeGreaterThanOrEqual(2);
      expect(e.length).toBeGreaterThan(0);
      // adjacency lists both directions
      expect(graph.adjacency[e.a].some((l) => l.edgeId === e.id && l.to === e.b)).toBe(true);
      expect(graph.adjacency[e.b].some((l) => l.edgeId === e.id && l.to === e.a)).toBe(true);
    }
    // the main nodes and junctions exist in both districts
    expect(ids.has("plaza")).toBe(true);
    expect(ids.has("hub")).toBe(true);
    expect(graph.nodes.filter((n) => n.kind === "junction" && n.sector === "day").length).toBeGreaterThanOrEqual(4);
    expect(graph.nodes.filter((n) => n.kind === "junction" && n.sector === "night").length).toBeGreaterThanOrEqual(2);
  });

  it("streets mirror the edges with the {id, kind, width, points} shape", () => {
    expect(world.streets).toHaveLength(graph.edges.length);
    for (const s of world.streets) {
      expect(typeof s.id).toBe("string");
      expect(["spur", "avenue", "lane", "ridge"]).toContain(s.kind);
      expect(s.width).toBe(WORLD_DEFAULTS.streetWidths[s.kind]);
      expect(s.points.length).toBeGreaterThanOrEqual(2);
    }
    expect(world.streets.some((s) => s.id === "ridge")).toBe(true);
  });

  it("streets carry junction hints (ends): the node kind at each terminal", () => {
    const nodeKinds = new Map(graph.nodes.map((n) => [n.id, n.kind]));
    const edgeById = new Map(graph.edges.map((e) => [e.id, e]));
    for (const s of world.streets) {
      const e = edgeById.get(s.id);
      expect(s.ends).toEqual({ head: nodeKinds.get(e.a), tail: nodeKinds.get(e.b) });
      expect(["plaza", "hub", "junction", "plot"]).toContain(s.ends.head);
      expect(["plaza", "hub", "junction", "plot"]).toContain(s.ends.tail);
    }
    // spurs run junction -> plot gate: the door approach never reads as a
    // fading end, the network side does
    for (const spur of world.streets.filter((s) => s.kind === "spur")) {
      expect(spur.ends.head).toBe("junction");
      expect(spur.ends.tail).toBe("plot");
    }
    // the ridge road collides with both hub discs: both ends are fade ends
    const ridge = world.streets.find((s) => s.id === "ridge");
    expect(ridge.ends).toEqual({ head: "plaza", tail: "hub" });
  });

  it("every plot, the plaza and the hub are reachable (district-bound)", () => {
    for (const plot of world.plots) {
      const root = plot.sector === "day" ? "plaza" : "hub";
      const route = routeOnGraph(graph, root, "plot:" + plot.id, { sector: plot.sector });
      expect(route).toBeTruthy();
      expect(route.length).toBeGreaterThan(1);
    }
    // the two districts connect only over the ridge road
    expect(routeOnGraph(graph, "plaza", "hub")).toBeTruthy();
    expect(routeOnGraph(graph, "plaza", "hub", { sector: "day" })).toBeNull();
    expect(routeOnGraph(graph, "plaza", "hub", { sector: "night" })).toBeNull();
  });

  it("the network carries loops (more than a tree)", () => {
    // a connected component with E >= N edges must contain a cycle
    const dayNodes = graph.nodes.filter((n) => n.sector === "day");
    const dayEdges = graph.edges.filter((e) => e.sector === "day");
    expect(dayEdges.length).toBeGreaterThanOrEqual(dayNodes.length);
  });

  it("edges are curved polylines, not ruler lines", () => {
    let bentCount = 0;
    for (const e of graph.edges) {
      if (e.kind === "spur" || e.points.length < 5) continue;
      const a = e.points[0];
      const b = e.points[e.points.length - 1];
      const abx = b.x - a.x;
      const abz = b.z - a.z;
      const len = Math.hypot(abx, abz) || 1e-9;
      let maxOff = 0;
      for (const p of e.points) {
        const off = Math.abs((p.x - a.x) * (-abz / len) + (p.z - a.z) * (abx / len));
        maxOff = Math.max(maxOff, off);
      }
      if (maxOff > 0.35) bentCount++;
    }
    expect(bentCount).toBeGreaterThan(3);
  });

  it("nearestNode honors sector and kind filters", () => {
    const day = world.sectors.day;
    const n = nearestNode(graph, day.hub.x, day.hub.z, { sector: "day" });
    expect(n.id).toBe("plaza");
    const j = nearestNode(graph, day.hub.x, day.hub.z, { sector: "day", kinds: ["junction"] });
    expect(j.kind).toBe("junction");
    const night = nearestNode(graph, day.hub.x, day.hub.z, { sector: "night" });
    expect(night.sector).toBe("night");
  });

  it("routeOnGraph handles the degenerate cases", () => {
    expect(routeOnGraph(graph, "plaza", "plaza")).toEqual([]);
    expect(routeOnGraph(graph, "plaza", "no-such-node")).toBeNull();
    expect(routeOnGraph(null, "a", "b")).toBeNull();
  });

  it("routeToDoorFrom routes over the network and ends at the door", () => {
    const home = world.homes["dreams"];
    const from = { x: world.plaza.center.x, z: world.plaza.center.z };
    const route = world.routeToDoorFrom(from, home.plotId);
    expect(route.length).toBeGreaterThan(3);
    const last = route[route.length - 1];
    expect(last.x).toBe(home.door.x);
    expect(last.z).toBe(home.door.z);
    // every hop except the doorstep stays on the street network
    for (const p of route.slice(0, -1)) {
      expect(world.streetWeightAt(p.x, p.z)).toBeGreaterThan(0.5);
    }
    // unknown plot: no route
    expect(world.routeToDoorFrom(from, "nope")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Gardens (every plot pre-plans one; only occupied plots render it)
// ---------------------------------------------------------------------------

describe("sim/world gardens", () => {
  const world = layoutWorld(MANY);

  it("every plot carries a garden: gate on the spur, a loop, 2-3 props", () => {
    for (const plot of world.plots) {
      const g = plot.garden;
      expect(g).toBeTruthy();
      // the gate is the spur end (2.1 units out along the facing angle)
      expect(g.gate.x).toBeCloseTo(plot.x + Math.cos(plot.angle) * 2.1, 6);
      expect(g.gate.z).toBeCloseTo(plot.z + Math.sin(plot.angle) * 2.1, 6);
      // the loop closes at the gate and stays inside the plot
      expect(g.loop.length).toBeGreaterThanOrEqual(10);
      expect(g.loop[0].x).toBeCloseTo(g.gate.x, 6);
      expect(g.loop[g.loop.length - 1].x).toBeCloseTo(g.gate.x, 6);
      for (const p of g.loop) {
        const d = Math.hypot(p.x - plot.x, p.z - plot.z);
        expect(d).toBeLessThanOrEqual(plot.plotRadius);
        expect(d).toBeGreaterThan(1.4); // never through the cottage
        expect(Math.abs(p.y - world.heightAt(p.x, p.z))).toBeLessThan(1e-9);
      }
      // 2-3 small props from EXISTING kinds only
      expect(g.props.length).toBeGreaterThanOrEqual(2);
      expect(g.props.length).toBeLessThanOrEqual(3);
      const okKinds =
        plot.sector === "night" ? ["crystal", "rock", "bush"] : ["flower", "bush", "rock"];
      for (const gp of g.props) {
        expect(okKinds).toContain(gp.kind);
        expect(Math.hypot(gp.x - plot.x, gp.z - plot.z)).toBeLessThan(plot.plotRadius + 0.2);
        expect(gp.scale).toBeGreaterThan(0.3);
        expect(gp.scale).toBeLessThan(1);
      }
    }
  });

  it("gardens are deterministic and independent of the keepers", () => {
    const a = layoutWorld(MANY);
    const b = layoutWorld([]);
    expect(a.plots.map((p) => p.garden)).toEqual(b.plots.map((p) => p.garden));
    expect(a.plots.map((p) => p.garden)).toEqual(world.plots.map((p) => p.garden));
  });
});

// ---------------------------------------------------------------------------
// Graph wander planner (NPCs walk only on paths)
// ---------------------------------------------------------------------------

describe("sim/world makeGraphWanderPlanner", () => {
  const world = layoutWorld(MANY);

  // A waypoint counts as on-network when it sits on a street, on a hub
  // disc, or inside the walker's own garden.
  function onNetwork(p, plot) {
    if (world.streetWeightAt(p.x, p.z) >= 0.45) return true;
    if (world.hubWeightAt(p.x, p.z) >= 0.25) return true;
    if (plot && Math.hypot(p.x - plot.x, p.z - plot.z) <= plot.plotRadius + 0.2) return true;
    return false;
  }

  it.each(["day", "night"])("plans %s routes that stay on the network and inside the district", (sector) => {
    const keeper = Object.entries(world.homes).find(([, h]) => h.sector === sector);
    const home = keeper[1];
    const plot = world.plots.find((p) => p.id === home.plotId);
    const planner = makeGraphWanderPlanner(world, { sector, plotId: home.plotId });
    const rng = mulberry32(hashString("planner:" + sector));
    let pos = { ...home.spawn };
    let planned = 0;
    for (let i = 0; i < 40; i++) {
      const route = planner(rng, pos);
      expect(Array.isArray(route)).toBe(true);
      if (!route.length) continue;
      planned++;
      for (const p of route) {
        expect(onNetwork(p, plot)).toBe(true);
        expect(world.sectorNameAt(p.x, p.z)).toBe(sector); // never crosses
      }
      pos = route[route.length - 1];
    }
    expect(planned).toBeGreaterThan(30);
  });

  it("routeClearOf bends a polyline around a hard circle (pure)", () => {
    const center = { x: 0, z: 0 };
    // straight through the middle: gets a perpendicular detour waypoint
    const through = routeClearOf(
      [
        { x: -4, z: 0 },
        { x: 4, z: 0 },
      ],
      center,
      1.5,
    );
    expect(through.length).toBe(3);
    expect(Math.hypot(through[1].x, through[1].z)).toBeCloseTo(1.5 * 1.05, 6);
    // a waypoint INSIDE the circle is lifted onto the rim
    const lifted = routeClearOf([{ x: 0.4, z: 0 }], center, 1.5);
    expect(Math.hypot(lifted[0].x, lifted[0].z)).toBeCloseTo(1.5, 6);
    // clear polylines pass through untouched
    const clearLine = [
      { x: -4, z: 3 },
      { x: 4, z: 3 },
    ];
    expect(routeClearOf(clearLine, center, 1.5)).toEqual(clearLine);
    // degenerate inputs never explode
    expect(routeClearOf([], center, 1.5)).toEqual([]);
    expect(routeClearOf(clearLine, null, 1.5)).toEqual(clearLine);
    const centered = routeClearOf([{ x: 0, z: 0 }], center, 1.5);
    expect(Number.isFinite(centered[0].x)).toBe(true);
  });

  it.each(["day", "night"])(
    "%s hub strolls keep routing clearance around the centerpiece (well/obelisk)",
    (sector) => {
      const home = Object.values(world.homes).find((h) => h.sector === sector);
      const planner = makeGraphWanderPlanner(world, { sector, plotId: home.plotId });
      const hub = sector === "night" ? world.hub : world.plaza;
      const solid = world.centerpieceR[sector];
      const clear = solid + world.centerpieceClearance;
      const rng = mulberry32(hashString("centerpiece:" + sector));
      let discTrips = 0;
      for (let i = 0; i < 300; i++) {
        const route = planner(rng, { ...home.spawn });
        if (!route.length) continue;
        const last = route[route.length - 1];
        const dLast = Math.hypot(last.x - hub.center.x, last.z - hub.center.z);
        if (dLast <= hub.radius) {
          // A disc stroll: the target keeps the full routing clearance.
          discTrips++;
          expect(dLast).toBeGreaterThanOrEqual(clear - 1e-9);
        }
        // And NO planned segment ever crosses the solid centerpiece circle.
        for (let k = 1; k < route.length; k++) {
          const a = route[k - 1];
          const b = route[k];
          const abx = b.x - a.x;
          const abz = b.z - a.z;
          const q = abx * abx + abz * abz || 1e-9;
          let t = ((hub.center.x - a.x) * abx + (hub.center.z - a.z) * abz) / q;
          t = Math.max(0, Math.min(1, t));
          const d = Math.hypot(
            hub.center.x - (a.x + abx * t),
            hub.center.z - (a.z + abz * t),
          );
          expect(d).toBeGreaterThanOrEqual(solid);
        }
      }
      expect(discTrips).toBeGreaterThan(20); // hub trips do happen
    },
  );

  it("the centerpieces are hard obstacles for the walkers", () => {
    for (const [name, hub] of [
      ["day", world.plaza],
      ["night", world.hub],
    ]) {
      const ob = world.obstacles.find(
        (o) => o.x === hub.center.x && o.z === hub.center.z,
      );
      expect(ob).toBeTruthy();
      expect(ob.r).toBe(world.centerpieceR[name]);
    }
  });

  it("garden trips end inside the walker's own garden", () => {
    const [keeperId, home] = Object.entries(world.homes)[0];
    const plot = world.plots.find((p) => p.id === home.plotId);
    const planner = makeGraphWanderPlanner(world, { sector: home.sector, plotId: home.plotId });
    // force the garden branch: first roll < 0.34
    const rolls = [0.1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
    let i = 0;
    const random = () => rolls[Math.min(i++, rolls.length - 1)];
    const start = world.sectors[home.sector].hub;
    const route = planner(random, { x: start.x, z: start.z });
    expect(route.length).toBeGreaterThan(2);
    const last = route[route.length - 1];
    expect(Math.hypot(last.x - plot.x, last.z - plot.z)).toBeLessThanOrEqual(plot.plotRadius + 0.2);
    expect(keeperId).toBeTruthy();
  });
});
