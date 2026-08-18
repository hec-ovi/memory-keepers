// Interior scene: the keeper's cozy library home. The 3D books ARE the
// interface (no side-panel list): shelves line two walls, one spine mesh per
// book with the title drawn on a canvas texture, colored by tag hash and
// sized by one_liner length. Hovering a book slides it out and shows a small
// floating label (full title + date, a DOM overlay following the camera
// projection); clicking it sends the keeper to fetch it: she hops off her
// armchair, walks to the shelf, the book floats out and "book:open" fires.
// She waits by the shelf until the reader closes ("reader:closed"), then the
// book returns and she walks back to her chair.
//
// The room matches the exterior cottages: plank floor + round rug (procedural
// canvas textures), wallpaper walls with wainscot trim, a ceiling with a
// beam, a window showing the district's sky (day for conscious keepers, moonlit
// night for unconscious ones), a warm reading lamp, a flickering fireplace,
// side table + teacup, a plant, floor clutter. The keeper is the same
// createKeeperMesh blob as outside, sitting on the chair with a gentle cushion
// squash, idle breathing and blinks.
//
//   const scene = createInteriorScene({ state, bus, api, keeperId, renderer, camera, container });
//   scene.update(dt); scene.dispose();
//
// Called by main.js with { state, bus, api, config, container, ui, mode }; the
// keeperId falls out of mode ("interior:<keeperId>") or state.selectedKeeperId. When
// no renderer/camera are passed, the scene owns its own (canvas appended to
// container, removed on dispose).
//
// Bus wiring:
//   listens "reader:closed"                    -> book returns, keeper walks back;
//                                                 the pre-reader view is restored
//   listens "book:created" / "book:destroyed"  -> add / remove the book mesh
//   listens "interior:view" { view }           -> switch view (the holo buttons
//                                                 in ui/interior_views.js emit it)
//   listens "keeper:sleep"   { keeperId }          -> she returns to her chair and
//                                                 dozes (eyes closed, slow
//                                                 breathing, Zzz) until
//   listens "keeper:rested"  { keeperId }          -> she wakes rested (setTired 0)
//   listens "state:loaded"                     -> re-apply her tired level from
//                                                 keeper.session.status
//   emits   "interior:exit" on Esc from the settled main view (the nav
//                                              cluster's "Back to the island"
//                                              button emits it too, from
//                                              ui/interior_views.js)
//   emits   "book:open"     { keeperId, slug }   when the fetched book floats out
//   emits   "keeper:selected" { keeperId }         when the empty-library hint book
//                                              OR the keeper herself is clicked
//                                              (opens the same talk panel as
//                                              the overworld)
//
// Three clickable views ("main" | "chairs" | "shelf"): the two armchairs are
// a cozy pair angled toward one another, and the chairs view seats the camera
// IN the guest chair looking AT her (she faces the camera; gentle sitting
// sway); the shelf view dollies close to the bookcase so the spine titles
// are actually readable (the framing clamps to a legible distance and the
// spine canvases re-render at higher resolution for the close-up). Enter a
// view by clicking the guest chair or a bookcase (hover cursor + soft
// highlight), or with the holo nav cluster (ui/interior_views.js,
// bottom-right, top to bottom: Back to Keeper / Sit beside her / Bookshelf /
// Back to the island). "Back to Keeper" returns to main from any view; when
// main is already up it gently re-frames the camera on her. Esc returns to
// main first and only exits the interior from main. Camera tweens ~0.8 s
// (position + lookAt, eased); input is ignored mid-tween. Picking a book
// jumps to main for the fetch and the previous view is restored on
// "reader:closed".
//
// The bookcase holds exactly LIBRARY_CAP (24) slots: one full
// library IS the memory cap per keeper. Spine thickness scales into the slot
// (tierSizing) so shelves at capacity read visibly full. The room
// readout (ui/interior_views.js, bottom-left) shows her name, level, shelved
// count against LIBRARY_CAP and her rest in warm words.
//
// Pure helpers (unit-tested, no three.js state):
// spineColorFromTags, BOOK_TIERS, bookTier, tierSizing, shelfSlot,
// shelfCapacity, LIBRARY_CAP, contrastInk, spineLabelSpec,
// scaleSpineSpec, nextKeeperState, runKeeperTimeline, hopArc, labelPlacement,
// createViewMachine, viewRequest, viewStep, viewIsTweening, pickAction,
// projectedSizePx, shelfFontRatio, shelfLabelSizing, shelfViewFraming, DOZE,
// nextDozeState, runDozeTimeline, plus the
// chair/camera constants CHAIR_POS, CHAIR_ANGLE, SECOND_CHAIR, CHAIRS_POSE.

import * as THREE from "three";

import { hashString, mulberry32 } from "../sim/rand.js";
import { applyDrag, clampOffset, createShelfPan, panLimits, worldPerPixel } from "./shelf_pan.js";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (v) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

// Deterministic spine color from a book's tags (order-insensitive), kept in a
// pleasant saturation/lightness band so shelves look like shelves.
export function spineColorFromTags(tags = []) {
  const list = (Array.isArray(tags) ? tags : [tags])
    .map((t) => String(t).trim().toLowerCase())
    .filter(Boolean)
    .sort();
  const key = list.length ? list.join("|") : "untitled";
  const h = hashString(key);
  const hue = h % 360;
  const sat = 42 + ((h >>> 9) % 33); // 42..74
  const light = 38 + ((h >>> 17) % 22); // 38..59
  return hslToHex(hue, sat, light);
}

// Book size tiers: the engine reports how much corpus a book holds
// (summary.tier, library/CONTRACT.md); the shelf renders each tier at its own spine
// size so a fat transcript reads bigger than a one-line dream. Older
// payloads without the field fall back to the one_liner length.
export const BOOK_TIERS = Object.freeze(["small", "medium", "big", "large"]);

export function bookTier(book = {}) {
  if (BOOK_TIERS.includes(book?.tier)) return book.tier;
  const len = String(book?.one_liner ?? "").length;
  if (len >= 120) return "large";
  if (len >= 70) return "big";
  if (len >= 30) return "medium";
  return "small";
}

// The single bookcase holds exactly LIBRARY_CAP slots: ONE full library
// IS the memory cap per keeper. The backend pins the same number
// in library (mk_library/limits.py); the UI (room readout) imports it from here.
export const LIBRARY_CAP = 24;

export const SHELF_LAYOUT = Object.freeze({
  walls: 1, // one bookcase, on the left wall
  shelvesPerWall: 4,
  slotsPerShelf: 6, // 1 wall x 4 shelves x 6 slots = LIBRARY_CAP
  shelfWidth: 2.6, // usable run along the wall, world units
  shelfGapY: 0.72,
  firstShelfY: 0.72,
});

export function shelfCapacity(layout = SHELF_LAYOUT) {
  return layout.walls * layout.shelvesPerWall * layout.slotsPerShelf;
}

// Spine size per tier, scaled into the slot step. Fractions run well under
// the old fat 0.5..0.8 band (owner: books were too fat); "large" still fills
// most of its slot so a full shelf of tomes reads full, and height steps up
// with the tier so the four sizes are readable at a glance.
const TIER_STEP_FRACTION = Object.freeze({ small: 0.2, medium: 0.3, big: 0.42, large: 0.58 });
const TIER_HEIGHT_FACTOR = Object.freeze({ small: 0.82, medium: 0.9, big: 1.0, large: 1.08 });

export function tierSizing(tier, layout = SHELF_LAYOUT) {
  const t = BOOK_TIERS.includes(tier) ? tier : "medium";
  const step = layout.shelfWidth / layout.slotsPerShelf;
  return {
    thickness: step * TIER_STEP_FRACTION[t],
    height: BOOK_H * TIER_HEIGHT_FACTOR[t],
  };
}

// Deterministic slotting: fills shelf by shelf, wall by wall; wraps past
// capacity. `along` is the offset along the wall, centered on 0.
export function shelfSlot(index, layout = SHELF_LAYOUT) {
  const perWall = layout.shelvesPerWall * layout.slotsPerShelf;
  const capacity = perWall * layout.walls;
  const i = ((Math.floor(index) % capacity) + capacity) % capacity;
  const wall = Math.floor(i / perWall);
  const rest = i % perWall;
  const shelf = Math.floor(rest / layout.slotsPerShelf);
  const slot = rest % layout.slotsPerShelf;
  const step = layout.shelfWidth / layout.slotsPerShelf;
  const along = -layout.shelfWidth / 2 + step * (slot + 0.5);
  const y = layout.firstShelfY + shelf * layout.shelfGapY;
  return { wall, shelf, slot, along, y, step };
}

function hexChannels(hex) {
  let h = typeof hex === "number" ? hex : parseInt(String(hex).replace(/^#/, ""), 16);
  if (!Number.isFinite(h)) h = 0x888888;
  return { r: (h >> 16) & 0xff, g: (h >> 8) & 0xff, b: h & 0xff };
}

// High-contrast ink for text drawn over `bgHex`: dark ink on light spines,
// paper ink on dark spines. Gamma-space relative luminance is enough here.
export function contrastInk(bgHex) {
  const { r, g, b } = hexChannels(bgHex);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.52 ? "#2a1a33" : "#f6ecdf";
}

// Everything the spine canvas needs, derived deterministically from the book:
// canvas size in px (proportional to the spine's world dims so glyphs are not
// stretched), font size, ink/bg colors, and the title trimmed to fit.
export function spineLabelSpec(book = {}, { thickness = 0.1, height = 0.34, pxPerUnit = 560 } = {}) {
  const bg = spineColorFromTags(book.tags);
  const ink = contrastInk(bg);
  const w = Math.round(Math.min(Math.max(thickness * pxPerUnit, 36), 128));
  const h = Math.round(Math.min(Math.max(height * pxPerUnit, 120), 512));
  const raw = String(book.title ?? book.slug ?? "").trim() || "untitled";
  const usable = h - 18;
  // Fit: start from the width-derived size, shrink (down to a floor) until
  // the whole title fits along the spine, then truncate whatever remains.
  const CHAR_W = 0.58; // average glyph width as a fraction of the font size
  const fromWidth = w * 0.5;
  const fromLength = usable / (Math.max(1, raw.length) * CHAR_W);
  const fontPx = Math.floor(Math.min(Math.max(Math.min(fromWidth, fromLength), 15), 34));
  const maxChars = Math.max(4, Math.floor(usable / (fontPx * CHAR_W)));
  const text = raw.length > maxChars ? `${raw.slice(0, maxChars - 1).trimEnd()}…` : raw;
  return { text, bg, ink, w, h, fontPx };
}

// The keeper's sit/fetch state machine. Pure: the scene folds bus + animation
// events through nextKeeperState and animates whatever state it lands in.
//   sitting -(pick)-> hopOff -> walkToShelf -> grabbing -> waiting
//   waiting -(readerClosed)-> walkToChair -> hopOn -> sitting
// A pick while she is already out retargets the walk; "abort" (the fetched
// book was destroyed) sends her home.
export const SIT_FETCH = Object.freeze({
  initial: "sitting",
  transitions: Object.freeze({
    sitting: Object.freeze({ pick: "hopOff" }),
    hopOff: Object.freeze({ done: "walkToShelf" }),
    walkToShelf: Object.freeze({ arrived: "grabbing", pick: "walkToShelf", abort: "walkToChair" }),
    grabbing: Object.freeze({ opened: "waiting", pick: "walkToShelf", abort: "walkToChair" }),
    waiting: Object.freeze({
      readerClosed: "walkToChair",
      pick: "walkToShelf",
      abort: "walkToChair",
    }),
    walkToChair: Object.freeze({ arrived: "hopOn", pick: "walkToShelf" }),
    hopOn: Object.freeze({ done: "sitting" }),
  }),
});

export function nextKeeperState(state, event, machine = SIT_FETCH) {
  return machine.transitions[state]?.[event] ?? state;
}

// Folds a list of events into the visited states (index 0 is the initial
// state), so a whole fetch cycle can be asserted as a timeline.
export function runKeeperTimeline(events = [], machine = SIT_FETCH) {
  const states = [machine.initial];
  for (const event of events) {
    states.push(nextKeeperState(states[states.length - 1], event, machine));
  }
  return states;
}

// The doze machine (interior sleep variant, round 5). On "keeper:sleep" she
// settles: once the sit/fetch machine is back
// on "sitting" she dozes (eyes closed, slow breathing) until "keeper:rested".
// "rested" while still settling wakes her without ever dozing.
export const DOZE = Object.freeze({
  initial: "awake",
  transitions: Object.freeze({
    awake: Object.freeze({ sleep: "settling" }),
    settling: Object.freeze({ seated: "dozing", rested: "awake" }),
    dozing: Object.freeze({ rested: "awake" }),
  }),
});

export function nextDozeState(state, event, machine = DOZE) {
  return machine.transitions[state]?.[event] ?? state;
}

// Folds events into the visited doze states (index 0 = initial state).
export function runDozeTimeline(events = [], machine = DOZE) {
  const states = [machine.initial];
  for (const event of events) {
    states.push(nextDozeState(states[states.length - 1], event, machine));
  }
  return states;
}

// Parabolic hop between two points; u in [0,1]. Endpoints are exact, the
// apex rises `height` above the straight-line path.
export function hopArc(from, to, u, height = 0.35) {
  const k = Math.max(0, Math.min(1, u));
  return {
    x: from.x + (to.x - from.x) * k,
    y: from.y + (to.y - from.y) * k + Math.sin(Math.PI * k) * height,
    z: from.z + (to.z - from.z) * k,
  };
}

// Screen placement for the hover label from NDC coords: clamped inside the
// viewport, hidden when the point projects behind the camera or far outside.
export function labelPlacement(ndc = {}, { width = 0, height = 0, margin = 12 } = {}) {
  const { x = 0, y = 0, z = 0 } = ndc;
  if (z >= 1 || width <= 0 || height <= 0) return { visible: false, left: 0, top: 0 };
  const rawLeft = ((x + 1) / 2) * width;
  const rawTop = ((1 - y) / 2) * height;
  const visible = rawLeft >= -60 && rawLeft <= width + 60 && rawTop >= -60 && rawTop <= height + 60;
  return {
    visible,
    left: Math.round(Math.min(Math.max(rawLeft, margin), width - margin)),
    top: Math.round(Math.min(Math.max(rawTop, margin), height - margin)),
  };
}

// ---------------------------------------------------------------------------
// Interior views: a pure tween-gated view machine plus the framing math the
// scene uses to place the camera. No three.js state in any of these.
// ---------------------------------------------------------------------------

export const INTERIOR_VIEWS = Object.freeze(["main", "chairs", "shelf"]);
export const VIEW_TWEEN_SECONDS = 0.8;

// The machine holds the settled view plus an in-flight target. While `target`
// is non-null a tween is running and ordinary input is ignored; only `force`
// (programmatic: reader open/close) may retarget mid-tween.
export function createViewMachine({ seconds = VIEW_TWEEN_SECONDS } = {}) {
  return { current: "main", target: null, t: 0, seconds };
}

export function viewIsTweening(machine) {
  return machine.target !== null;
}

export function viewRequest(machine, view, { force = false } = {}) {
  if (!INTERIOR_VIEWS.includes(view)) return false;
  if (machine.target !== null) {
    if (!force || view === machine.target) return false;
  } else if (view === machine.current) {
    return false;
  }
  machine.target = view;
  machine.t = 0;
  return true;
}

// Advances the tween; returns { k, settled, view } where k is the eased
// progress toward `view`. Call only has an effect while a target is set.
export function viewStep(machine, dt) {
  if (machine.target === null) return { k: 1, settled: false, view: machine.current };
  machine.t += dt;
  const u = Math.min(1, machine.t / Math.max(1e-6, machine.seconds));
  if (u >= 1) {
    machine.current = machine.target;
    machine.target = null;
    machine.t = 0;
    return { k: 1, settled: true, view: machine.current };
  }
  return { k: u * u * (3 - 2 * u), settled: false, view: machine.target };
}

// Classifies the first raycast hit into an action, honoring the mid-tween
// input lock. `hit` is a plain descriptor: { slug } book, { hint } hint book,
// { keeper } the keeper herself (opens the same talk panel as the overworld),
// { hotspot: "chair" } the guest armchair, { hotspot: "shelf", wall } a
// bookcase. Hotspots pointing at the view you are already in do nothing.
export function pickAction(hit, { view = "main", tweening = false } = {}) {
  if (tweening || !hit) return null;
  if (hit.slug) return { type: "pick", slug: hit.slug };
  if (hit.hint) return { type: "hint" };
  if (hit.keeper) return { type: "keeper" };
  if (hit.hotspot === "chair") {
    return view === "chairs" ? null : { type: "view", view: "chairs" };
  }
  if (hit.hotspot === "shelf") {
    if (view === "shelf") return null;
    return { type: "view", view: "shelf", wall: Number.isInteger(hit.wall) ? hit.wall : 0 };
  }
  return null;
}

// On-screen size in px of a world-space length at `distance` from a camera
// with vertical fov `fovDeg` rendering into a viewport `viewportH` px tall.
export function projectedSizePx({ world = 1, distance = 1, fovDeg = 50, viewportH = 800 } = {}) {
  const tanV = Math.tan((fovDeg * Math.PI) / 360);
  if (distance <= 0 || tanV <= 0 || viewportH <= 0) return 0;
  return (viewportH * world) / (2 * distance * tanV);
}

// Median title-font fraction of the spine canvas height across the wall's
// spine specs; the shelf framing uses it to know how close "readable" is.
export function shelfFontRatio(specs = []) {
  const ratios = specs
    .map((s) => (s && s.h > 0 ? s.fontPx / s.h : 0))
    .filter((r) => r > 0)
    .sort((a, b) => a - b);
  if (ratios.length === 0) return 0.09;
  return ratios[Math.floor((ratios.length - 1) / 2)];
}

// How a spine label shows up at the shelf-view framing: the title's on-screen
// px size and the integer canvas upscale that keeps the texture at least as
// dense as the screen pixels it covers (crisp close-up).
export function shelfLabelSizing(spec, { spineHeightPx = 0, targetPx = 14, maxScale = 3 } = {}) {
  const h = spec?.h > 0 ? spec.h : 1;
  const screenFontPx = ((spec?.fontPx ?? 0) * spineHeightPx) / h;
  const scale = Math.max(1, Math.min(maxScale, Math.ceil(spineHeightPx / h)));
  return { screenFontPx, scale, legible: screenFontPx >= targetPx };
}

// A spineLabelSpec scaled up for re-rendering at higher resolution. Geometry
// stays identical; only the canvas density (and its font) grows.
export function scaleSpineSpec(spec, scale = 1) {
  const s = Math.max(1, Math.round(scale));
  if (s === 1) return { ...spec, scale: 1 };
  return { ...spec, w: spec.w * s, h: spec.h * s, fontPx: spec.fontPx * s, scale: s };
}

// Camera framing for the shelf view: dolly straight at the wall, centered on
// the shelf rows. Distance fills the view with the whole case but clamps
// closer whenever the typical title would land under `targetFontPx` px on
// screen (the legibility fix); never closer than just outside the books.
export function shelfViewFraming({
  layout = SHELF_LAYOUT,
  wall = 0,
  fovDeg = 50,
  aspect = 16 / 9,
  viewportH = 800,
  bookH = 0.46,
  fontRatio = 0.09,
  targetFontPx = 14,
  margin = 0.3,
  roomHalf = 3.8,
} = {}) {
  const tanV = Math.tan((fovDeg * Math.PI) / 360);
  const y0 = layout.firstShelfY;
  const y1 = layout.firstShelfY + (layout.shelvesPerWall - 1) * layout.shelfGapY + bookH;
  const spanH = y1 - y0 + margin * 2;
  const spanW = layout.shelfWidth + margin * 2;
  const fitDistance = Math.max(spanH / (2 * tanV), spanW / (2 * tanV * Math.max(0.1, aspect)));
  const legibleDistance = (viewportH * bookH * fontRatio) / (2 * targetFontPx * tanV);
  const distance = Math.min(
    Math.max(Math.min(fitDistance, legibleDistance), 1.05),
    roomHalf * 2 - 0.6,
  );
  const wallX = wall === 0 ? -(roomHalf - 0.07) : roomHalf - 0.07;
  const inward = wall === 0 ? 1 : -1;
  const face = wallX + inward * 0.36; // front plane of the bookcase
  const centerY = (y0 + y1) / 2;
  const screenFontPx =
    fontRatio * projectedSizePx({ world: bookH, distance, fovDeg, viewportH });
  return {
    wall,
    distance,
    fitDistance,
    legibleDistance,
    screenFontPx,
    position: { x: face + inward * distance, y: centerY, z: 0 },
    lookAt: { x: wallX, y: centerY, z: 0 },
  };
}

// ---------------------------------------------------------------------------
// Procedural canvas textures (render-only; guarded for missing 2d contexts)
// ---------------------------------------------------------------------------

function shadeHex(hex, amt) {
  const { r, g, b } = hexChannels(hex);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v + amt)));
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}


function canvasTexture(w, h) {
  if (typeof document === "undefined") {
    // fully headless (no DOM at all): plain textures, still disposable
    return { canvas: null, ctx: null, tex: new THREE.Texture() };
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { canvas, ctx: canvas.getContext("2d"), tex };
}

// Warm wooden plank floor: staggered boards, per-board tone, grain lines.
function makePlankTexture(size = 512) {
  const { ctx, tex } = canvasTexture(size, size);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  if (!ctx) return tex;
  const rng = mulberry32(hashString("planks"));
  ctx.fillStyle = "#7a5b40";
  ctx.fillRect(0, 0, size, size);
  const rows = 6;
  const bh = size / rows;
  for (let r = 0; r < rows; r++) {
    const y = r * bh;
    let x = -((r % 3) * size) / 5; // staggered board ends
    while (x < size) {
      const bw = size * (0.4 + rng() * 0.35);
      const tone = -14 + rng() * 30;
      ctx.fillStyle = shadeHex(0x8a6a4a, tone);
      ctx.fillRect(x + 1.5, y + 1.5, bw - 3, bh - 3);
      // grain: faint darker streaks along the board
      ctx.strokeStyle = `rgba(66,44,26,${0.12 + rng() * 0.12})`;
      ctx.lineWidth = 1;
      for (let g = 0; g < 4; g++) {
        const gy = y + 4 + rng() * (bh - 8);
        ctx.beginPath();
        ctx.moveTo(x + 3, gy);
        ctx.bezierCurveTo(x + bw * 0.3, gy + (rng() - 0.5) * 4, x + bw * 0.7, gy + (rng() - 0.5) * 4, x + bw - 3, gy);
        ctx.stroke();
      }
      // top-light bevel
      ctx.fillStyle = "rgba(255,235,205,0.08)";
      ctx.fillRect(x + 1.5, y + 1.5, bw - 3, 2.5);
      x += bw;
    }
    // seam between rows
    ctx.fillStyle = "rgba(40,26,14,0.55)";
    ctx.fillRect(0, y, size, 1.5);
  }
  tex.needsUpdate = true;
  return tex;
}

// Wallpaper: soft warm base (dusk lavender for unconscious homes) with a
// subtle diamond lattice and dots, like a hand-papered cottage wall.
function makeWallpaperTexture(night = false, size = 256) {
  const { ctx, tex } = canvasTexture(size, size);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  if (!ctx) return tex;
  const base = night ? 0x4a3f66 : 0xe7cfc0;
  const grad = ctx.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0, shadeHex(base, 8));
  grad.addColorStop(1, shadeHex(base, -8));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  // faint vertical stripes
  ctx.fillStyle = night ? "rgba(255,255,255,0.035)" : "rgba(255,255,255,0.09)";
  for (let x = 0; x < size; x += 32) ctx.fillRect(x, 0, 14, size);
  // diamond lattice
  ctx.strokeStyle = night ? "rgba(190,175,235,0.10)" : "rgba(164,106,120,0.14)";
  ctx.lineWidth = 1.2;
  const cell = 32;
  ctx.beginPath();
  for (let d = -size; d < size * 2; d += cell) {
    ctx.moveTo(d, 0);
    ctx.lineTo(d + size, size);
    ctx.moveTo(d + size, 0);
    ctx.lineTo(d, size);
  }
  ctx.stroke();
  // dots at lattice crossings
  ctx.fillStyle = night ? "rgba(210,195,255,0.15)" : "rgba(150,90,105,0.18)";
  for (let y = 0; y <= size; y += cell) {
    for (let x = ((y / cell) % 2) * (cell / 2); x <= size; x += cell) {
      ctx.beginPath();
      ctx.arc(x, y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  tex.needsUpdate = true;
  return tex;
}

// Round braided rug: concentric rings in warm rose/cream tones.
function makeRugTexture(night = false, size = 256) {
  const { ctx, tex } = canvasTexture(size, size);
  if (!ctx) return tex;
  const rng = mulberry32(hashString("rug"));
  const palette = night
    ? [0x5a4f80, 0x6d5a8f, 0x8578ad, 0x4a3f66]
    : [0xd98da8, 0xf3e3cf, 0xc9737f, 0xe8b4a0];
  const cx = size / 2;
  const rings = 11;
  for (let i = rings; i >= 1; i--) {
    const r = (i / rings) * (size / 2 - 2);
    ctx.fillStyle = shadeHex(palette[i % palette.length], -6 + rng() * 12);
    ctx.beginPath();
    ctx.arc(cx, cx, r, 0, Math.PI * 2);
    ctx.fill();
    // braid stitches
    ctx.strokeStyle = "rgba(60,35,40,0.18)";
    ctx.lineWidth = 1;
    const stitches = Math.max(10, Math.floor(r / 3));
    for (let s = 0; s < stitches; s++) {
      const a = (s / stitches) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * (r - 3), cx + Math.sin(a) * (r - 3));
      ctx.lineTo(cx + Math.cos(a + 0.05) * r, cx + Math.sin(a + 0.05) * r);
      ctx.stroke();
    }
  }
  tex.needsUpdate = true;
  return tex;
}

// The view through the window: a day sky with sun and clouds, or the
// unconscious quarter's moonlit night with stars.
function makeWindowSkyTexture(night = false, w = 256, h = 200) {
  const { ctx, tex } = canvasTexture(w, h);
  if (!ctx) return tex;
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  if (night) {
    grad.addColorStop(0, "#120f2c");
    grad.addColorStop(0.7, "#241d4a");
    grad.addColorStop(1, "#332a5e");
  } else {
    grad.addColorStop(0, "#7db4ea");
    grad.addColorStop(0.7, "#b7dcf8");
    grad.addColorStop(1, "#d8ecfb");
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  const rng = mulberry32(hashString("window-sky"));
  if (night) {
    // stars
    for (let i = 0; i < 60; i++) {
      const a = 0.35 + rng() * 0.65;
      ctx.fillStyle = `rgba(235,230,255,${a})`;
      ctx.fillRect(rng() * w, rng() * h * 0.85, 1.4, 1.4);
    }
    // moon with a soft halo
    const mx = w * 0.68;
    const my = h * 0.3;
    const halo = ctx.createRadialGradient(mx, my, 6, mx, my, 40);
    halo.addColorStop(0, "rgba(226,222,255,0.85)");
    halo.addColorStop(1, "rgba(226,222,255,0)");
    ctx.fillStyle = halo;
    ctx.fillRect(mx - 42, my - 42, 84, 84);
    ctx.fillStyle = "#efeaff";
    ctx.beginPath();
    ctx.arc(mx, my, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(170,160,210,0.5)";
    ctx.beginPath();
    ctx.arc(mx - 5, my + 4, 3.4, 0, Math.PI * 2);
    ctx.arc(mx + 6, my - 3, 2.4, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // sun
    const sx = w * 0.24;
    const sy = h * 0.26;
    const halo = ctx.createRadialGradient(sx, sy, 4, sx, sy, 44);
    halo.addColorStop(0, "rgba(255,246,200,0.95)");
    halo.addColorStop(1, "rgba(255,246,200,0)");
    ctx.fillStyle = halo;
    ctx.fillRect(sx - 46, sy - 46, 92, 92);
    ctx.fillStyle = "#fff3c2";
    ctx.beginPath();
    ctx.arc(sx, sy, 13, 0, Math.PI * 2);
    ctx.fill();
    // puffy clouds
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    for (let c = 0; c < 3; c++) {
      const cxp = rng() * w;
      const cyp = h * (0.35 + rng() * 0.3);
      for (let p = 0; p < 5; p++) {
        ctx.beginPath();
        ctx.arc(cxp + (p - 2) * 10, cyp + (rng() - 0.5) * 5, 8 + rng() * 6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // distant hills, like the island outside
    ctx.fillStyle = "#7fb069";
    ctx.beginPath();
    ctx.moveTo(0, h);
    ctx.lineTo(0, h * 0.82);
    ctx.quadraticCurveTo(w * 0.3, h * 0.68, w * 0.55, h * 0.84);
    ctx.quadraticCurveTo(w * 0.8, h * 0.72, w, h * 0.86);
    ctx.lineTo(w, h);
    ctx.fill();
  }
  tex.needsUpdate = true;
  return tex;
}

// One book spine: colored background with head/tail bands and the title
// rotated to read top-to-bottom (canvas per book, sized by spineLabelSpec).
function makeSpineTexture(spec) {
  const { ctx, tex } = canvasTexture(spec.w, spec.h);
  if (!ctx) return tex;
  const grad = ctx.createLinearGradient(0, 0, spec.w, 0);
  grad.addColorStop(0, shadeHex(spec.bg, -26));
  grad.addColorStop(0.5, shadeHex(spec.bg, 10));
  grad.addColorStop(1, shadeHex(spec.bg, -30));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, spec.w, spec.h);
  // head/tail bands (band px scale with the canvas resolution)
  const s = spec.scale ?? 1;
  ctx.fillStyle = "rgba(0,0,0,0.30)";
  ctx.fillRect(0, 7 * s, spec.w, 3 * s);
  ctx.fillRect(0, spec.h - 12 * s, spec.w, 3 * s);
  ctx.fillStyle = "rgba(255,255,255,0.16)";
  ctx.fillRect(0, 11 * s, spec.w, 2 * s);
  ctx.fillRect(0, spec.h - 8 * s, spec.w, 2 * s);
  // title, reading top-to-bottom like a real spine
  ctx.save();
  ctx.translate(spec.w / 2, spec.h / 2);
  ctx.rotate(Math.PI / 2);
  ctx.fillStyle = spec.ink;
  ctx.font = `600 ${spec.fontPx}px "Trebuchet MS","Segoe UI",sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(spec.text, 0, 0, spec.h - 22 * s);
  ctx.restore();
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

const ROOM_HALF = 3.8; // half extent in x and z
const WALL_H = 3.5;
const WALL_X = ROOM_HALF - 0.07; // shelf walls sit at +-x
const CASE_DEPTH = 0.36; // bookcase depth off the wall
const BOOK_H = 0.46;
const BOOK_D = 0.27;
const STAND_Y = 0.52; // blob center above the floor (matches the overworld)
const SEAT_TOP = 0.44;
const SIT_SINK = 0.1; // how far she squishes into the cushion
const SIT_Y = SEAT_TOP + STAND_Y - SIT_SINK;
// The two armchairs are a cozy pair angled toward one another:
// hers by the lamp, the guest chair across the rug, each turned a few degrees
// shy of dead-on so the pair reads relaxed, not confrontational. Exported so
// the geometry (facing angles, camera seat) is unit-testable.
export const CHAIR_POS = Object.freeze({ x: 0.62, z: -0.85 });
export const CHAIR_ANGLE = -0.55; // facing the guest chair (and the chairs camera)
export const SECOND_CHAIR = Object.freeze({ x: -0.75, z: 1.05, angle: 2.42 }); // guest seat, facing hers
// Camera poses for the fixed views (shelf framing is computed per viewport).
// The chairs pose SITS IN the guest chair and looks AT her: she faces the
// camera from her own chair.
const MAIN_POSE = Object.freeze({
  pos: Object.freeze({ x: 0, y: 2.55, z: 6.35 }),
  look: Object.freeze({ x: 0, y: 1.25, z: -0.6 }),
});
export const CHAIRS_POSE = Object.freeze({
  pos: Object.freeze({ x: -0.9, y: 1.14, z: 1.22 }),
  look: Object.freeze({ x: 0.62, y: 0.9, z: -0.85 }),
});
const REFRAME_SECONDS = 0.9; // "Back to Keeper" in the main view: gentle turn to her
const HOTSPOT_GLOW_COLOR = 0xffb46a;
const HOP_SECONDS = 0.55;
const GRAB_SECONDS = 0.9;
const RETURN_SECONDS = 0.8;
const HOVER_SLIDE = 0.09; // how far a hovered book slides out
const FLOAT_POS = new THREE.Vector3(0, 1.62, 1.4);

const STYLE_ID = "mk-interior-style";
const CSS = `
.mk-book-label{position:absolute;z-index:25;pointer-events:none;transform:translate(-50%,-120%);background:rgba(20,10,3,.96);border:1px solid var(--line);border-radius:4px;padding:5px 10px;max-width:280px;box-shadow:var(--shadow-soft);letter-spacing:.02em;}
.mk-book-label strong{display:block;font-size:var(--fs-xs);font-weight:600;color:var(--text);line-height:1.3;}
.mk-book-label span{font-size:.72rem;color:var(--text-dim);}
`;

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => t * t * (3 - 2 * t);

function parseKeeperId(mode) {
  const m = String(mode ?? "");
  if (m.startsWith("interior:")) return m.slice("interior:".length) || null;
  return null;
}

export function createInteriorScene(ctx = {}) {
  const { state = {}, bus, api, config: cfg, container = null } = ctx;
  const keeperId =
    ctx.keeperId ?? parseKeeperId(ctx.mode) ?? state.selectedKeeperId ?? state.keepers?.[0]?.id ?? "keeper";
  const keeper =
    state.keepers?.find((a) => a.id === keeperId) ?? { id: keeperId, name: keeperId, palette: {} };
  const night = keeper.kind === "unconscious";
  const doc = container?.ownerDocument ?? (typeof document !== "undefined" ? document : null);

  let disposed = false;
  const offs = [];
  const disposables = []; // geometries, materials, textures created here

  // --- view state (main | chairs | shelf) ---
  const machine = createViewMachine();
  const viewTween = {
    active: false,
    fromPos: new THREE.Vector3(),
    fromLook: new THREE.Vector3(),
    toPos: new THREE.Vector3(),
    toLook: new THREE.Vector3(),
  };
  const camLook = new THREE.Vector3(MAIN_POSE.look.x, MAIN_POSE.look.y, MAIN_POSE.look.z);
  let shelfWall = 0; // which bookcase wall the shelf view frames
  let shelfDistance = null; // camera distance of the last shelf framing
  // Shelf-view 2D pan (shelf_pan.js): drag the close-up on x/y so small
  // screens can reach every spine. Base pose = the untouched framing; the
  // clamped offset trucks position and lookAt together (no zoom/rotation).
  const shelfPanDrag = createShelfPan();
  let shelfBasePose = null; // { pos, look } of the current shelf framing
  let panOffset = { u: 0, v: 0 };
  let panLim = { maxU: 0, maxV: 0 };
  let suppressClick = false; // a finished drag swallows the click it ends on
  let readerOpen = false;
  let viewBeforeReader = null; // view to restore on "reader:closed"
  let viewsUi = null; // ui/interior_views.js nav cluster (browser only)
  let readoutUi = null; // ui/interior_views.js room readout (browser only)
  let reframe = null; // "Back to Keeper" from the settled main view: gentle look tween
  let swayT = 0; // seconds settled in the chairs view (sway ramp)
  let hotspotHover = null; // "chair" | "shelf0" | "shelf1" | null
  const hotspotMeshes = []; // raycast targets beyond the books
  const hotspotGlow = new Map(); // key -> { mats: [], k: 0 }

  function registerHotspot(key, group, userData) {
    const rec = hotspotGlow.get(key) ?? { mats: [], k: 0 };
    group.traverse((obj) => {
      if (!obj.isMesh) return;
      Object.assign(obj.userData, userData);
      hotspotMeshes.push(obj);
      if (obj.material?.emissive) {
        obj.material.emissive.setHex(HOTSPOT_GLOW_COLOR);
        obj.material.emissiveIntensity = 0;
        rec.mats.push(obj.material);
      }
    });
    hotspotGlow.set(key, rec);
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(night ? 0x171226 : 0x241a2f);

  const track = (...resources) => {
    for (const res of resources) {
      if (Array.isArray(res)) disposables.push(...res);
      else if (res) disposables.push(res);
    }
    return resources[0];
  };
  const solid = (geo, color, opts = {}) => {
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ color, roughness: 0.88, ...opts }),
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    track(mesh.geometry, mesh.material);
    return mesh;
  };
  const box = (w, h, d, color, opts = {}) => solid(new THREE.BoxGeometry(w, h, d), color, opts);

  // --- floor: wooden planks + a round rug ---
  const plankTex = track(makePlankTexture());
  plankTex.repeat.set(2, 2);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM_HALF * 2, ROOM_HALF * 2),
    new THREE.MeshStandardMaterial({ map: plankTex, color: night ? 0x8f86b3 : 0xffffff, roughness: 0.85 }),
  );
  track(floor.geometry, floor.material);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const rugTex = track(makeRugTexture(night));
  const rug = new THREE.Mesh(
    new THREE.CircleGeometry(1.55, 48),
    new THREE.MeshStandardMaterial({ map: rugTex, roughness: 1 }),
  );
  track(rug.geometry, rug.material);
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(0.1, 0.012, 0.25);
  rug.receiveShadow = true;
  scene.add(rug);

  // --- walls: wallpaper + wainscot trim; ceiling with a beam ---
  const paperTex = track(makeWallpaperTexture(night));
  paperTex.repeat.set(3, 1.4);
  const wallMat = new THREE.MeshStandardMaterial({ map: paperTex, roughness: 0.95 });
  track(wallMat);
  const woodDark = night ? 0x3a3050 : 0x5c4433;
  const woodTrim = night ? 0x453a5e : 0x6d5340;

  const wallGeo = new THREE.PlaneGeometry(ROOM_HALF * 2, WALL_H);
  track(wallGeo);
  const backWall = new THREE.Mesh(wallGeo, wallMat);
  backWall.position.set(0, WALL_H / 2, -ROOM_HALF);
  backWall.receiveShadow = true;
  scene.add(backWall);
  for (const side of [-1, 1]) {
    const wall = new THREE.Mesh(wallGeo, wallMat);
    wall.position.set(side * ROOM_HALF, WALL_H / 2, 0);
    wall.rotation.y = -side * Math.PI / 2;
    wall.receiveShadow = true;
    scene.add(wall);
  }

  // wainscot: a low wooden band + rail on every wall
  const WAINSCOT_H = 0.72;
  for (const [w, x, z, ry] of [
    [ROOM_HALF * 2, 0, -ROOM_HALF + 0.02, 0],
    [ROOM_HALF * 2, -ROOM_HALF + 0.02, 0, Math.PI / 2],
    [ROOM_HALF * 2, ROOM_HALF - 0.02, 0, -Math.PI / 2],
  ]) {
    const board = box(w, WAINSCOT_H, 0.04, woodDark, { roughness: 0.8 });
    board.position.set(x, WAINSCOT_H / 2, z);
    board.rotation.y = ry;
    scene.add(board);
    const rail = box(w, 0.05, 0.07, woodTrim, { roughness: 0.7 });
    rail.position.set(x, WAINSCOT_H + 0.025, z);
    rail.rotation.y = ry;
    scene.add(rail);
  }

  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM_HALF * 2, ROOM_HALF * 2),
    new THREE.MeshStandardMaterial({ color: night ? 0x40365c : 0xe9dcc8, roughness: 0.98 }),
  );
  track(ceiling.geometry, ceiling.material);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = WALL_H;
  scene.add(ceiling);
  const beam = box(ROOM_HALF * 2, 0.18, 0.26, woodDark);
  beam.position.set(0, WALL_H - 0.09, -0.5);
  scene.add(beam);

  // --- window on the back wall: the district's sky (day for conscious
  // keepers, permanent moonlit night for unconscious ones) ---
  const winX = -1.5;
  const winY = 1.95;
  const skyTex = track(makeWindowSkyTexture(night));
  const sky = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 1.15),
    new THREE.MeshBasicMaterial({ map: skyTex }),
  );
  track(sky.geometry, sky.material);
  sky.position.set(winX, winY, -ROOM_HALF + 0.02);
  scene.add(sky);
  for (const [w, h, dx, dy] of [
    [1.68, 0.09, 0, 0.62],
    [1.68, 0.09, 0, -0.62],
    [0.09, 1.33, -0.8, 0],
    [0.09, 1.33, 0.8, 0],
    [0.05, 1.15, 0, 0],
    [1.5, 0.05, 0, 0],
  ]) {
    const bar = box(w, h, 0.07, woodTrim, { roughness: 0.7 });
    bar.position.set(winX + dx, winY + dy, -ROOM_HALF + 0.06);
    scene.add(bar);
  }
  // sill
  const sill = box(1.8, 0.06, 0.16, woodTrim);
  sill.position.set(winX, winY - 0.7, -ROOM_HALF + 0.1);
  scene.add(sill);

  // --- fireplace on the back wall, with a flickering light ---
  const fire = new THREE.Group();
  const surround = box(1.3, 1.2, 0.34, night ? 0x4d4266 : 0x8f8a82, { roughness: 0.95 });
  surround.position.y = 0.6;
  fire.add(surround);
  const mantel = box(1.5, 0.09, 0.44, woodTrim);
  mantel.position.y = 1.24;
  fire.add(mantel);
  const opening = box(0.74, 0.6, 0.3, 0x120b16, { roughness: 1 });
  opening.position.set(0, 0.38, 0.04);
  fire.add(opening);
  const hearth = box(1.5, 0.05, 0.6, night ? 0x3a3350 : 0x7b756c);
  hearth.position.set(0, 0.025, 0.3);
  fire.add(hearth);
  // logs
  for (const [rx, rz, ry] of [
    [-0.12, 0.1, 0.5],
    [0.12, 0.08, -0.4],
  ]) {
    const log = solid(new THREE.CylinderGeometry(0.05, 0.05, 0.4, 8), 0x4a3421);
    log.rotation.z = Math.PI / 2;
    log.rotation.y = ry;
    log.position.set(rx, 0.14, 0.12 + rz * 0.2);
    fire.add(log);
  }
  // flames: overlapping emissive cones, flicker-scaled per frame
  const flames = [];
  const flameColors = [0xffb03c, 0xff7a2e, 0xffd97a];
  for (let i = 0; i < 3; i++) {
    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.09 - i * 0.02, 0.3 - i * 0.05, 8),
      new THREE.MeshBasicMaterial({
        color: flameColors[i],
        transparent: true,
        opacity: 0.85 - i * 0.15,
      }),
    );
    track(flame.geometry, flame.material);
    flame.position.set((i - 1) * 0.07, 0.28 + i * 0.05, 0.12);
    fire.add(flame);
    flames.push(flame);
  }
  const fireLight = new THREE.PointLight(0xff8a3c, 6, 7, 2);
  fireLight.position.set(0, 0.45, 0.35);
  fire.add(fireLight);
  fire.position.set(2.05, 0, -ROOM_HALF + 0.18);
  scene.add(fire);

  // --- reading lamp beside the chair ---
  const lampGroup = new THREE.Group();
  const lampBase = solid(new THREE.CylinderGeometry(0.16, 0.2, 0.05, 16), woodDark);
  lampBase.position.y = 0.025;
  lampGroup.add(lampBase);
  const pole = box(0.05, 1.45, 0.05, woodDark);
  pole.position.y = 0.75;
  lampGroup.add(pole);
  const shade = new THREE.Mesh(
    new THREE.ConeGeometry(0.3, 0.32, 20, 1, true),
    new THREE.MeshStandardMaterial({
      color: 0xffc38a,
      emissive: 0xff9d5c,
      emissiveIntensity: 0.7,
      side: THREE.DoubleSide,
    }),
  );
  track(shade.geometry, shade.material);
  shade.position.y = 1.52;
  lampGroup.add(shade);
  const lampLight = new THREE.PointLight(0xffc38a, 14, 11, 2);
  lampLight.position.y = 1.42;
  lampLight.castShadow = true;
  lampLight.shadow.mapSize.set(512, 512);
  lampGroup.add(lampLight);
  lampGroup.position.set(1.9, 0, -0.5); // beside the chair, clear of the fireplace
  scene.add(lampGroup);

  // --- ambient light: warm and readable (cooler in the night quarter) ---
  const hemi = new THREE.HemisphereLight(
    night ? 0xbdb4e8 : 0xffe8d1,
    night ? 0x2a2340 : 0x4a3b33,
    night ? 0.65 : 0.9,
  );
  scene.add(hemi);
  const windowLight = new THREE.DirectionalLight(night ? 0x9fa8e8 : 0xcfe3ff, night ? 0.35 : 0.5);
  windowLight.position.set(winX, 2.6, -2.6);
  windowLight.target.position.set(0.5, 0.4, 1);
  scene.add(windowLight, windowLight.target);
  // soft fill from the room's heart so the shelves and spines stay readable
  const fill = new THREE.PointLight(night ? 0xcabfff : 0xffe3c4, 4, 12, 1.6);
  fill.position.set(0, 2.6, 1.2);
  scene.add(fill);

  // --- the armchairs: hers, plus a guest chair angled toward it (same
  // builder family, slightly different tint; the guest chair is the
  // clickable hotspot that seats the camera in the chairs view) ---
  function buildArmchair(fabric, dark) {
    const group = new THREE.Group();
    const base = box(1.14, 0.2, 0.92, dark);
    base.position.y = 0.14;
    group.add(base);
    const cushion = box(1.0, 0.24, 0.8, fabric, { roughness: 0.95 });
    cushion.position.y = SEAT_TOP - 0.12;
    group.add(cushion);
    const back = box(1.14, 1.0, 0.24, fabric, { roughness: 0.95 });
    back.position.set(0, 0.78, -0.46);
    back.rotation.x = -0.1;
    group.add(back);
    for (const sx of [-1, 1]) {
      const arm = box(0.2, 0.44, 0.86, dark, { roughness: 0.95 });
      arm.position.set(sx * 0.58, 0.5, -0.03);
      group.add(arm);
      const armTop = solid(new THREE.CylinderGeometry(0.1, 0.1, 0.86, 10), fabric);
      armTop.rotation.x = Math.PI / 2;
      armTop.position.set(sx * 0.58, 0.72, -0.03);
      group.add(armTop);
    }
    for (const [fx, fz] of [
      [-0.5, 0.38],
      [0.5, 0.38],
      [-0.5, -0.42],
      [0.5, -0.42],
    ]) {
      const foot = solid(new THREE.CylinderGeometry(0.04, 0.05, 0.08, 8), woodDark);
      foot.position.set(fx, 0.04, fz);
      group.add(foot);
    }
    return group;
  }

  const chairFabric = night ? 0x5f5288 : 0xc9737f;
  const chairDark = night ? 0x4a3f66 : 0xa85b66;
  const chair = buildArmchair(chairFabric, chairDark);
  chair.position.set(CHAIR_POS.x, 0, CHAIR_POS.z);
  chair.rotation.y = CHAIR_ANGLE;
  scene.add(chair);

  const guestChair = buildArmchair(night ? 0x52678f : 0xc98d73, night ? 0x3f4a66 : 0xa8735b);
  guestChair.position.set(SECOND_CHAIR.x, 0, SECOND_CHAIR.z);
  guestChair.rotation.y = SECOND_CHAIR.angle;
  scene.add(guestChair);
  registerHotspot("chair", guestChair, { hotspot: "chair" });

  // --- side table with a teacup, a plant, floor clutter ---
  const table = new THREE.Group();
  const tableTop = solid(new THREE.CylinderGeometry(0.3, 0.3, 0.045, 20), woodTrim);
  tableTop.position.y = 0.52;
  table.add(tableTop);
  const tableLeg = solid(new THREE.CylinderGeometry(0.035, 0.05, 0.5, 10), woodDark);
  tableLeg.position.y = 0.25;
  table.add(tableLeg);
  const saucer = solid(new THREE.CylinderGeometry(0.085, 0.06, 0.015, 14), 0xf3ead9);
  saucer.position.y = 0.55;
  table.add(saucer);
  const cup = solid(new THREE.CylinderGeometry(0.05, 0.04, 0.07, 14), 0xf3ead9);
  cup.position.y = 0.59;
  table.add(cup);
  const tea = solid(new THREE.CylinderGeometry(0.042, 0.042, 0.008, 12), 0x8a5a30, {
    roughness: 0.4,
  });
  tea.position.y = 0.625;
  table.add(tea);
  const handle = solid(new THREE.TorusGeometry(0.028, 0.008, 6, 12), 0xf3ead9);
  handle.position.set(0.058, 0.59, 0);
  table.add(handle);
  table.position.set(-0.45, 0, -1.2);
  scene.add(table);

  const plant = new THREE.Group();
  const pot = solid(new THREE.CylinderGeometry(0.16, 0.12, 0.24, 12), 0xb06a4a);
  pot.position.y = 0.12;
  plant.add(pot);
  const leafGeo = new THREE.SphereGeometry(0.14, 10, 8);
  const leafMat = new THREE.MeshStandardMaterial({
    color: night ? 0x3f6b58 : 0x5a9455,
    roughness: 0.9,
  });
  track(leafGeo, leafMat);
  for (const [lx, ly, lz, ls] of [
    [0, 0.38, 0, 1.15],
    [-0.11, 0.31, 0.06, 0.8],
    [0.1, 0.33, -0.07, 0.85],
    [0.02, 0.47, 0.05, 0.7],
  ]) {
    const leaf = new THREE.Mesh(leafGeo, leafMat);
    leaf.position.set(lx, ly, lz);
    leaf.scale.setScalar(ls);
    leaf.scale.y *= 1.4;
    leaf.castShadow = true;
    plant.add(leaf);
  }
  plant.position.set(-2.85, 0, -3.05);
  scene.add(plant);

  // floor books: a little stack and a stray one
  const clutter = new THREE.Group();
  const stackColors = [0x7c5cad, 0xc9737f, 0x4a8a7d];
  for (let i = 0; i < 3; i++) {
    const b = box(0.34 - i * 0.03, 0.06, 0.26, stackColors[i], { roughness: 0.7 });
    b.position.set(0, 0.03 + i * 0.062, 0);
    b.rotation.y = (i - 1) * 0.35;
    clutter.add(b);
  }
  clutter.position.set(1.3, 0, -2.95); // a little stack by the fireplace
  scene.add(clutter);
  const stray = box(0.3, 0.055, 0.24, 0xa85b66, { roughness: 0.7 });
  stray.position.set(-1.15, 0.028, 1.35);
  stray.rotation.y = 0.9;
  scene.add(stray);

  // --- the bookcase along the left wall ---
  const caseWood = night ? 0x554975 : 0x7a5c40;
  for (let wall = 0; wall < SHELF_LAYOUT.walls; wall++) {
    const x = wall === 0 ? -WALL_X : WALL_X;
    const inward = wall === 0 ? 1 : -1;
    const group = new THREE.Group();
    const runW = SHELF_LAYOUT.shelfWidth + 0.5;
    // top of the case: just above the highest row of books, below the ceiling
    const topY =
      SHELF_LAYOUT.firstShelfY + (SHELF_LAYOUT.shelvesPerWall - 1) * SHELF_LAYOUT.shelfGapY + BOOK_H + 0.12;
    // back panel
    const back = box(0.04, topY + 0.15, runW, caseWood, { roughness: 0.9 });
    back.position.set(0.02 * inward, (topY + 0.15) / 2, 0);
    group.add(back);
    // side + middle uprights
    for (const uz of [-runW / 2, 0, runW / 2]) {
      const upright = box(CASE_DEPTH, topY + 0.15, 0.06, caseWood);
      upright.position.set(inward * (CASE_DEPTH / 2 + 0.02), (topY + 0.15) / 2, uz);
      group.add(upright);
    }
    // shelf boards (one under each row, plus a top)
    for (let s = 0; s <= SHELF_LAYOUT.shelvesPerWall; s++) {
      const boardY = s === SHELF_LAYOUT.shelvesPerWall ? topY + 0.12 : SHELF_LAYOUT.firstShelfY + s * SHELF_LAYOUT.shelfGapY - 0.035;
      const board = box(CASE_DEPTH, 0.05, runW, caseWood);
      board.position.set(inward * (CASE_DEPTH / 2 + 0.02), boardY, 0);
      group.add(board);
    }
    group.position.set(x, 0, 0);
    scene.add(group);
    registerHotspot(`shelf${wall}`, group, { hotspot: "shelf", wall });
  }
  const bookX = (wall) => {
    const inward = wall === 0 ? 1 : -1;
    return (wall === 0 ? -WALL_X : WALL_X) + inward * (0.04 + BOOK_D / 2);
  };

  // --- books: one spine mesh per book, title readable on the spine ---
  const bookGroup = new THREE.Group();
  scene.add(bookGroup);
  const pagesMat = new THREE.MeshStandardMaterial({ color: 0xf0e6cf, roughness: 0.9 });
  track(pagesMat);
  const books = []; // { slug, mesh, base, wall, inward, hoverK, own: [resources] }
  let bookIndex = 0;
  let hintBook = null; // the glowing blank book when the library is empty

  function addBookMesh(book) {
    if (!book?.slug) return;
    removeHintBook();
    const { wall, along, y, step } = shelfSlot(bookIndex++);
    // Spine size comes from the book's corpus tier (small | medium | big |
    // large). A "digest" book (source "sleep", written while she dreams) is
    // just a normal book with its own spine: nothing here looks at
    // book.source.
    const { thickness: rawThickness, height } = tierSizing(bookTier(book));
    const thickness = Math.min(rawThickness, step * 0.9);
    const spec = spineLabelSpec(book, { thickness, height });
    const spineTex = makeSpineTexture(spec);
    const spineMat = new THREE.MeshStandardMaterial({ map: spineTex, roughness: 0.62 });
    const coverMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(shadeHex(spec.bg, -34)),
      roughness: 0.7,
    });
    // geometry: depth of the book runs along x (into the case), thickness
    // along z (the shelf run), so the spine is the +x / -x face.
    const geo = new THREE.BoxGeometry(BOOK_D, height, thickness);
    const mats =
      wall === 0
        ? [spineMat, pagesMat, pagesMat, coverMat, coverMat, coverMat]
        : [pagesMat, spineMat, pagesMat, coverMat, coverMat, coverMat];
    const mesh = new THREE.Mesh(geo, mats);
    const inward = wall === 0 ? 1 : -1;
    mesh.position.set(bookX(wall), y + height / 2, along);
    mesh.castShadow = true;
    mesh.userData.slug = book.slug;
    bookGroup.add(mesh);
    books.push({
      slug: book.slug,
      title: book.title || book.slug,
      date: book.date ?? "",
      mesh,
      base: mesh.position.clone(),
      wall,
      inward,
      hoverK: 0,
      spec,
      spineMat,
      labelScale: 1,
      own: [geo, spineMat, spineTex, coverMat],
    });
    // A book landing on the framed wall while the shelf view is up gets the
    // close-up canvas resolution right away.
    if (shelfDistance !== null && (machine.target ?? machine.current) === "shelf" && wall === shelfWall) {
      rescaleSpines(shelfWall, shelfDistance);
    }
  }

  // Re-render the spine canvases of a wall for the shelf-view close-up: the
  // texture upscales (never down) so its texels stay at least as dense as the
  // screen pixels the spine covers.
  function rescaleSpines(wall, distance) {
    if (!camera || !distance) return;
    const spineHeightPx = projectedSizePx({
      world: BOOK_H,
      distance,
      fovDeg: camera.fov ?? 50,
      viewportH: viewport().height,
    });
    for (const entry of books) {
      if (entry.wall !== wall) continue;
      const { scale } = shelfLabelSizing(entry.spec, { spineHeightPx });
      if (scale <= entry.labelScale) continue;
      const tex = makeSpineTexture(scaleSpineSpec(entry.spec, scale));
      const old = entry.spineMat.map;
      entry.spineMat.map = tex;
      entry.spineMat.needsUpdate = true;
      const oi = entry.own.indexOf(old);
      if (oi !== -1) entry.own.splice(oi, 1);
      old?.dispose?.();
      entry.own.push(tex);
      entry.labelScale = scale;
    }
  }

  function disposeEntry(entry) {
    bookGroup.remove(entry.mesh);
    for (const res of entry.own) res?.dispose?.();
  }

  function removeBookMesh(slug) {
    const i = books.findIndex((b) => b.slug === slug);
    if (i === -1) return;
    const [entry] = books.splice(i, 1);
    if (hovered === entry) setHovered(null);
    if (fetching.entry === entry) {
      fetching.entry = null;
      applyEvent("abort");
    }
    const ti = bookTweens.findIndex((t) => t.entry === entry);
    if (ti !== -1) bookTweens.splice(ti, 1);
    disposeEntry(entry);
    if (books.length === 0) addHintBook();
  }

  // Empty library: no UI panel, just a single glowing blank book waiting on
  // a shelf. Clicking it opens the talk dialog ("tell her something").
  function addHintBook() {
    if (hintBook || disposed) return;
    const geo = new THREE.BoxGeometry(BOOK_D, BOOK_H, 0.09);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xf6ecdf,
      emissive: 0xffe9b8,
      emissiveIntensity: 0.55,
      roughness: 0.5,
    });
    const mesh = new THREE.Mesh(geo, mat);
    const { along, y } = shelfSlot(Math.floor(SHELF_LAYOUT.slotsPerShelf / 2) + SHELF_LAYOUT.slotsPerShelf);
    mesh.position.set(bookX(0), y + BOOK_H / 2, along);
    mesh.userData.hint = true;
    bookGroup.add(mesh);
    hintBook = { mesh, own: [geo, mat], baseY: mesh.position.y };
  }

  function removeHintBook() {
    if (!hintBook) return;
    if (hovered === hintBook) setHovered(null);
    bookGroup.remove(hintBook.mesh);
    for (const res of hintBook.own) res?.dispose?.();
    hintBook = null;
  }

  api
    ?.listBooks?.(keeperId)
    .then((list) => {
      if (disposed) return;
      for (const book of list ?? []) addBookMesh(book);
      if (books.length === 0) addHintBook();
    })
    .catch((err) => {
      console.warn("[memory-keepers] interior: could not load books:", err);
      if (!disposed && books.length === 0) addHintBook();
    });

  // --- the keeper: same factory as outside, sitting on the chair ---
  const rig = new THREE.Group(); // walk position + facing
  const squash = new THREE.Group(); // cushion squish, owned here (the mesh
  rig.add(squash); // factory animates its own inner root)
  rig.position.set(CHAIR_POS.x, SIT_Y, CHAIR_POS.z);
  rig.rotation.y = CHAIR_ANGLE;
  scene.add(rig);
  let keeperHandle = null;
  let keeperRec = keeper; // freshest Keeper record (session status), from state:loaded
  let levelFor = null; // keeper_mesh.tiredLevelFor once the module resolves
  const keeperPickMeshes = []; // her body: clicking her opens the talk panel

  function registerKeeperPick(group) {
    group.traverse((obj) => {
      if (obj.userData?.pick === "keeper") {
        obj.userData.keeperId = keeperId;
        keeperPickMeshes.push(obj);
      }
    });
  }

  function makeFallbackKeeper() {
    const body = solid(new THREE.SphereGeometry(0.5, 20, 16), 0xf2f6fa, { roughness: 0.6 });
    body.userData.pick = "keeper";
    const group = new THREE.Group();
    group.add(body);
    let t = 0;
    return {
      group,
      update(dt) {
        t += dt;
        body.position.y = Math.sin(t * 3) * 0.03;
      },
      setWalking() {},
      setSelected() {},
      setTired() {},
      setSleeping() {},
      dispose() {},
    };
  }

  import("./keeper_mesh.js")
    .then((mod) => {
      if (disposed) return;
      const factory = mod.createKeeperMesh ?? mod.default;
      keeperHandle = factory({ keeper, config: cfg });
      levelFor = mod.tiredLevelFor ?? null;
      // Same level/status visuals as the overworld: they never depend on
      // which scene is active.
      keeperHandle.setTired?.(levelFor ? levelFor(keeperRec) : 0);
      registerKeeperPick(keeperHandle.group);
      squash.add(keeperHandle.group);
      // "keeper:sleep" may have landed before the mesh resolved.
      if (doze === "dozing") keeperHandle.setSleeping?.(true);
      else syncDoze();
    })
    .catch(() => {
      if (disposed) return;
      keeperHandle = makeFallbackKeeper();
      registerKeeperPick(keeperHandle.group);
      squash.add(keeperHandle.group);
    });

  // --- camera / renderer ---
  let camera = ctx.camera ?? null;
  let renderer = ctx.renderer ?? null;
  let ownRenderer = false;

  const viewport = () => ({
    width: container?.clientWidth || globalThis.innerWidth || 1,
    height: container?.clientHeight || globalThis.innerHeight || 1,
  });
  if (!camera) {
    const { width, height } = viewport();
    camera = new THREE.PerspectiveCamera(cfg?.camera?.fov ?? 50, width / Math.max(1, height), 0.1, 100);
  }
  // The scene owns the interior framing: start on the main view.
  camera.position.set(MAIN_POSE.pos.x, MAIN_POSE.pos.y, MAIN_POSE.pos.z);
  camera.lookAt(camLook);

  // --- view switching: poses + eased camera tweens (~0.8 s) ---
  function poseFor(view) {
    if (view === "chairs") {
      return {
        pos: new THREE.Vector3(CHAIRS_POSE.pos.x, CHAIRS_POSE.pos.y, CHAIRS_POSE.pos.z),
        look: new THREE.Vector3(CHAIRS_POSE.look.x, CHAIRS_POSE.look.y, CHAIRS_POSE.look.z),
      };
    }
    if (view === "shelf") {
      const { width, height } = viewport();
      const framing = shelfViewFraming({
        wall: shelfWall,
        fovDeg: camera.fov ?? 50,
        aspect: width / Math.max(1, height),
        viewportH: height,
        bookH: BOOK_H,
        fontRatio: shelfFontRatio(books.filter((b) => b.wall === shelfWall).map((b) => b.spec)),
        roomHalf: ROOM_HALF,
      });
      return {
        pos: new THREE.Vector3(framing.position.x, framing.position.y, framing.position.z),
        look: new THREE.Vector3(framing.lookAt.x, framing.lookAt.y, framing.lookAt.z),
        distance: framing.distance,
      };
    }
    return {
      pos: new THREE.Vector3(MAIN_POSE.pos.x, MAIN_POSE.pos.y, MAIN_POSE.pos.z),
      look: new THREE.Vector3(MAIN_POSE.look.x, MAIN_POSE.look.y, MAIN_POSE.look.z),
    };
  }

  // "Back to Keeper" while the main view is already up: no view change, just a
  // gentle turn of the camera onto her chair.
  function startReframe() {
    if (viewIsTweening(machine) || machine.current !== "main") return false;
    reframe = {
      t: 0,
      from: camLook.clone(),
      to: new THREE.Vector3(CHAIR_POS.x, SIT_Y + 0.3, CHAIR_POS.z),
    };
    return true;
  }

  function requestView(view, { force = false, wall = null } = {}) {
    if (view === "shelf" && wall !== null) shelfWall = wall;
    if (!viewRequest(machine, view, { force })) return false;
    reframe = null; // a real view change owns the camera
    // The user asserting a view while reading overrides the automatic restore.
    if (!force && readerOpen) viewBeforeReader = null;
    const pose = poseFor(machine.target);
    viewTween.active = true;
    viewTween.fromPos.copy(camera.position);
    viewTween.fromLook.copy(camLook);
    viewTween.toPos.copy(pose.pos);
    viewTween.toLook.copy(pose.look);
    if (machine.target === "shelf") {
      shelfDistance = pose.distance ?? shelfDistance;
      rescaleSpines(shelfWall, pose.distance);
      setShelfBase(pose, { reset: true });
    } else {
      shelfBasePose = null;
      panOffset = { u: 0, v: 0 };
      shelfPanDrag.cancel();
    }
    viewsUi?.setActive?.(machine.target);
    return true;
  }

  // Remember the untouched shelf framing and how far it may pan (the case's
  // overflow past the viewport). Entering the view resets the offset; a
  // resize only re-clamps it.
  function setShelfBase(pose, { reset = false } = {}) {
    shelfBasePose = { pos: pose.pos.clone(), look: pose.look.clone() };
    const { width, height } = viewport();
    panLim = panLimits({
      layout: SHELF_LAYOUT,
      distance: pose.distance ?? shelfDistance ?? 0,
      fovDeg: camera?.fov ?? 50,
      aspect: width / Math.max(1, height),
      bookH: BOOK_H,
    });
    panOffset = reset ? { u: 0, v: 0 } : clampOffset(panOffset, panLim);
  }

  // base pose + clamped offset -> camera. Position and lookAt shift by the
  // same vector: a pure truck along the wall (screen x) and up/down, never a
  // zoom or a turn.
  function applyShelfPan() {
    if (!shelfBasePose || viewTween.active || machine.current !== "shelf") return;
    const rz = shelfWall === 0 ? -1 : 1; // the camera's screen-right, in world z
    camera.position.set(
      shelfBasePose.pos.x,
      shelfBasePose.pos.y + panOffset.v,
      shelfBasePose.pos.z + rz * panOffset.u,
    );
    camLook.set(
      shelfBasePose.look.x,
      shelfBasePose.look.y + panOffset.v,
      shelfBasePose.look.z + rz * panOffset.u,
    );
    camera.lookAt(camLook);
  }

  // Picking a book leaves for the fetch + reader: remember where we were
  // (restored on "reader:closed") and jump to the main framing.
  function leaveForReader() {
    if (viewBeforeReader === null) viewBeforeReader = machine.target ?? machine.current;
    requestView("main", { force: true });
  }

  const onViewResize = () => {
    if ((machine.target ?? machine.current) !== "shelf") return;
    const pose = poseFor("shelf");
    shelfDistance = pose.distance ?? shelfDistance;
    setShelfBase(pose); // new framing, re-clamped pan offset
    if (machine.target === "shelf") {
      viewTween.toPos.copy(pose.pos);
      viewTween.toLook.copy(pose.look);
    } else {
      camera.position.copy(pose.pos);
      camLook.copy(pose.look);
      camera.lookAt(camLook);
      applyShelfPan();
    }
    rescaleSpines(shelfWall, pose.distance);
  };
  globalThis.addEventListener?.("resize", onViewResize);

  function sizeRenderer() {
    const { width, height } = viewport();
    renderer.setSize(width, height);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
  }
  const onResize = () => renderer && sizeRenderer();

  if (!renderer && container) {
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      ownRenderer = true;
      sizeRenderer();
      container.appendChild(renderer.domElement);
      globalThis.addEventListener?.("resize", onResize);
    } catch (err) {
      console.warn("[memory-keepers] interior: WebGL unavailable, running headless:", err);
      renderer = null;
    }
  }

  // --- sit/fetch state machine (pure transitions + scene-side animation) ---
  const chairForward = { x: Math.sin(CHAIR_ANGLE), z: Math.cos(CHAIR_ANGLE) };
  const seatPos = new THREE.Vector3(CHAIR_POS.x, SIT_Y, CHAIR_POS.z);
  const chairFront = new THREE.Vector3(
    CHAIR_POS.x + chairForward.x * 0.85,
    STAND_Y,
    CHAIR_POS.z + chairForward.z * 0.85,
  );

  const fetching = {
    state: SIT_FETCH.initial,
    t: 0,
    entry: null, // book being fetched
    floatTo: new THREE.Vector3().copy(FLOAT_POS), // where the grabbed book floats
    floatScale: 1.6, // how big it grows on the way
    walkTarget: new THREE.Vector3(),
    hopFrom: new THREE.Vector3(),
    hopTo: new THREE.Vector3(),
    bookFrom: new THREE.Vector3(),
    pendingSlug: null, // pick that landed mid-hop
  };
  const bookTweens = []; // { entry, from, t } books flying back to the shelf
  let sitK = 1; // 0 standing .. 1 squished into the cushion
  let doze = DOZE.initial; // awake | settling | dozing (see DOZE)

  // Settling -> dozing once she is back on her chair with nothing open.
  function syncDoze() {
    if (doze === "settling" && fetching.state === "sitting" && !readerOpen) {
      doze = nextDozeState(doze, "seated");
      keeperHandle?.setSleeping?.(true);
    }
  }

  function applyEvent(event) {
    const next = nextKeeperState(fetching.state, event);
    if (next === fetching.state && event !== "pick") return;
    fetching.state = next;
    fetching.t = 0;
    if (next === "hopOff") {
      fetching.hopFrom.copy(rig.position);
      fetching.hopTo.copy(chairFront);
    } else if (next === "walkToShelf") {
      keeperHandle?.setWalking?.(true);
    } else if (next === "grabbing") {
      keeperHandle?.setWalking?.(false);
      if (fetching.entry) {
        fetching.bookFrom.copy(fetching.entry.mesh.position);
        fetching.floatTo.copy(FLOAT_POS);
        fetching.floatScale = 1.6;
      }
    } else if (next === "walkToChair") {
      keeperHandle?.setWalking?.(true);
      returnFloatingBook();
    } else if (next === "hopOn") {
      keeperHandle?.setWalking?.(false);
      fetching.hopFrom.copy(rig.position);
      fetching.hopTo.copy(seatPos);
    } else if (next === "sitting") {
      rig.position.copy(seatPos);
    }
  }

  function returnFloatingBook() {
    if (!fetching.entry) return;
    bookTweens.push({
      entry: fetching.entry,
      from: fetching.entry.mesh.position.clone(),
      fromScale: fetching.entry.mesh.scale.x,
      fromRotX: fetching.entry.mesh.rotation.x,
      t: 0,
    });
    fetching.entry = null;
  }

  function shelfTargetFor(entry) {
    return new THREE.Vector3(
      entry.base.x + entry.inward * 0.85,
      STAND_Y,
      Math.max(-ROOM_HALF + 0.6, Math.min(ROOM_HALF - 0.6, entry.base.z)),
    );
  }

  function startPick(slug) {
    if (!slug) return;
    if (doze !== "awake") {
      // She is dozing (or settling into it): never wake her for a read; the
      // reader opens on its own and she sleeps through it.
      leaveForReader();
      readerOpen = true;
      bus?.emit("book:open", { keeperId, slug });
      return;
    }
    const entry = books.find((b) => b.slug === slug);
    if (!entry) {
      // No mesh (books still loading): still open the reader.
      leaveForReader();
      readerOpen = true;
      bus?.emit("book:open", { keeperId, slug });
      return;
    }
    if (fetching.entry === entry && (fetching.state === "grabbing" || fetching.state === "waiting")) {
      return; // already fetching this one
    }
    leaveForReader();
    if (fetching.state === "hopOff" || fetching.state === "hopOn") {
      fetching.pendingSlug = slug; // finish the hop first
      return;
    }
    if (fetching.entry && fetching.entry !== entry) returnFloatingBook();
    fetching.entry = entry;
    fetching.walkTarget.copy(shelfTargetFor(entry));
    applyEvent("pick");
  }

  // --- hover: slide the book out + a floating DOM label ---
  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  let pointerInside = false;
  let hovered = null; // book entry or the hintBook
  let labelEl = null;
  const clickTarget = renderer?.domElement ?? container;

  function eventNdc(e) {
    const rect = clickTarget?.getBoundingClientRect?.();
    if (!rect || !rect.width || !rect.height) return false;
    pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    return true;
  }

  // First raycast hit as a plain descriptor for pickAction: books and the
  // hint book keep priority naturally (nearest hit wins), the keeper herself
  // opens the talk panel, the guest chair and the bookcases are the view
  // hotspots.
  function pickHit(ndc) {
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(
      bookGroup.children.concat(hotspotMeshes, keeperPickMeshes),
      false,
    )[0];
    if (!hit) return null;
    const ud = hit.object.userData;
    if (ud.hint) return { hint: true, entry: hintBook };
    if (ud.slug) return { slug: ud.slug, entry: books.find((b) => b.mesh === hit.object) ?? null };
    if (ud.pick === "keeper") return { keeper: true };
    if (ud.hotspot) return { hotspot: ud.hotspot, wall: ud.wall };
    return null;
  }

  function hotspotKeyFor(action) {
    return action.view === "chairs" ? "chair" : `shelf${action.wall}`;
  }

  function setHovered(entry) {
    if (hovered === entry) return;
    hovered = entry;
    if (!labelEl) return;
    if (!entry) {
      labelEl.hidden = true;
      return;
    }
    labelEl.hidden = false;
    labelEl.textContent = "";
    const title = doc.createElement("strong");
    const dateEl = doc.createElement("span");
    if (entry === hintBook) {
      title.textContent = "her first memory is unwritten";
      dateEl.textContent = "tell her something";
    } else {
      title.textContent = entry.title;
      dateEl.textContent = entry.date;
    }
    labelEl.appendChild(title);
    if (dateEl.textContent) labelEl.appendChild(dateEl);
  }

  function onPointerMove(e) {
    const delta = shelfPanDrag.move(e.clientX ?? 0, e.clientY ?? 0);
    if (delta) {
      const wpp = worldPerPixel({
        distance: shelfDistance ?? 0,
        fovDeg: camera?.fov ?? 50,
        viewportH: viewport().height,
      });
      panOffset = applyDrag(panOffset, delta, { worldPerPx: wpp, limits: panLim });
      applyShelfPan();
      setHovered(null);
      hotspotHover = null;
      if (container) container.style.cursor = "grabbing";
    }
    pointerInside = eventNdc(e);
  }
  function onPointerDown(e) {
    suppressClick = false; // never carry a swallowed click across presses
    if (e.button !== undefined && e.button !== 0) return;
    if (machine.current !== "shelf" || viewIsTweening(machine) || readerOpen) return;
    if (panLim.maxU <= 0 && panLim.maxV <= 0) return; // the whole case fits
    shelfPanDrag.down(e.clientX ?? 0, e.clientY ?? 0);
  }
  function onPointerUp() {
    if (shelfPanDrag.up().wasDrag) suppressClick = true;
  }
  function onPointerLeave() {
    shelfPanDrag.cancel();
    pointerInside = false;
    setHovered(null);
    hotspotHover = null;
    if (container) container.style.cursor = "";
  }

  function onClick(e) {
    if (suppressClick) {
      // the click that ends a shelf drag is the drag, not a pick
      suppressClick = false;
      return;
    }
    if (!camera || !eventNdc(e)) return;
    const action = pickAction(pickHit(pointerNdc), {
      view: machine.current,
      tweening: viewIsTweening(machine),
    });
    if (!action) return;
    if (action.type === "hint" || action.type === "keeper")
      bus?.emit("keeper:selected", { keeperId }); // same panel as outside
    else if (action.type === "pick") startPick(action.slug);
    else if (action.type === "view") requestView(action.view, { wall: action.wall });
  }
  clickTarget?.addEventListener?.("click", onClick);
  clickTarget?.addEventListener?.("pointerdown", onPointerDown);
  clickTarget?.addEventListener?.("pointermove", onPointerMove);
  clickTarget?.addEventListener?.("pointerup", onPointerUp);
  clickTarget?.addEventListener?.("pointercancel", onPointerLeave);
  clickTarget?.addEventListener?.("pointerleave", onPointerLeave);

  const onKey = (e) => {
    // Overlays and panels stop Esc in the capture phase before it gets here,
    // and onKeyCapture below swallows it while a non-main view is up.
    if (e.key === "Escape") bus?.emit("interior:exit");
  };
  doc?.addEventListener?.("keydown", onKey);

  // Esc layering, capture phase: with the reader open (or focus inside a UI
  // panel) the overlay owns Esc; from a non-main view Esc returns to main
  // WITHOUT exiting the interior (stopPropagation keeps it from main.js's
  // bubble-phase handler); mid-tween it is swallowed (input lock); from the
  // settled main view it falls through to the bubble handlers above.
  const onKeyCapture = (e) => {
    if (e.key !== "Escape" || disposed) return;
    if (readerOpen) return;
    const t = e.target;
    if (t && t.nodeType === 1 && typeof t.closest === "function" && t.closest("#ui")) return;
    if (viewIsTweening(machine)) {
      e.stopPropagation();
      return;
    }
    if (machine.current !== "main") {
      e.stopPropagation();
      requestView("main");
    }
  };
  doc?.addEventListener?.("keydown", onKeyCapture, true);

  if (container && doc) {
    if (!doc.getElementById(STYLE_ID)) {
      const style = doc.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      doc.head.appendChild(style);
    }
    labelEl = doc.createElement("div");
    labelEl.className = "mk-book-label";
    labelEl.hidden = true;
    container.appendChild(labelEl);

    // Navigation cluster (bottom-right: Back to Keeper / Sit beside her /
    // Bookshelf / Back to the island) + the room readout (bottom-left: name,
    // level, shelved count, rest words). Loaded like keeper_mesh.js: the scene
    // runs headless without them; clicks arrive as "interior:view" /
    // "interior:exit" on the bus.
    import("../ui/interior_views.js")
      .then((mod) => {
        if (disposed) return;
        viewsUi = mod.createInteriorViews({
          root: container,
          bus,
          active: machine.target ?? machine.current,
        });
        readoutUi = mod.createInteriorReadout({ root: container, bus, state, keeperId });
      })
      .catch((err) => {
        console.warn("[memory-keepers] interior: room UI unavailable:", err);
      });
  }

  // --- bus wiring ---
  const on = (event, fn) => offs.push(bus?.on?.(event, fn) ?? (() => {}));
  on("reader:closed", () => {
    applyEvent("readerClosed");
    readerOpen = false;
    const back = viewBeforeReader;
    viewBeforeReader = null;
    if (back && back !== "main" && back !== (machine.target ?? machine.current)) {
      requestView(back, { force: true });
    }
  });
  on("interior:view", (p) => {
    if (!p?.view) return;
    // "Back to Keeper" with the main view already settled: gentle re-frame on
    // her instead of a (rejected) same-view tween.
    if (p.view === "main" && machine.current === "main" && !viewIsTweening(machine)) {
      startReframe();
      return;
    }
    // Sitting beside her is starting a conversation: the talk panel opens
    // with the view (dialog.open is idempotent when it is already hers).
    if (p.view === "chairs") bus?.emit("keeper:selected", { keeperId });
    requestView(p.view);
  });
  on("book:created", (p) => {
    if (p?.keeperId === keeperId && p.book) addBookMesh(p.book);
  });
  on("book:destroyed", (p) => {
    if (p?.keeperId === keeperId) removeBookMesh(p.slug);
  });
  on("keeper:sleep", (p) => {
    if (p?.keeperId !== keeperId) return;
    doze = nextDozeState(doze, "sleep");
    if (doze !== "settling") return;
    // A reader flow in progress settles on its own once the reader closes.
  });
  on("keeper:rested", (p) => {
    if (p?.keeperId !== keeperId) return;
    doze = nextDozeState(doze, "rested");
    keeperHandle?.setSleeping?.(false);
    keeperHandle?.setTired?.(0); // she comes back rested
  });
  on("state:loaded", () => {
    const fresh = state.keepers?.find((a) => a.id === keeperId);
    if (fresh) keeperRec = fresh;
    // Same rule as the overworld: the tired look tracks session status on
    // every refresh (unless she is dozing right now).
    if (doze === "awake") keeperHandle?.setTired?.(levelFor ? levelFor(keeperRec) : 0);
  });

  // --- frame update ---
  let elapsed = 0;
  const walkDir = new THREE.Vector3();
  const labelWorld = new THREE.Vector3();

  function update(dt) {
    elapsed += dt;
    keeperHandle?.update?.(dt);

    // warm lights breathe: lamp glows steady-ish, the fire really flickers
    lampLight.intensity = 14 + Math.sin(elapsed * 7) * 0.5;
    fireLight.intensity = 6 + Math.sin(elapsed * 11) * 1.1 + Math.sin(elapsed * 23 + 1.7) * 0.7;
    for (let i = 0; i < flames.length; i++) {
      const f = flames[i];
      const s = 1 + Math.sin(elapsed * (9 + i * 3) + i * 2.1) * 0.18;
      f.scale.set(s, 1 + Math.sin(elapsed * (7 + i * 2) + i) * 0.24, s);
    }
    if (hintBook) {
      hintBook.mesh.position.y = hintBook.baseY + Math.sin(elapsed * 2.2) * 0.02;
      hintBook.mesh.material.emissiveIntensity = 0.55 + Math.sin(elapsed * 2.6) * 0.25;
    }

    // --- sit/fetch progression ---
    // the fetched book can vanish mid-fetch (destroyed): send her home
    if ((fetching.state === "grabbing" || fetching.state === "waiting") && !fetching.entry) {
      applyEvent("abort");
    }

    // Doze settles once she is seated.
    syncDoze();
    const st = fetching.state;
    fetching.t += dt;
    if (st === "sitting") {
      sitK = Math.min(1, sitK + dt * 4);
      if (fetching.pendingSlug) {
        const slug = fetching.pendingSlug;
        fetching.pendingSlug = null;
        startPick(slug);
      }
    } else {
      sitK = Math.max(0, sitK - dt * 5);
    }
    // cushion squash eases with sitK; feet stay above the floor either way
    squash.scale.set(1 + 0.05 * sitK, 1 - 0.09 * sitK, 1 + 0.05 * sitK);

    if (st === "hopOff" || st === "hopOn") {
      const u = Math.min(1, fetching.t / HOP_SECONDS);
      const p = hopArc(fetching.hopFrom, fetching.hopTo, easeInOut(u), 0.4);
      rig.position.set(p.x, p.y, p.z);
      if (u >= 1) {
        applyEvent("done");
        if (fetching.state === "walkToShelf" && fetching.pendingSlug) {
          const slug = fetching.pendingSlug;
          fetching.pendingSlug = null;
          startPick(slug);
        }
      }
    } else if (st === "walkToShelf" || st === "walkToChair") {
      const target = st === "walkToShelf" ? fetching.walkTarget : chairFront;
      walkDir.subVectors(target, rig.position);
      walkDir.y = 0;
      const dist = walkDir.length();
      if (dist < 0.1) {
        applyEvent("arrived");
        if (fetching.state === "grabbing" && fetching.entry) {
          // face the wall the book sits on
          rig.rotation.y = fetching.entry.wall === 0 ? -Math.PI / 2 : Math.PI / 2;
        }
      } else {
        walkDir.normalize();
        rig.position.addScaledVector(walkDir, Math.min((cfg?.WALK_SPEED ?? 1.4) * dt, dist));
        rig.position.y = STAND_Y;
        rig.rotation.y = Math.atan2(walkDir.x, walkDir.z);
      }
    } else if (st === "grabbing" && fetching.entry) {
      const u = Math.min(1, fetching.t / GRAB_SECONDS);
      const k = easeOutCubic(u);
      const mesh = fetching.entry.mesh;
      mesh.position.lerpVectors(fetching.bookFrom, fetching.floatTo, k);
      mesh.rotation.x = -0.18 * k;
      const s = 1 + (fetching.floatScale - 1) * k;
      mesh.scale.set(s, s, s);
      if (u >= 1) {
        readerOpen = true;
        bus?.emit("book:open", { keeperId, slug: fetching.entry.slug });
        applyEvent("opened");
      }
    } else if (st === "waiting" && fetching.entry) {
      fetching.entry.mesh.position.y = fetching.floatTo.y + Math.sin(fetching.t * 3) * 0.03;
    } else if (st === "sitting") {
      rig.position.copy(seatPos);
      // settle facing back toward the room
      const target = CHAIR_ANGLE;
      let delta = target - rig.rotation.y;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      rig.rotation.y += delta * Math.min(1, dt * 6);
    }

    // --- books flying home ---
    for (let i = bookTweens.length - 1; i >= 0; i--) {
      const tween = bookTweens[i];
      tween.t += dt;
      const u = Math.min(1, tween.t / RETURN_SECONDS);
      const k = easeOutCubic(u);
      const mesh = tween.entry.mesh;
      mesh.position.lerpVectors(tween.from, tween.entry.base, k);
      mesh.rotation.x = tween.fromRotX * (1 - k);
      const s = tween.fromScale + (1 - tween.fromScale) * k;
      mesh.scale.set(s, s, s);
      if (u >= 1) {
        mesh.position.copy(tween.entry.base);
        mesh.rotation.x = 0;
        mesh.scale.set(1, 1, 1);
        bookTweens.splice(i, 1);
      }
    }

    // --- view camera: eased tween between views, gentle sway when seated ---
    if (viewTween.active) {
      const step = viewStep(machine, dt);
      camera.position.lerpVectors(viewTween.fromPos, viewTween.toPos, step.k);
      camLook.lerpVectors(viewTween.fromLook, viewTween.toLook, step.k);
      camera.lookAt(camLook);
      if (step.settled) {
        viewTween.active = false;
        swayT = 0;
        viewsUi?.setActive?.(machine.current);
        applyShelfPan(); // resize mid-tween may have left a clamped offset
      }
    } else if (reframe) {
      // "Back to Keeper" from the settled main view: the camera stays put and
      // gently turns until she is centered.
      reframe.t += dt;
      const u = Math.min(1, reframe.t / REFRAME_SECONDS);
      camLook.lerpVectors(reframe.from, reframe.to, easeInOut(u));
      camera.lookAt(camLook);
      if (u >= 1) reframe = null;
    } else if (machine.current === "chairs") {
      // sitting beside her: a soft breathing sway, ramped in so the tween
      // hands over without a pop
      swayT += dt;
      const ramp = Math.min(1, swayT / 1.5);
      camera.position.set(
        CHAIRS_POSE.pos.x + Math.sin(elapsed * 0.55) * 0.022 * ramp,
        CHAIRS_POSE.pos.y + Math.sin(elapsed * 1.05) * 0.014 * ramp,
        CHAIRS_POSE.pos.z + Math.cos(elapsed * 0.4) * 0.018 * ramp,
      );
      camLook.set(
        CHAIRS_POSE.look.x,
        CHAIRS_POSE.look.y + Math.sin(elapsed * 0.8) * 0.012 * ramp,
        CHAIRS_POSE.look.z,
      );
      camera.lookAt(camLook);
    }

    // --- hover: books slide out, view hotspots glow, cursor tells ---
    if (pointerInside && camera && !shelfPanDrag.dragging) {
      const hit = pickHit(pointerNdc);
      const action = pickAction(hit, {
        view: machine.current,
        tweening: viewIsTweening(machine),
      });
      const bookish = action && (action.type === "pick" || action.type === "hint");
      setHovered(bookish ? (hit?.entry ?? null) : null);
      hotspotHover = action?.type === "view" ? hotspotKeyFor(action) : null;
      const pannable =
        machine.current === "shelf" &&
        !viewIsTweening(machine) &&
        (panLim.maxU > 0 || panLim.maxV > 0);
      if (container) container.style.cursor = action ? "pointer" : pannable ? "grab" : "";
    }
    for (const [key, rec] of hotspotGlow) {
      const target = hotspotHover === key ? 1 : 0;
      rec.k += (target - rec.k) * Math.min(1, dt * 8);
      for (const mat of rec.mats) mat.emissiveIntensity = 0.22 * rec.k;
    }
    for (const entry of books) {
      const target = entry === hovered ? 1 : 0;
      entry.hoverK += (target - entry.hoverK) * Math.min(1, dt * 10);
      if (entry !== fetching.entry && !bookTweens.some((t) => t.entry === entry)) {
        entry.mesh.position.x = entry.base.x + entry.inward * HOVER_SLIDE * entry.hoverK;
      }
    }
    if (labelEl && hovered && camera) {
      const mesh = hovered.mesh;
      labelWorld.setFromMatrixPosition(mesh.matrixWorld);
      // matrixWorld lags one frame on its own renderer; position is enough
      labelWorld.copy(mesh.position);
      labelWorld.y += BOOK_H * 0.75;
      labelWorld.project(camera);
      const place = labelPlacement(labelWorld, viewport());
      labelEl.hidden = !place.visible;
      labelEl.style.left = `${place.left}px`;
      labelEl.style.top = `${place.top}px`;
    }

    if (ownRenderer && renderer) renderer.render(scene, camera);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const off of offs) off();
    clickTarget?.removeEventListener?.("click", onClick);
    clickTarget?.removeEventListener?.("pointerdown", onPointerDown);
    clickTarget?.removeEventListener?.("pointermove", onPointerMove);
    clickTarget?.removeEventListener?.("pointerup", onPointerUp);
    clickTarget?.removeEventListener?.("pointercancel", onPointerLeave);
    clickTarget?.removeEventListener?.("pointerleave", onPointerLeave);
    doc?.removeEventListener?.("keydown", onKey);
    doc?.removeEventListener?.("keydown", onKeyCapture, true);
    globalThis.removeEventListener?.("resize", onResize);
    globalThis.removeEventListener?.("resize", onViewResize);
    if (container) container.style.cursor = "";
    labelEl?.remove();
    viewsUi?.dispose?.();
    viewsUi = null;
    readoutUi?.dispose?.();
    readoutUi = null;
    keeperHandle?.dispose?.();
    for (const entry of books) disposeEntry(entry);
    books.length = 0;
    removeHintBook();
    for (const res of disposables) res?.dispose?.();
    if (ownRenderer && renderer) {
      renderer.dispose();
      renderer.domElement?.remove();
    }
  }

  return {
    scene,
    group: scene,
    camera,
    keeperId,
    update,
    dispose,
    pick: startPick,
    keeperState: () => fetching.state,
    dozeState: () => doze,
    view: () => machine.current,
    viewTarget: () => machine.target,
    setView: (view, opts) => requestView(view, opts),
    reframing: () => reframe !== null,
  };
}
