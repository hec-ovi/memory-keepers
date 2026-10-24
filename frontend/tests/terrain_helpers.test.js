// Pure helpers of the overworld render modules (render/ is exempt from
// DOM/WebGL tests, its math is not): ground shading, the macro-texture
// shade, grass placements, shoreline extraction, foam motion, cottage
// palettes.
import { describe, it, expect } from "vitest";
import {
  groundShade,
  macroShade,
  grassPlacements,
  extractShoreline,
  foamMotion,
} from "../src/render/terrain.js";
import { cottagePalette } from "../src/render/props.js";
import { hexToRgb } from "../src/render/keeper_mesh.js";
import { layoutWorld } from "../src/sim/world.js";

const luminance = (hex) => {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const keeper = (id, kind = "conscious") => ({ id, kind });
const WORLD = layoutWorld([
  keeper("dreams"),
  keeper("meetings"),
  keeper("music"),
  keeper("fear-of-heights", "unconscious"),
  keeper("desire-to-fly", "unconscious"),
]);

describe("render/terrain groundShade", () => {
  const base = { height: 1.4, slope: 0.05, streetW: 0, hubW: 0, nightW: 0, tone: 0.5, waterLevel: 0 };

  it("returns rgb components in [0,1]", () => {
    for (const patch of [base, { ...base, height: -2 }, { ...base, slope: 1 }, { ...base, nightW: 1 }]) {
      const c = groundShade(patch);
      expect(c).toHaveLength(3);
      for (const v of c) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("paints a sandy shore ring near the waterline", () => {
    const grass = groundShade(base);
    const shore = groundShade({ ...base, height: 0.15 });
    // sand is brighter and less green-dominant than grass
    expect(shore[0]).toBeGreaterThan(grass[0]);
    expect(shore[1] - shore[0]).toBeLessThan(grass[1] - grass[0]);
  });

  it("turns steep ground into rock (desaturated)", () => {
    const cliff = groundShade({ ...base, slope: 0.9 });
    const spreadCliff = Math.max(...cliff) - Math.min(...cliff);
    const grass = groundShade(base);
    const spreadGrass = Math.max(...grass) - Math.min(...grass);
    expect(spreadCliff).toBeLessThan(spreadGrass);
  });

  it("marks streets as dirt and the plaza as cobble", () => {
    const grass = groundShade(base);
    const street = groundShade({ ...base, streetW: 1 });
    const plaza = groundShade({ ...base, hubW: 1 });
    expect(street).not.toEqual(grass);
    expect(plaza).not.toEqual(grass);
    expect(street[0]).toBeGreaterThan(street[1]); // dirt is red-brown
  });

  it("cools and darkens the unconscious quarter, but keeps it readable", () => {
    const day = groundShade(base);
    const night = groundShade({ ...base, nightW: 1 });
    const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    expect(lum(night)).toBeLessThan(lum(day) * 0.7);
    // moonlit blue, not blackness
    expect(lum(night)).toBeGreaterThan(0.15);
    expect(night[2]).toBeGreaterThan(night[0]); // blue-shifted
  });

  it("varies grass tone deterministically", () => {
    const a = groundShade({ ...base, tone: 0 });
    const b = groundShade({ ...base, tone: 1 });
    expect(a).not.toEqual(b);
    expect(groundShade({ ...base, tone: 0.3 })).toEqual(groundShade({ ...base, tone: 0.3 }));
  });
});

describe("render/terrain macroShade (macro texture texel)", () => {
  it("is deterministic and stays in [0,1]", () => {
    for (const inp of [
      {},
      { grain: 0, mottle: 0, flowerW: 0, mossW: 0 },
      { grain: 1, mottle: 1, flowerW: 1, mossW: 1 },
      { grain: 0.3, mottle: 0.8, flowerW: 0.5, mossW: 0.2 },
    ]) {
      const c = macroShade(inp);
      expect(macroShade(inp)).toEqual(c);
      for (const v of c) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("flower patches lift red and blue (pink cast)", () => {
    const plain = macroShade({ grain: 0.5, mottle: 0.5 });
    const flowers = macroShade({ grain: 0.5, mottle: 0.5, flowerW: 0.6 });
    expect(flowers[0]).toBeGreaterThan(plain[0]);
    expect(flowers[2]).toBeGreaterThan(plain[2]);
    expect(flowers[0] - plain[0]).toBeGreaterThan(flowers[1] - plain[1]);
  });

  it("moss darkens warm channels and cools toward blue", () => {
    const plain = macroShade({ grain: 0.5, mottle: 0.5 });
    const moss = macroShade({ grain: 0.5, mottle: 0.5, mossW: 1 });
    expect(moss[0]).toBeLessThan(plain[0]);
    expect(moss[1]).toBeLessThan(plain[1]);
    expect(moss[2]).toBeGreaterThan(plain[2]);
  });

  it("grain modulates luminance", () => {
    expect(macroShade({ grain: 1 })[0]).toBeGreaterThan(macroShade({ grain: 0 })[0]);
  });
});

describe("render/terrain grassPlacements", () => {
  const tufts = grassPlacements(WORLD, { count: 160, seed: 5 });

  it("is deterministic per seed", () => {
    expect(grassPlacements(WORLD, { count: 160, seed: 5 })).toEqual(tufts);
    expect(grassPlacements(WORLD, { count: 160, seed: 6 })).not.toEqual(tufts);
  });

  it("places a healthy number of tufts on land, off streets and hubs", () => {
    expect(tufts.length).toBeGreaterThan(100);
    for (const t of tufts) {
      expect(WORLD.heightAt(t.x, t.z)).toBeGreaterThan(WORLD.waterLevel + 0.35);
      expect(WORLD.streetWeightAt(t.x, t.z)).toBeLessThanOrEqual(0.15);
      expect(WORLD.hubWeightAt(t.x, t.z)).toBeLessThanOrEqual(0.05);
      expect(t.y).toBeCloseTo(WORLD.heightAt(t.x, t.z), 9);
      expect(t.night).toBeGreaterThanOrEqual(0);
      expect(t.night).toBeLessThanOrEqual(1);
      expect(Number.isFinite(t.scale)).toBe(true);
    }
  });

  it("covers both districts", () => {
    expect(tufts.some((t) => t.night > 0.9)).toBe(true);
    expect(tufts.some((t) => t.night < 0.1)).toBe(true);
  });
});

describe("render/terrain extractShoreline", () => {
  const chains = extractShoreline(WORLD);

  it("is deterministic", () => {
    expect(extractShoreline(WORLD)).toEqual(chains);
  });

  it("traces the coast: every point sits near the waterline level", () => {
    expect(chains.length).toBeGreaterThan(0);
    const level = WORLD.waterLevel + 0.06;
    let worst = 0;
    let sum = 0;
    let count = 0;
    for (const chain of chains) {
      expect(chain.length).toBeGreaterThanOrEqual(8);
      for (const p of chain) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.z)).toBe(true);
        const err = Math.abs(WORLD.heightAt(p.x, p.z) - level);
        worst = Math.max(worst, err);
        sum += err;
        count++;
      }
    }
    expect(worst).toBeLessThan(0.7); // linear interpolation across a cell
    expect(sum / count).toBeLessThan(0.2);
  });

  it("the main chain wraps the whole landmass (long, and roughly closed)", () => {
    const main = chains[0];
    expect(main.length).toBeGreaterThan(40);
    const first = main[0];
    const last = main[main.length - 1];
    expect(Math.hypot(first.x - last.x, first.z - last.z)).toBeLessThan(3);
  });

  it("consecutive points are close together (chained, not scrambled)", () => {
    for (const chain of chains) {
      for (let i = 1; i < chain.length; i++) {
        const d = Math.hypot(chain[i].x - chain[i - 1].x, chain[i].z - chain[i - 1].z);
        expect(d).toBeLessThan(2.5);
      }
    }
  });
});

describe("render/terrain foamMotion", () => {
  it("is deterministic, offset wraps to [0,1), opacity stays gentle", () => {
    for (const t of [0, 0.5, 3.7, 100.2, 12345]) {
      const m = foamMotion(t, 0.25);
      expect(foamMotion(t, 0.25)).toEqual(m);
      expect(m.offset).toBeGreaterThanOrEqual(0);
      expect(m.offset).toBeLessThan(1);
      expect(m.opacity).toBeGreaterThan(0.2);
      expect(m.opacity).toBeLessThan(0.8);
    }
  });

  it("animates: offset and opacity change over time", () => {
    expect(foamMotion(1).offset).not.toBe(foamMotion(2).offset);
    expect(foamMotion(0.4).opacity).not.toBe(foamMotion(1.9).opacity);
  });
});

describe("render/props cottagePalette", () => {
  const palette = { primary: "#f8a7c0", accent: "#7c4a6b" };

  it("is deterministic and covers every part", () => {
    const p = cottagePalette(palette, false);
    expect(cottagePalette(palette, false)).toEqual(p);
    for (const part of ["wall", "trim", "roof", "ridge", "door", "frame", "plinth", "chimney", "glow"]) {
      expect(Number.isFinite(p[part])).toBe(true);
    }
  });

  it("trim is darker than the wall (visible corner posts)", () => {
    for (const dark of [false, true]) {
      const p = cottagePalette(palette, dark);
      expect(luminance(p.trim)).toBeLessThan(luminance(p.wall));
    }
  });

  it("dark variant is dimmer, with a warm window glow against the cold blues", () => {
    const day = cottagePalette(palette, false);
    const night = cottagePalette(palette, true);
    expect(luminance(night.wall)).toBeLessThan(luminance(day.wall));
    expect(luminance(night.roof)).toBeLessThan(luminance(day.roof));
    const dayGlow = hexToRgb(day.glow);
    const nightGlow = hexToRgb(night.glow);
    expect(dayGlow.r).toBeGreaterThan(dayGlow.b); // warm lamplight
    // the quarter is permanent night: its windows are the warm counterpoint
    // to the moonlit palette (readable, homely, never icy-on-icy)
    expect(nightGlow.r).toBeGreaterThan(nightGlow.b);
  });

  it("tints with the keeper's palette and survives a missing one", () => {
    const pink = cottagePalette({ primary: "#f8a7c0" });
    const blue = cottagePalette({ primary: "#7ca7f8" });
    expect(pink.wall).not.toBe(blue.wall);
    expect(() => cottagePalette(undefined)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// New-world helpers: coast steepness (beach vs cliff), contour/wear shading,
// grass tuft tiers
// ---------------------------------------------------------------------------
import { coastSteepness } from "../src/render/terrain.js";

describe("render/terrain coastSteepness", () => {
  it("reads ~0 on a flat beach shelf", () => {
    const flat = { heightAt: () => 0.1 };
    expect(coastSteepness(flat, 3, 4)).toBe(0);
  });

  it("reads the drop on a cliff and scales with the gradient", () => {
    const gentle = { heightAt: (x) => x * 0.1 };
    const cliff = { heightAt: (x) => x * 0.9 };
    expect(coastSteepness(gentle, 0, 0)).toBeCloseTo(0.1, 5);
    expect(coastSteepness(cliff, 0, 0)).toBeCloseTo(0.9, 5);
    expect(coastSteepness(cliff, 0, 0)).toBeGreaterThan(coastSteepness(gentle, 0, 0));
  });

  it("splits the reference look: the real world has both beachy and rocky coast", () => {
    const chains = extractShoreline(WORLD);
    let beachy = 0;
    let rocky = 0;
    for (const p of chains[0]) {
      if (coastSteepness(WORLD, p.x, p.z) >= 0.34) rocky++;
      else beachy++;
    }
    expect(beachy).toBeGreaterThan(0);
    expect(rocky).toBeGreaterThan(0);
  });
});

describe("render/terrain macroShade contour + wear", () => {
  const base = { grain: 0.5, mottle: 0.5 };

  it("contour lines darken every channel (terrace hinting)", () => {
    const plain = macroShade(base);
    const lined = macroShade({ ...base, contourW: 1 });
    expect(lined[0]).toBeLessThan(plain[0]);
    expect(lined[1]).toBeLessThan(plain[1]);
    expect(lined[2]).toBeLessThan(plain[2]);
  });

  it("worn dirt warms and de-greens (trodden ground near doors)", () => {
    const plain = macroShade(base);
    const worn = macroShade({ ...base, wearW: 1 });
    expect(worn[0]).toBeGreaterThan(plain[0]); // warmer
    expect(worn[2]).toBeLessThan(plain[2]); // less blue
    expect(worn[1] - plain[1]).toBeLessThan(0); // less green
  });

  it("still clamps to [0,1] with everything maxed", () => {
    const c = macroShade({ grain: 1, mottle: 1, flowerW: 1, mossW: 1, contourW: 1, wearW: 1 });
    for (const v of c) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("render/terrain grass tuft tiers (small dense tufts, not giant blades)", () => {
  const tufts = grassPlacements(WORLD, { count: 400, seed: 5 });

  it("carries a tier per tuft and all three tiers appear", () => {
    const tiers = new Set(tufts.map((t) => t.tier));
    expect(tiers.has(0)).toBe(true);
    expect(tiers.has(1)).toBe(true);
    expect(tiers.has(2)).toBe(true);
  });

  it("small filler tufts outnumber tall accents, and accents are bigger", () => {
    const small = tufts.filter((t) => t.tier === 0);
    const tall = tufts.filter((t) => t.tier === 2);
    expect(small.length).toBeGreaterThan(tall.length);
    const avg = (list) => list.reduce((s, t) => s + t.scale, 0) / list.length;
    expect(avg(tall)).toBeGreaterThan(avg(small) * 1.5);
  });

  it("default density is a dense meadow (thousands, still bounded)", () => {
    const dense = grassPlacements(WORLD);
    expect(dense.length).toBeGreaterThan(1500);
    expect(dense.length).toBeLessThanOrEqual(2300);
  });
});

// ---------------------------------------------------------------------------
// Dithered material transitions (owner: "too sudden edges")
// ---------------------------------------------------------------------------

describe("render/terrain groundShade dither (soft organic borders)", () => {
  const base = { height: 0.4, slope: 0.05, streetW: 0, hubW: 0, nightW: 0, tone: 0.5, waterLevel: 0 };

  it("default dither reproduces the undithered shade", () => {
    expect(groundShade(base)).toEqual(groundShade({ ...base, dither: 0.5 }));
  });

  it("dither moves the grass-sand border (same height, different mix)", () => {
    // height inside the grass-sand transition band
    const a = groundShade({ ...base, height: 0.4, dither: 0.1 });
    const b = groundShade({ ...base, height: 0.4, dither: 0.9 });
    expect(a).not.toEqual(b);
    // both remain valid colors
    for (const c of [a, b]) for (const v of c) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("dither also softens street and plaza edges (partial weights differ)", () => {
    const street = { ...base, height: 1.2, streetW: 0.4 };
    expect(groundShade({ ...street, dither: 0.15 })).not.toEqual(groundShade({ ...street, dither: 0.85 }));
    const hub = { ...base, height: 1.2, hubW: 0.4 };
    expect(groundShade({ ...hub, dither: 0.15 })).not.toEqual(groundShade({ ...hub, dither: 0.85 }));
  });

  it("far from any border the dither changes nothing", () => {
    const deepGrass = { ...base, height: 2.5 };
    expect(groundShade({ ...deepGrass, dither: 0 })).toEqual(groundShade({ ...deepGrass, dither: 1 }));
  });
});

describe("render/terrain macroShade sandW (texel-level beach dither)", () => {
  it("sand texels warm up and de-blue", () => {
    const plain = macroShade({ grain: 0.5, mottle: 0.5 });
    const sandy = macroShade({ grain: 0.5, mottle: 0.5, sandW: 1 });
    expect(sandy[0]).toBeGreaterThan(plain[0]);
    expect(sandy[1]).toBeGreaterThan(plain[1]);
    expect(sandy[0] - plain[0]).toBeGreaterThan(sandy[2] - plain[2]);
  });

  it("still clamps with sandW maxed alongside everything else", () => {
    const c = macroShade({ grain: 1, mottle: 1, flowerW: 1, mossW: 1, contourW: 1, wearW: 1, sandW: 1 });
    for (const v of c) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
