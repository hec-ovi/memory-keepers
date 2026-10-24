// Shelf-view 2D pan: pure logic for dragging the bookcase close-up around on
// x/y (screen plane) so small screens can reach every spine. No zoom, no
// depth, no rotation: the camera trucks parallel to the wall, position and
// lookAt move together, and the offset is clamped to the case's overflow
// (when the whole case fits the viewport there is nothing to pan).
//
// No three.js and no DOM in here: scene_interior.js owns the wiring (pointer
// events in, camera offsets out). See CONTRACT.md.

// How much the framed bookcase overflows the viewport at `distance`, as the
// max camera offset per axis (world units, +/- around the framing center).
// `u` runs along the wall (the screen's x), `v` is vertical.
export function panLimits({
  layout,
  distance,
  fovDeg = 50,
  aspect = 16 / 9,
  bookH = 0.46,
  margin = 0.3,
} = {}) {
  if (!layout || !(distance > 0)) return { maxU: 0, maxV: 0 };
  const tanV = Math.tan((fovDeg * Math.PI) / 360);
  const halfVisibleH = tanV * distance;
  const halfVisibleW = halfVisibleH * Math.max(0.1, aspect);
  const halfCaseW = layout.shelfWidth / 2 + margin;
  const halfCaseH =
    ((layout.shelvesPerWall - 1) * layout.shelfGapY + bookH) / 2 + margin;
  return {
    maxU: Math.max(0, halfCaseW - halfVisibleW),
    maxV: Math.max(0, halfCaseH - halfVisibleH),
  };
}

// World units covered by one screen pixel at `distance` (vertical FOV).
export function worldPerPixel({ distance, fovDeg = 50, viewportH = 800 } = {}) {
  if (!(distance > 0) || !(viewportH > 0)) return 0;
  return (2 * distance * Math.tan((fovDeg * Math.PI) / 360)) / viewportH;
}

export function clampOffset(offset = {}, limits = {}) {
  const clamp = (v, m) => {
    const c = Math.max(-(m ?? 0), Math.min(m ?? 0, v ?? 0));
    return c === 0 ? 0 : c; // normalize -0 away
  };
  return { u: clamp(offset.u, limits.maxU), v: clamp(offset.v, limits.maxV) };
}

// Drag state machine. A press is only a pan once the pointer travels past
// `thresholdPx`, so ordinary clicks (picking a book) stay clicks; after a
// real drag, `up()` reports it so the caller can swallow the click event.
//
//   down(x, y)      press started
//   move(x, y)      -> null before the threshold, {dx, dy} once dragging
//                      (pixel deltas since the previous move)
//   up() / cancel() -> { wasDrag }
export function createShelfPan({ thresholdPx = 4 } = {}) {
  let state = "idle"; // idle | pending | dragging
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;

  return {
    get dragging() {
      return state === "dragging";
    },
    down(x, y) {
      state = "pending";
      startX = lastX = x;
      startY = lastY = y;
    },
    move(x, y) {
      if (state === "idle") return null;
      if (state === "pending") {
        if (Math.hypot(x - startX, y - startY) < thresholdPx) return null;
        state = "dragging";
        lastX = x;
        lastY = y;
        return { dx: 0, dy: 0 };
      }
      const delta = { dx: x - lastX, dy: y - lastY };
      lastX = x;
      lastY = y;
      return delta;
    },
    up() {
      const wasDrag = state === "dragging";
      state = "idle";
      return { wasDrag };
    },
    cancel() {
      state = "idle";
    },
  };
}

// Pixel drag -> clamped world offset, content-follows-pointer: dragging right
// slides the case right (camera trucks left), dragging down pulls the case
// down (camera rises). `offset` is {u, v} with u along the screen's x axis;
// the caller maps u onto the wall's world axis (z, sign by wall side).
export function applyDrag(offset, delta, { worldPerPx = 0, limits } = {}) {
  const next = {
    u: (offset?.u ?? 0) - (delta?.dx ?? 0) * worldPerPx,
    v: (offset?.v ?? 0) + (delta?.dy ?? 0) * worldPerPx,
  };
  return clampOffset(next, limits ?? { maxU: Infinity, maxV: Infinity });
}
