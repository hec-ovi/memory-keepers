// Minimap: pure projection math plus the mounted panel (RTL through jsdom;
// the 2d context is stubbed with a recording fake since jsdom has no canvas
// backend).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, within } from "@testing-library/dom";
import { createBus } from "../src/bus.js";
import { config } from "../src/config.js";
import { layoutWorld } from "../src/sim/world.js";
import {
  computeMapBounds,
  makeProjector,
  wedgePoints,
  pingState,
  PING_MS,
  COAST_MARGIN,
  COAST_GRID,
  sampleLandMask,
  maskToRgba,
  createMinimap,
} from "../src/ui/minimap.js";
import { dreamsKeeper, meetingsKeeper, unconsciousKeeper, makeState } from "./ui_fixtures.js";

const ISLES = {
  main: { center: { x: 0, z: 0 }, radius: 14 },
  unconscious: { center: { x: -34, z: -26 }, radius: 10 },
};

describe("minimap projection math", () => {
  it("computeMapBounds covers every isle plus the margin", () => {
    const b = computeMapBounds(ISLES, 2);
    expect(b).toEqual({ minX: -46, maxX: 16, minZ: -38, maxZ: 16 });
  });

  it("computeMapBounds falls back to a default box for no isles", () => {
    const b = computeMapBounds({});
    expect(b.maxX).toBeGreaterThan(b.minX);
    expect(b.maxZ).toBeGreaterThan(b.minZ);
  });

  it("toWorld is the exact inverse of toCanvas", () => {
    const proj = makeProjector(computeMapBounds(ISLES), 190, 158);
    for (const [x, z] of [[0, 0], [-34, -26], [10.5, -3.2], [-46, 16]]) {
      const c = proj.toCanvas(x, z);
      const w = proj.toWorld(c.x, c.y);
      expect(w.x).toBeCloseTo(x, 9);
      expect(w.z).toBeCloseTo(z, 9);
    }
  });

  it("uses one uniform scale (aspect preserved) and stays inside the padding", () => {
    const bounds = computeMapBounds(ISLES);
    const proj = makeProjector(bounds, 190, 158, 8);
    const dx = proj.toCanvas(1, 0).x - proj.toCanvas(0, 0).x;
    const dy = proj.toCanvas(0, 1).y - proj.toCanvas(0, 0).y;
    expect(dx).toBeCloseTo(dy, 9);
    expect(dx).toBeCloseTo(proj.scale, 9);
    for (const [x, z] of [
      [bounds.minX, bounds.minZ],
      [bounds.maxX, bounds.maxZ],
    ]) {
      const c = proj.toCanvas(x, z);
      expect(c.x).toBeGreaterThanOrEqual(7.999);
      expect(c.x).toBeLessThanOrEqual(182.001);
      expect(c.y).toBeGreaterThanOrEqual(7.999);
      expect(c.y).toBeLessThanOrEqual(150.001);
    }
  });

  it("wedgePoints fans symmetric edges around the look angle", () => {
    const [apex, left, right] = wedgePoints({ x: 3, z: -2, angle: 0 }, { length: 9, halfAngle: 0.4 });
    expect(apex).toEqual({ x: 3, z: -2 });
    // angle 0 looks along +z: edges are ahead of the apex, mirrored in x.
    expect(left.z).toBeGreaterThan(apex.z);
    expect(right.z).toBeGreaterThan(apex.z);
    expect(left.x - apex.x).toBeCloseTo(-(right.x - apex.x), 9);
    expect(Math.hypot(left.x - apex.x, left.z - apex.z)).toBeCloseTo(9, 9);
  });

  it("pingState: the ring expands, fades, and finishes after PING_MS", () => {
    const start = pingState(0);
    const mid = pingState(PING_MS / 2);
    const end = pingState(PING_MS);
    expect(start.radius).toBeLessThan(mid.radius);
    expect(mid.radius).toBeLessThan(end.radius);
    expect(start.alpha).toBeGreaterThan(mid.alpha);
    expect(mid.alpha).toBeGreaterThan(end.alpha);
    expect(start.done).toBe(false);
    expect(mid.done).toBe(false);
    expect(end.done).toBe(true);
    expect(end.alpha).toBeCloseTo(0, 9);
  });
});

describe("coastline mask (pure)", () => {
  const world = layoutWorld([]);
  const bounds = computeMapBounds(world.isles, COAST_MARGIN);
  const mask = sampleLandMask(world, bounds);

  // grid index of the cell containing a world point
  const cellAt = (x, z) => {
    const i = Math.min(
      mask.cols - 1,
      Math.floor(((x - bounds.minX) / (bounds.maxX - bounds.minX)) * mask.cols),
    );
    const j = Math.min(
      mask.rows - 1,
      Math.floor(((z - bounds.minZ) / (bounds.maxZ - bounds.minZ)) * mask.rows),
    );
    return j * mask.cols + i;
  };

  it("marks both district cores as land and the frame corners as water", () => {
    const day = world.isles.main.center;
    const night = world.isles.unconscious.center;
    expect(mask.cols).toBe(COAST_GRID.cols);
    expect(mask.rows).toBe(COAST_GRID.rows);
    expect(mask.land[cellAt(day.x, day.z)]).toBe(1);
    expect(mask.land[cellAt(night.x, night.z)]).toBe(1);
    expect(mask.land[0]).toBe(0); // top-left corner: open water
    expect(mask.land[mask.cols * mask.rows - 1]).toBe(0); // bottom-right
  });

  it("is the real irregular coastline, not the two perfect circles", () => {
    const day = world.isles.main;
    const night = world.isles.unconscious;
    let mismatches = 0;
    for (let j = 0; j < mask.rows; j++) {
      const z = bounds.minZ + ((j + 0.5) / mask.rows) * (bounds.maxZ - bounds.minZ);
      for (let i = 0; i < mask.cols; i++) {
        const x = bounds.minX + ((i + 0.5) / mask.cols) * (bounds.maxX - bounds.minX);
        const inCircles =
          Math.hypot(x - day.center.x, z - day.center.z) <= day.radius ||
          Math.hypot(x - night.center.x, z - night.center.z) <= night.radius
            ? 1
            : 0;
        if (mask.land[j * mask.cols + i] !== inCircles) mismatches++;
      }
    }
    // bays, headlands and the land neck: plenty of cells disagree with the
    // old silhouette discs
    expect(mismatches).toBeGreaterThan(60);
  });

  it("carries the night blend for district tints", () => {
    const day = world.isles.main.center;
    const night = world.isles.unconscious.center;
    expect(mask.night[cellAt(day.x, day.z)]).toBeLessThan(0.1);
    expect(mask.night[cellAt(night.x, night.z)]).toBeGreaterThan(0.9);
  });

  it("maskToRgba: water transparent, village green, unconscious quarter purple", () => {
    const rgba = maskToRgba(mask);
    expect(rgba.length).toBe(mask.cols * mask.rows * 4);
    expect(rgba[3]).toBe(0); // water corner: alpha 0

    const day = cellAt(world.isles.main.center.x, world.isles.main.center.z) * 4;
    expect(rgba[day + 3]).toBe(255);
    expect(rgba[day + 1]).toBeGreaterThan(rgba[day + 2]); // green dominates blue

    const night =
      cellAt(world.isles.unconscious.center.x, world.isles.unconscious.center.z) * 4;
    expect(rgba[night + 3]).toBe(255);
    expect(rgba[night + 2]).toBeGreaterThan(rgba[night + 1]); // blue/purple over green
  });

});

describe("createMinimap panel", () => {
  let root, bus, state, minimap, fakeCtx, arcs;

  function makeFakeCtx() {
    arcs = [];
    return {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn((x, y, r) => arcs.push({ x, y, r })),
      fill: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      stroke: vi.fn(),
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
    };
  }

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
    bus = createBus();
    state = makeState([dreamsKeeper(), meetingsKeeper(), unconsciousKeeper()]);
    fakeCtx = makeFakeCtx();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(fakeCtx);
    minimap = createMinimap({ root, state, bus, config });
  });

  afterEach(() => {
    minimap.dispose();
    root.remove();
    vi.restoreAllMocks();
    document.getElementById("mk-minimap-style")?.remove();
  });

  const isleArcs = () => arcs.filter((a) => a.r > 10); // isles are big, dots tiny

  it("mounts a rounded panel with a canvas and one scoped style tag", () => {
    const panel = within(root).getByLabelText("minimap");
    expect(panel.querySelector("canvas")).toBeTruthy();
    const second = createMinimap({ root, state, bus, config });
    expect(document.querySelectorAll("#mk-minimap-style")).toHaveLength(1);
    second.dispose();
  });

  it("falls back to the two district discs when the host has no ImageData", () => {
    // the default fake ctx has no createImageData/putImageData/drawImage
    expect(isleArcs()).toHaveLength(2); // village + unconscious quarter
  });

  it("draws the irregular coastline mask (not circles) when ImageData works", () => {
    minimap.dispose();
    fakeCtx = makeFakeCtx();
    fakeCtx.createImageData = vi.fn((w, h) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }));
    fakeCtx.putImageData = vi.fn();
    fakeCtx.drawImage = vi.fn();
    HTMLCanvasElement.prototype.getContext.mockReturnValue(fakeCtx);
    minimap = createMinimap({ root, state, bus, config });

    // the offscreen mask was rasterized once and painted scaled-up
    expect(fakeCtx.putImageData).toHaveBeenCalledTimes(1);
    const [imgCols, imgRows] = fakeCtx.createImageData.mock.calls[0];
    expect(imgCols).toBe(COAST_GRID.cols);
    expect(imgRows).toBe(COAST_GRID.rows);
    expect(fakeCtx.drawImage).toHaveBeenCalled();
    const [src, dx, dy, dw, dh] = fakeCtx.drawImage.mock.calls[0];
    expect(src instanceof HTMLCanvasElement).toBe(true);
    expect(dw).toBeGreaterThan(100); // scaled up to (nearly) the map footprint
    expect(dh).toBeGreaterThan(100);
    expect(Number.isFinite(dx)).toBe(true);
    expect(Number.isFinite(dy)).toBe(true);
    // and no silhouette discs anymore
    expect(isleArcs()).toHaveLength(0);
  });

  it("draws every street polyline, including the ridge road", () => {
    const layout = layoutWorld(state.keepers);
    const streets = (layout.streets ?? []).filter((s) => (s.points ?? []).length >= 2);
    expect(streets.some((s) => s.id === "ridge")).toBe(true);
    // one moveTo per street polyline (plus one for the wedge when a camera
    // is live; none here)
    expect(fakeCtx.moveTo.mock.calls.length).toBeGreaterThanOrEqual(streets.length);
    expect(fakeCtx.lineTo).toHaveBeenCalled();
  });

  it("draws a faint ring on every empty (undiscovered) plot site", () => {
    const layout = layoutWorld(state.keepers);
    const empty = layout.plots.filter((p) => !p.occupied);
    expect(empty.length).toBeGreaterThan(0); // 24 plots, 3 keepers
    // Small stroked arcs (r ~2): below the keeper-dot radius (2.4), far
    // smaller than the isles; no camera or live keepers on the initial draw.
    const rings = arcs.filter((a) => a.r >= 1.4 && a.r <= 2.2);
    expect(rings.length).toBe(empty.length);
  });

  it("click paints a ping ring at the click point", () => {
    const canvas = root.querySelector(".mk-minimap canvas");
    canvas.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 190,
      height: 158,
      right: 190,
      bottom: 158,
    });
    arcs.length = 0;
    fireEvent.click(canvas, { clientX: 60, clientY: 40 });
    const r0 = pingState(0).radius;
    const ring = arcs.find((a) => Math.abs(a.x - 60) < 1.5 && Math.abs(a.y - 40) < 1.5 && a.r >= r0);
    expect(ring).toBeTruthy();
  });

  it("redraws keeper dots and the camera wedge on minimap:update", () => {
    arcs.length = 0;
    fakeCtx.closePath.mockClear();
    bus.emit("minimap:update", {
      keepers: [
        { id: "dreams", x: 1, z: 2 },
        { id: "meetings", x: -3, z: 4 },
      ],
      camera: { x: 10, z: 12, angle: 1.2 },
    });
    const dots = arcs.filter((a) => a.r < 10 && a.r > 2.2); // keeper dots (r 2.4)
    expect(dots.length).toBe(2);
    expect(fakeCtx.closePath).toHaveBeenCalled(); // the frustum wedge polygon
  });

  it("click emits minimap:jump with the mapped world position", () => {
    const canvas = root.querySelector(".mk-minimap canvas");
    canvas.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 190,
      height: 158,
      right: 190,
      bottom: 158,
    });
    const jumps = [];
    bus.on("minimap:jump", (p) => jumps.push(p));

    fireEvent.click(canvas, { clientX: 95, clientY: 79 });

    const layout = layoutWorld(state.keepers);
    const proj = makeProjector(computeMapBounds(layout.isles, COAST_MARGIN), 190, 158);
    const expected = proj.toWorld(95, 79);
    expect(jumps).toHaveLength(1);
    expect(jumps[0].x).toBeCloseTo(expected.x, 6);
    expect(jumps[0].z).toBeCloseTo(expected.z, 6);
  });

  it("hides outside the overworld and comes back", () => {
    const panel = within(root).getByLabelText("minimap");
    expect(panel.style.display).toBe("");
    bus.emit("mode:changed", { mode: "interior:dreams" });
    expect(panel.style.display).toBe("none");
    bus.emit("mode:changed", { mode: "overworld" });
    expect(panel.style.display).toBe("");
  });

  it("dispose removes the panel and stops listening", () => {
    minimap.dispose();
    expect(within(root).queryByLabelText("minimap")).toBeNull();
    const before = arcs.length;
    bus.emit("minimap:update", { keepers: [{ id: "dreams", x: 0, z: 0 }], camera: null });
    expect(arcs.length).toBe(before); // no redraws after dispose
    minimap = createMinimap({ root, state, bus, config }); // for afterEach
  });
});
