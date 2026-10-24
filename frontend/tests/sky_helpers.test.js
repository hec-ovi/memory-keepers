// Pure cloud-layout math from render/sky.js: deterministic cumulus clusters
// over the day village (with shadows) and wisps over the night quarter, at
// heights that sit in frame from the play camera.
import { describe, it, expect } from "vitest";
import { cloudLayout, cloudProximityFade, drawCumulusPuff } from "../src/render/sky.js";
import { layoutWorld } from "../src/sim/world.js";

const keeper = (id, kind = "conscious") => ({ id, kind });
const WORLD = layoutWorld([keeper("dreams"), keeper("music"), keeper("fear-of-heights", "unconscious")]);

describe("render/sky cloudLayout", () => {
  const clusters = cloudLayout({ world: WORLD, seed: 11, cumulus: 7, wisps: 5 });

  it("is deterministic per seed", () => {
    expect(cloudLayout({ world: WORLD, seed: 11, cumulus: 7, wisps: 5 })).toEqual(clusters);
    expect(cloudLayout({ world: WORLD, seed: 12, cumulus: 7, wisps: 5 })).not.toEqual(clusters);
  });

  it("returns the requested mix of cumulus and wisps", () => {
    expect(clusters.filter((c) => c.kind === "cumulus")).toHaveLength(7);
    expect(clusters.filter((c) => c.kind === "wisp")).toHaveLength(5);
  });

  it("flies HIGH: well above the village paths, still in frame", () => {
    for (const c of clusters) {
      expect(c.y).toBeGreaterThanOrEqual(20); // never sits heavy over the streets
      expect(c.y).toBeLessThanOrEqual(32); // in frame at the down-looking pitch
    }
  });

  it("is sparse, slow and translucent (soft sky, not fog banks)", () => {
    const defaults = cloudLayout({ world: WORLD });
    expect(defaults.filter((c) => c.kind === "cumulus").length).toBeLessThanOrEqual(6);
    expect(defaults.filter((c) => c.kind === "wisp").length).toBeLessThanOrEqual(4);
    for (const c of defaults) {
      expect(c.drift).toBeLessThanOrEqual(0.3); // slow drift
      for (const p of c.puffs) {
        expect(p.o).toBeLessThanOrEqual(0.5); // light opacity
      }
    }
  });

  it("cumulus hang over the day side, wisps over the night quarter", () => {
    const day = WORLD.sectors.day;
    const night = WORLD.sectors.night;
    for (const c of clusters) {
      if (c.kind === "cumulus") {
        expect(Math.abs(c.x - day.center.x)).toBeLessThanOrEqual(day.radius * 1.6);
        expect(Math.abs(c.z - day.center.z)).toBeLessThanOrEqual(day.radius * 1.3);
        expect(c.shadow).toBe(true);
      } else {
        expect(Math.abs(c.x - night.center.x)).toBeLessThanOrEqual(night.radius * 1.6);
        expect(Math.abs(c.z - night.center.z)).toBeLessThanOrEqual(night.radius * 1.4);
        expect(c.shadow).toBe(false);
      }
    }
  });

  it("every cluster has drawable puffs and a sane drift/wrap range", () => {
    for (const c of clusters) {
      expect(c.puffs.length).toBeGreaterThanOrEqual(2);
      for (const p of c.puffs) {
        expect(p.w).toBeGreaterThan(0);
        expect(p.o).toBeGreaterThan(0);
        expect(p.o).toBeLessThanOrEqual(1);
      }
      expect(c.drift).toBeGreaterThan(0);
      expect(c.wrapMin).toBeLessThan(c.wrapMax);
      expect(c.x).toBeGreaterThanOrEqual(c.wrapMin);
      expect(c.x).toBeLessThanOrEqual(c.wrapMax);
    }
  });
});

describe("render/sky cloudProximityFade", () => {
  it("is fully visible far away and fully hidden at the cluster center", () => {
    expect(cloudProximityFade(100, 8)).toBe(1);
    expect(cloudProximityFade(0, 8)).toBe(0);
    // Camera sitting inside the sprite footprint: still hidden.
    expect(cloudProximityFade(6, 8)).toBe(0);
  });

  it("eases monotonically between the near and far edges", () => {
    let prev = -1;
    for (let d = 0; d <= 20; d += 0.5) {
      const f = cloudProximityFade(d, 8);
      expect(f).toBeGreaterThanOrEqual(prev);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
      prev = f;
    }
  });
});

describe("render/sky drawCumulusPuff (soft radial sprites)", () => {
  // Recording stub of a 2d context: remembers every gradient's stops, the
  // gradient geometry, and which composite mode each fillRect ran under.
  function stubCtx() {
    const rects = [];
    const gradients = [];
    const ctx = {
      globalCompositeOperation: "source-over",
      fillStyle: null,
      createRadialGradient(x0, y0, r0, x1, y1, r1) {
        const g = { x0, y0, r0, x1, y1, r1, stops: [] };
        gradients.push(g);
        return {
          addColorStop(offset, color) {
            g.stops.push({ offset, color });
          },
        };
      },
      createLinearGradient() {
        const g = { linear: true, stops: [] };
        gradients.push(g);
        return {
          addColorStop(offset, color) {
            g.stops.push({ offset, color });
          },
        };
      },
      fillRect(x, y, w, h) {
        rects.push({ x, y, w, h, op: this.globalCompositeOperation });
      },
    };
    return { ctx, rects, gradients };
  }

  const alphaOf = (color) => {
    const m = /rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)/.exec(color);
    return m ? Number(m[1]) : 1;
  };

  it("uses only soft radial gradients that fade to fully transparent", () => {
    const { ctx, rects, gradients } = stubCtx();
    drawCumulusPuff(ctx, 256, 256);
    expect(gradients.length).toBeGreaterThanOrEqual(2);
    for (const g of gradients) {
      expect(g.linear).toBeUndefined(); // radial only, no base band
      const last = g.stops[g.stops.length - 1];
      expect(last.offset).toBe(1);
      expect(alphaOf(last.color)).toBe(0); // no rim, ever
      // gentle center: translucent, not a hot white core
      expect(alphaOf(g.stops[0].color)).toBeLessThanOrEqual(0.5);
      // the gradient radius stays inside the canvas: the falloff finishes
      // before the sprite edge (no cropped rectangle)
      expect(g.x1 + g.r1).toBeLessThanOrEqual(256);
      expect(g.y1 + g.r1).toBeLessThanOrEqual(256);
    }
    // no compositing tricks anywhere
    for (const r of rects) expect(r.op).toBe("source-over");
    expect(ctx.globalCompositeOperation).toBe("source-over");
  });
});
