// Shelf-view 2D pan (src/render/shelf_pan.js): pure logic, no DOM, no three.
import { describe, expect, it } from "vitest";
import {
  applyDrag,
  clampOffset,
  createShelfPan,
  panLimits,
  worldPerPixel,
} from "../src/render/shelf_pan.js";
import { SHELF_LAYOUT } from "../src/render/scene_interior.js";

const layout = SHELF_LAYOUT;

describe("panLimits", () => {
  it("is zero when the whole case fits the viewport (wide screen, far framing)", () => {
    const lim = panLimits({ layout, distance: 6, aspect: 16 / 9 });
    expect(lim).toEqual({ maxU: 0, maxV: 0 });
  });

  it("opens up on small screens: a narrow close framing overflows on both axes", () => {
    const lim = panLimits({ layout, distance: 1.1, aspect: 9 / 16 });
    expect(lim.maxU).toBeGreaterThan(0);
    expect(lim.maxV).toBeGreaterThan(0);
  });

  it("overflow equals case half-extent minus visible half-extent", () => {
    const distance = 1.2;
    const fovDeg = 50;
    const lim = panLimits({ layout, distance, fovDeg, aspect: 1 });
    const halfVisible = Math.tan((fovDeg * Math.PI) / 360) * distance;
    const halfCaseW = layout.shelfWidth / 2 + 0.3;
    expect(lim.maxU).toBeCloseTo(Math.max(0, halfCaseW - halfVisible));
  });

  it("degrades safely on junk input", () => {
    expect(panLimits({})).toEqual({ maxU: 0, maxV: 0 });
    expect(panLimits({ layout, distance: 0 })).toEqual({ maxU: 0, maxV: 0 });
  });
});

describe("worldPerPixel", () => {
  it("matches the vertical FOV footprint", () => {
    const wpp = worldPerPixel({ distance: 2, fovDeg: 50, viewportH: 800 });
    expect(wpp).toBeCloseTo((2 * 2 * Math.tan((50 * Math.PI) / 360)) / 800);
  });

  it("is zero on junk input", () => {
    expect(worldPerPixel({})).toBe(0);
    expect(worldPerPixel({ distance: 2, viewportH: 0 })).toBe(0);
  });
});

describe("clampOffset", () => {
  it("clamps both axes symmetrically", () => {
    const lim = { maxU: 0.5, maxV: 0.2 };
    expect(clampOffset({ u: 2, v: -3 }, lim)).toEqual({ u: 0.5, v: -0.2 });
    expect(clampOffset({ u: -0.1, v: 0.1 }, lim)).toEqual({ u: -0.1, v: 0.1 });
  });

  it("pins to zero when there is no overflow", () => {
    expect(clampOffset({ u: 9, v: 9 }, { maxU: 0, maxV: 0 })).toEqual({ u: 0, v: 0 });
  });
});

describe("createShelfPan drag machine", () => {
  it("a press that never crosses the threshold stays a click", () => {
    const pan = createShelfPan({ thresholdPx: 4 });
    pan.down(100, 100);
    expect(pan.move(101, 101)).toBeNull();
    expect(pan.dragging).toBe(false);
    expect(pan.up()).toEqual({ wasDrag: false });
  });

  it("crossing the threshold starts the drag and reports deltas from there", () => {
    const pan = createShelfPan({ thresholdPx: 4 });
    pan.down(100, 100);
    expect(pan.move(110, 100)).toEqual({ dx: 0, dy: 0 }); // arms without a jump
    expect(pan.move(115, 98)).toEqual({ dx: 5, dy: -2 });
    expect(pan.dragging).toBe(true);
    expect(pan.up()).toEqual({ wasDrag: true }); // caller swallows the click
    expect(pan.dragging).toBe(false);
  });

  it("moves without a press, and after cancel, do nothing", () => {
    const pan = createShelfPan();
    expect(pan.move(50, 50)).toBeNull();
    pan.down(0, 0);
    pan.cancel();
    expect(pan.move(100, 100)).toBeNull();
    expect(pan.up()).toEqual({ wasDrag: false });
  });
});

describe("applyDrag", () => {
  const lim = { maxU: 1, maxV: 0.5 };

  it("content follows the pointer: drag right moves the camera left, drag down moves it up", () => {
    const next = applyDrag({ u: 0, v: 0 }, { dx: 10, dy: 20 }, { worldPerPx: 0.01, limits: lim });
    expect(next.u).toBeCloseTo(-0.1);
    expect(next.v).toBeCloseTo(0.2);
  });

  it("accumulates across moves and clamps at the overflow", () => {
    let off = { u: 0, v: 0 };
    for (let i = 0; i < 50; i++) {
      off = applyDrag(off, { dx: -10, dy: 30 }, { worldPerPx: 0.01, limits: lim });
    }
    expect(off).toEqual({ u: 1, v: 0.5 });
  });

  it("no overflow means no movement at all", () => {
    const off = applyDrag({ u: 0, v: 0 }, { dx: 300, dy: 300 }, {
      worldPerPx: 0.01,
      limits: { maxU: 0, maxV: 0 },
    });
    expect(off).toEqual({ u: 0, v: 0 });
  });
});
