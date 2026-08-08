// Pins the sim contract: layout counts and reachability, walker rules,
// deterministic graph layout.
import { describe, expect, it } from "vitest";
import { buildLayout, neighborsOf, LIGHT_PLOTS, DARK_PLOTS, islandRadiusAt, ISLAND_RADIUS } from "../src/sim/plots.js";
import { createWalker, stepAll } from "../src/sim/walker.js";
import { layout } from "../src/sim/graphlayout.js";

describe("plots", () => {
  const { plots, network } = buildLayout();

  it("has 16 light and 8 dark plots, deterministic", () => {
    expect(plots.filter((p) => p.side === "light")).toHaveLength(LIGHT_PLOTS);
    expect(plots.filter((p) => p.side === "dark")).toHaveLength(DARK_PLOTS);
    expect(buildLayout().plots).toEqual(plots);
  });

  it("routes every plot door to its hub through the network", () => {
    const neighbors = neighborsOf(network);
    for (const plot of plots) {
      const seen = new Set([`door:${plot.id}`]);
      const queue = [`door:${plot.id}`];
      while (queue.length) {
        for (const next of neighbors[queue.shift()] || []) {
          if (!seen.has(next)) { seen.add(next); queue.push(next); }
        }
      }
      expect(seen.has("plaza")).toBe(true);
    }
  });

  it("shore is irregular, never a perfect circle", () => {
    const radii = [];
    for (let a = 0; a < 6.28; a += 0.5) radii.push(islandRadiusAt(a));
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(ISLAND_RADIUS * 0.1);
  });
});

describe("walker", () => {
  it("moves along paths, keeps side and separation", () => {
    const { plots, network } = buildLayout();
    const light = plots.filter((p) => p.side === "light").slice(0, 4);
    const dark = plots.filter((p) => p.side === "dark").slice(0, 2);
    const walkers = [
      ...light.map((p, i) => createWalker("k" + i, p.id, "light", network)),
      ...dark.map((p, i) => createWalker("d" + i, p.id, "dark", network)),
    ];
    const start = walkers.map((w) => ({ ...w.pos }));
    for (let t = 0; t < 2000; t++) stepAll(walkers, network, 1 / 30);

    const moved = walkers.some((w, i) =>
      Math.hypot(w.pos.x - start[i].x, w.pos.z - start[i].z) > 1);
    expect(moved).toBe(true);
    for (const w of walkers) {
      if (w.side === "dark") expect(w.pos.z).toBeLessThan(0);
      else expect(w.pos.z).toBeGreaterThan(-8);
    }
    for (const a of walkers) for (const b of walkers) {
      if (a !== b) expect(Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z)).toBeGreaterThan(0.25);
    }
  });
});

describe("graph layout", () => {
  const graph = {
    nodes: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
    edges: [{ source: "a", target: "b", weight: 2 }, { source: "b", target: "c" }],
  };

  it("is deterministic and keeps nodes in bounds", () => {
    const first = layout(graph);
    const second = layout(graph);
    expect(second).toEqual(first);
    for (const n of first) {
      expect(Math.abs(n.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(n.y)).toBeLessThanOrEqual(1);
    }
    const spread = new Set(first.map((n) => n.x.toFixed(3) + n.y.toFixed(3)));
    expect(spread.size).toBe(first.length);
  });
});
