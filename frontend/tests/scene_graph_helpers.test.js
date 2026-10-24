// scene_graph.js is three.js territory (exempt from DOM tests) but its pure
// helpers (easing, wave timing, palette mapping, label picking, starfield,
// edge curves) are unit-tested here per the frontend spec.
import { describe, expect, it } from "vitest";
import {
  ENTITY_GOLD,
  keeperPaletteMap,
  buildPlaybackSchedule,
  easeInOutCubic,
  easeOutBack,
  edgeCurvePoints,
  mixHex,
  nodeColorHex,
  nodeScale,
  parseHex,
  pickLabeledNodeIds,
  staggeredProgress,
  starfieldPositions,
} from "../src/render/scene_graph.js";

describe("easing", () => {
  it("easeInOutCubic hits 0, 0.5 and 1 and clamps outside [0,1]", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 10);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(-3)).toBe(0);
    expect(easeInOutCubic(3)).toBe(1);
    let prev = -Infinity;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const v = easeInOutCubic(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("easeOutBack lands exactly on 1 and overshoots on the way", () => {
    expect(easeOutBack(0)).toBeCloseTo(0, 10);
    expect(easeOutBack(1)).toBeCloseTo(1, 10);
    expect(easeOutBack(0.8)).toBeGreaterThan(1); // the springy overshoot
  });
});

describe("staggeredProgress", () => {
  it("all items start at 0 and land at 1 together with the wave", () => {
    for (let i = 0; i < 5; i++) {
      expect(staggeredProgress(0, i, 5)).toBe(0);
      expect(staggeredProgress(1, i, 5)).toBe(1);
    }
  });

  it("earlier items lead later items mid-wave", () => {
    const early = staggeredProgress(0.5, 0, 6);
    const late = staggeredProgress(0.5, 5, 6);
    expect(early).toBeGreaterThan(late);
  });
});

describe("buildPlaybackSchedule (wave timing)", () => {
  const timeline = [
    { t: 0.25, nodeIds: ["a"] },
    { t: 0.5, nodeIds: ["b"] },
    { t: 0.75, edgeIds: ["e0"] },
    { t: 1, edgeIds: ["e1"] },
  ];

  it("assigns node/edge durations and overlapping starts", () => {
    const { waves, total } = buildPlaybackSchedule(timeline, {
      nodeWaveSeconds: 2,
      edgeDrawSeconds: 1,
      overlap: 0.25,
    });
    expect(waves.map((w) => w.duration)).toEqual([2, 2, 1, 1]);
    expect(waves.map((w) => w.start)).toEqual([0, 1.5, 3, 3.75]);
    expect(total).toBeCloseTo(4.75, 10);
  });

  it("keeps starts strictly increasing and total covering every wave", () => {
    const { waves, total } = buildPlaybackSchedule(timeline);
    for (let i = 1; i < waves.length; i++) {
      expect(waves[i].start).toBeGreaterThan(waves[i - 1].start);
    }
    for (const w of waves) expect(w.start + w.duration).toBeLessThanOrEqual(total + 1e-9);
    expect(waves.map((w) => w.t)).toEqual(timeline.map((w) => w.t));
  });

  it("returns an empty schedule for an empty timeline", () => {
    expect(buildPlaybackSchedule([])).toEqual({ waves: [], total: 0 });
    expect(buildPlaybackSchedule(undefined)).toEqual({ waves: [], total: 0 });
  });
});

describe("labels stay compact", () => {
  const nodes = [
    { id: "n1", weight: 1 },
    { id: "n2", weight: 9 },
    { id: "n3", weight: 4 },
    { id: "n4", weight: 7 },
  ];

  it("picks only the top-weight nodes, capped at max", () => {
    expect(pickLabeledNodeIds(nodes, 2)).toEqual(["n2", "n4"]);
    expect(pickLabeledNodeIds(nodes, 99)).toHaveLength(4);
    expect(pickLabeledNodeIds(nodes, 0)).toEqual([]);
  });

  it("breaks weight ties deterministically by id", () => {
    const tied = [
      { id: "zz", weight: 3 },
      { id: "aa", weight: 3 },
    ];
    expect(pickLabeledNodeIds(tied, 1)).toEqual(["aa"]);
  });
});

describe("palette and node colors", () => {
  it("parseHex handles #rrggbb and rejects junk", () => {
    expect(parseHex("#ffffff")).toEqual({ r: 1, g: 1, b: 1 });
    expect(parseHex("000000")).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseHex("nope")).toBeNull();
    expect(parseHex(null)).toBeNull();
  });

  it("mixHex interpolates between endpoints", () => {
    expect(mixHex("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixHex("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  it("keeperPaletteMap merges live keepers with the run's newborns", () => {
    const state = { keepers: [{ id: "dreams", palette: { primary: "#f8a7c0" } }] };
    const report = { created_keepers: [{ id: "fear-of-water", palette: { primary: "#6d5a8f" } }] };
    const map = keeperPaletteMap(state, report);
    expect(map.get("dreams").primary).toBe("#f8a7c0");
    expect(map.get("fear-of-water").primary).toBe("#6d5a8f");
  });

  it("tints keeper and book nodes from the keeper palette, entities warm gold", () => {
    const palettes = keeperPaletteMap({ keepers: [{ id: "dreams", palette: { primary: "#f8a7c0" } }] }, null);
    const keeperColor = nodeColorHex({ kind: "keeper", keeper_id: "dreams" }, palettes);
    const bookColor = nodeColorHex({ kind: "book", keeper_id: "dreams" }, palettes);
    expect(keeperColor).toBe("#f8a7c0");
    expect(bookColor).not.toBe(keeperColor); // lightened, but still from the palette
    expect(parseHex(bookColor)).toBeTruthy();
    expect(nodeColorHex({ kind: "entity", id: "entity:Ocean" }, palettes)).toBe(ENTITY_GOLD);
  });

  it("falls back to a parseable color for unknown keepers", () => {
    const color = nodeColorHex({ kind: "book", keeper_id: "ghost" }, new Map());
    expect(parseHex(color)).toBeTruthy();
  });
});

describe("node sizing", () => {
  it("scales by kind and grows with weight", () => {
    expect(nodeScale({ kind: "keeper", weight: 3 })).toBeGreaterThan(nodeScale({ kind: "book", weight: 3 }));
    expect(nodeScale({ kind: "book", weight: 5 })).toBeGreaterThan(nodeScale({ kind: "book", weight: 1 }));
    expect(nodeScale({ kind: "entity" })).toBeGreaterThan(0);
  });
});

describe("starfield", () => {
  it("is deterministic per seed and bounded to the shell", () => {
    const a = starfieldPositions(200, 30, 90, 7);
    const b = starfieldPositions(200, 30, 90, 7);
    const c = starfieldPositions(200, 30, 90, 8);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a.length).toBe(600);
    for (let i = 0; i < 200; i++) {
      const r = Math.sqrt(a[i * 3] ** 2 + a[i * 3 + 1] ** 2 + a[i * 3 + 2] ** 2);
      expect(r).toBeGreaterThanOrEqual(30 - 1e-6);
      expect(r).toBeLessThanOrEqual(90 + 1e-6);
    }
  });
});

describe("edge curves", () => {
  it("starts at the source, ends at the target, and stays finite", () => {
    const a = { x: -8, y: 1, z: 2 };
    const b = { x: 6, y: -2, z: -4 };
    const pts = edgeCurvePoints(a, b, 24);
    expect(pts).toHaveLength(25);
    expect(pts[0]).toEqual(a);
    expect(pts[24].x).toBeCloseTo(b.x, 10);
    expect(pts[24].y).toBeCloseTo(b.y, 10);
    expect(pts[24].z).toBeCloseTo(b.z, 10);
    for (const p of pts) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
    }
  });

  it("keeps the bow bounded even for nodes opposite the origin", () => {
    const a = { x: -10, y: 0, z: 0 };
    const b = { x: 10, y: 0, z: 0 }; // midpoint sits exactly on the origin
    const pts = edgeCurvePoints(a, b, 24);
    for (const p of pts) {
      expect(Math.sqrt(p.x ** 2 + p.y ** 2 + p.z ** 2)).toBeLessThanOrEqual(15);
    }
  });
});
