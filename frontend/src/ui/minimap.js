// Bottom-left minimap: a rounded panel with a canvas drawing a top-down view
// of the world. Scene-agnostic: static layout comes straight from
// sim/world.js (layoutWorld over state.keepers), live positions arrive on the
// bus event "minimap:update" {keepers: [{id, x, z}], camera: {x, z, angle}}
// (camera angle = atan2(dir.x, dir.z) of the look direction, i.e. measured
// from +z). Drawn layers: the REAL irregular coastline (world.heightAt
// sampled over a grid once per layout into an above-water mask, rendered as
// a filled offscreen image scaled up with smoothing; district tints mixed
// from nightMaskAt: daylight green village, deep blue/purple unconscious
// quarter, sandy fringe near the waterline), street polylines including the
// ridge road between the districts, faint rings on empty (undiscovered) plot
// sites, house dots tinted by keeper palette, keeper dots (all keeper pink), and a
// camera frustum wedge. Hosts without ImageData (mocked canvas) fall back to
// the two district discs. Clicking the map emits "minimap:jump" {x, z} (the
// overworld scene moves the camera there) and plays a soft expanding ping
// ring at the click point.
//
//   const minimap = createMinimap({ root, state, bus, config });
//   minimap.dispose();

import { layoutWorld } from "../sim/world.js";
import { injectStyle } from "./holo/holo.js";

const STYLE_ID = "mk-minimap-style";
const CSS = `
.mk-minimap{position:absolute;left:16px;bottom:16px;z-index:20;padding:7px;border-radius:6px;background:repeating-linear-gradient(0deg,rgba(255,196,128,.05) 0 1px,rgba(0,0,0,0) 1px 3px),rgba(24,12,4,.85);backdrop-filter:blur(6px);border:1px solid var(--line,rgba(255,166,64,.42));border-top:2px solid var(--pink,#ffb658);box-shadow:0 0 18px rgba(255,150,40,.2),0 6px 18px rgba(0,0,0,.5);}
.mk-minimap canvas{display:block;border-radius:3px;cursor:crosshair;}
`;

// ---------------------------------------------------------------------------
// Pure helpers (projection + ping math) -- tested in tests/minimap.test.js
// ---------------------------------------------------------------------------

const cssHex = (hex) => `#${(hex & 0xffffff).toString(16).padStart(6, "0")}`;

// World-space bounding box covering every district (plus a margin), so the
// map framing is stable regardless of where the camera is.
export function computeMapBounds(isles = {}, margin = 2) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const isle of Object.values(isles)) {
    if (!isle?.center || !Number.isFinite(isle.radius)) continue;
    minX = Math.min(minX, isle.center.x - isle.radius - margin);
    maxX = Math.max(maxX, isle.center.x + isle.radius + margin);
    minZ = Math.min(minZ, isle.center.z - isle.radius - margin);
    maxZ = Math.max(maxZ, isle.center.z + isle.radius + margin);
  }
  if (!Number.isFinite(minX)) return { minX: -16, maxX: 16, minZ: -16, maxZ: 16 };
  return { minX, maxX, minZ, maxZ };
}

// Uniform-scale projector between world xz and canvas pixels (aspect
// preserved, content centered). toWorld is the exact inverse of toCanvas.
export function makeProjector(bounds, width, height, padding = 8) {
  const spanX = Math.max(1e-6, bounds.maxX - bounds.minX);
  const spanZ = Math.max(1e-6, bounds.maxZ - bounds.minZ);
  const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanZ);
  const offX = (width - spanX * scale) / 2;
  const offY = (height - spanZ * scale) / 2;
  return {
    scale,
    toCanvas(x, z) {
      return { x: offX + (x - bounds.minX) * scale, y: offY + (z - bounds.minZ) * scale };
    },
    toWorld(cx, cy) {
      return { x: bounds.minX + (cx - offX) / scale, z: bounds.minZ + (cy - offY) / scale };
    },
  };
}

// Camera frustum wedge as three world-space points: apex at the camera,
// two edge points fanned around the look angle (atan2(dir.x, dir.z)).
export function wedgePoints(cam = {}, { length = 9, halfAngle = 0.42 } = {}) {
  const a = cam.angle ?? 0;
  const x = cam.x ?? 0;
  const z = cam.z ?? 0;
  return [
    { x, z },
    { x: x + Math.sin(a - halfAngle) * length, z: z + Math.cos(a - halfAngle) * length },
    { x: x + Math.sin(a + halfAngle) * length, z: z + Math.cos(a + halfAngle) * length },
  ];
}

// Click-ping animation state: an expanding, fading ring. Pure so the timing
// is testable without rAF.
export const PING_MS = 650;

export function pingState(elapsedMs, duration = PING_MS) {
  const t = Math.min(1, Math.max(0, elapsedMs / duration));
  return {
    t,
    radius: 3 + t * 11,
    alpha: 0.85 * (1 - t),
    done: elapsedMs >= duration,
  };
}

// ---------------------------------------------------------------------------
// Coastline mask (pure helpers) -- the real irregular silhouette
// ---------------------------------------------------------------------------

// Bays and headlands overshoot the nominal district radii, so the map frame
// gives the coast more margin than the old two-circle framing did.
export const COAST_MARGIN = 6;
export const COAST_GRID = { cols: 96, rows: 80 };

// Sample world.heightAt over a cols x rows grid across `bounds` (cell
// centers). Returns the above-water mask plus per-cell night blend and
// height, everything the tint pass needs. Pure; called once per layout.
export function sampleLandMask(world, bounds, cols = COAST_GRID.cols, rows = COAST_GRID.rows) {
  const land = new Uint8Array(cols * rows);
  const night = new Float32Array(cols * rows);
  const heights = new Float32Array(cols * rows);
  const waterLevel = world?.waterLevel ?? 0;
  const spanX = bounds.maxX - bounds.minX;
  const spanZ = bounds.maxZ - bounds.minZ;
  for (let j = 0; j < rows; j++) {
    const z = bounds.minZ + ((j + 0.5) / rows) * spanZ;
    for (let i = 0; i < cols; i++) {
      const x = bounds.minX + ((i + 0.5) / cols) * spanX;
      const idx = j * cols + i;
      const h = world.heightAt(x, z);
      heights[idx] = h;
      if (h > waterLevel + 0.05) {
        land[idx] = 1;
        night[idx] = world.nightMaskAt ? world.nightMaskAt(x, z) : 0;
      }
    }
  }
  return { cols, rows, land, night, heights, waterLevel };
}

// The unconscious quarter's deep blue/purple night tint (one source for the
// isle fill and the mask blend).
const NIGHT_RGB = [69, 58, 102];

// Mask -> RGBA pixels (row-major, cols x rows): water transparent, land mixed
// from the day green to the night purple by nightMaskAt, with a sandy fringe
// where the land sits just above the waterline. Pure.
export function maskToRgba(
  mask,
  { landRgb = [127, 176, 105], nightRgb = NIGHT_RGB, sandRgb = [214, 189, 138] } = {},
) {
  const { cols, rows, land, night, heights, waterLevel } = mask;
  const out = new Uint8ClampedArray(cols * rows * 4);
  for (let idx = 0; idx < cols * rows; idx++) {
    if (!land[idx]) continue; // water stays transparent (panel backdrop shows)
    const t = night[idx];
    // beach fringe fades out across the night quarter (dark sand reads odd)
    const fringe = Math.max(0, Math.min(1, 1 - (heights[idx] - (waterLevel + 0.05)) / 0.35));
    const sand = fringe * (1 - 0.8 * t);
    const o = idx * 4;
    for (let c = 0; c < 3; c++) {
      const base = landRgb[c] + (nightRgb[c] - landRgb[c]) * t;
      out[o + c] = base + (sandRgb[c] - base) * sand;
    }
    out[o + 3] = 255;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

const MAP_W = 190;
const MAP_H = 158;

// District tints: the village is always daylight green, the unconscious
// quarter always a deep blue/purple night (NIGHT_RGB).
const UNCONSCIOUS_FILL = `rgb(${NIGHT_RGB.join(", ")})`;
const WATER_FILL = "rgba(27, 44, 66, 0.92)";

export function createMinimap({ root, state, bus, config } = {}) {
  const doc = root.ownerDocument;
  injectStyle(doc, STYLE_ID, CSS);
  const win = doc.defaultView ?? globalThis;
  const colors = config?.colors ?? {};
  const keeperTone = cssHex(colors.keeperTone ?? 0x9fdcff);
  const islandHex = colors.island ?? 0x7fb069;
  const islandGreen = cssHex(islandHex);

  const panel = doc.createElement("div");
  panel.className = "mk-minimap";
  panel.setAttribute("aria-label", "minimap");

  const canvas = doc.createElement("canvas");
  const dpr = win.devicePixelRatio ?? 1;
  canvas.width = Math.round(MAP_W * dpr);
  canvas.height = Math.round(MAP_H * dpr);
  canvas.style.width = `${MAP_W}px`;
  canvas.style.height = `${MAP_H}px`;
  panel.appendChild(canvas);
  root.appendChild(panel);

  let ctx = null;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    ctx = null; // jsdom without a canvas backend; panel still mounts + clicks
  }

  let layout = null;
  let layoutKey = null;
  let projector = null;
  let bounds = null;
  let coast = null; // offscreen canvas holding the filled coastline mask
  let live = { keepers: [], camera: null };
  let ping = null; // { cx, cy, start }
  let pingRaf = 0;
  let disposed = false;
  const now = () => (win.performance ?? globalThis.performance ?? Date).now();

  // Rasterize the sampled land mask into a small offscreen canvas (one pixel
  // per grid cell); draw() scales it up with smoothing so the coast reads
  // soft and irregular. Hosts without ImageData support (jsdom's mocked
  // canvas) leave `coast` null and draw() falls back to the district discs.
  function buildCoast() {
    coast = null;
    try {
      const mask = sampleLandMask(layout, bounds);
      const rgba = maskToRgba(mask, {
        landRgb: [(islandHex >> 16) & 0xff, (islandHex >> 8) & 0xff, islandHex & 0xff],
      });
      const off = doc.createElement("canvas");
      off.width = mask.cols;
      off.height = mask.rows;
      const c2 = off.getContext("2d");
      if (!c2 || typeof c2.createImageData !== "function" || typeof c2.putImageData !== "function") return;
      const img = c2.createImageData(mask.cols, mask.rows);
      img.data.set(rgba);
      c2.putImageData(img, 0, 0);
      coast = off;
    } catch {
      coast = null;
    }
  }

  function ensureLayout() {
    const key = (state?.keepers ?? [])
      .map((a) => `${a.id}:${a.kind}`)
      .sort()
      .join("|");
    if (key === layoutKey && layout) return;
    layoutKey = key;
    layout = layoutWorld(state?.keepers ?? []);
    bounds = computeMapBounds(layout.isles, COAST_MARGIN);
    projector = makeProjector(bounds, MAP_W, MAP_H);
    buildCoast();
  }

  function paletteOf(keeperId) {
    return state?.keepers?.find((a) => a.id === keeperId)?.palette ?? {};
  }

  function draw() {
    ensureLayout();
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, MAP_W, MAP_H);

    // Water backdrop.
    ctx.fillStyle = WATER_FILL;
    ctx.fillRect(0, 0, MAP_W, MAP_H);

    // The landmass, always both districts: day/night is a place, not a time.
    // Preferred: the real irregular coastline (heightAt mask, night-tinted),
    // scaled up with smoothing. Fallback (no ImageData host): the old discs.
    if (coast && typeof ctx.drawImage === "function") {
      const tl = projector.toCanvas(bounds.minX, bounds.minZ);
      const br = projector.toCanvas(bounds.maxX, bounds.maxZ);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(coast, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    } else {
      const drawIsle = (isle, fill) => {
        const c = projector.toCanvas(isle.center.x, isle.center.z);
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.arc(c.x, c.y, isle.radius * projector.scale, 0, Math.PI * 2);
        ctx.fill();
      };
      drawIsle(layout.isles.main, islandGreen);
      drawIsle(layout.isles.unconscious, UNCONSCIOUS_FILL);
    }

    // Streets as polylines (includes the ridge road between the districts).
    // Older layouts without street data fall back to hub -> house spokes.
    ctx.strokeStyle = "rgba(255,255,255,.2)";
    ctx.lineWidth = 1.2;
    const streets = layout.streets ?? [];
    if (streets.length > 0) {
      for (const street of streets) {
        const pts = street.points ?? [];
        if (pts.length < 2) continue;
        ctx.beginPath();
        pts.forEach((pt, i) => {
          const c = projector.toCanvas(pt.x, pt.z);
          if (i === 0) ctx.moveTo(c.x, c.y);
          else ctx.lineTo(c.x, c.y);
        });
        ctx.stroke();
      }
    } else {
      for (const [, home] of Object.entries(layout.homes)) {
        const isle = layout.isles[home.isle];
        const a = projector.toCanvas(isle.center.x, isle.center.z);
        const b = projector.toCanvas(home.x, home.z);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    // Undiscovered plots: a faint ring per empty plot site, so the
    // pre-planned grid reads on the map exactly like the stone circles do
    // in the world.
    ctx.strokeStyle = "rgba(255,255,255,.28)";
    ctx.lineWidth = 1;
    for (const plot of layout.plots ?? []) {
      if (plot.occupied) continue;
      const p = projector.toCanvas(plot.x, plot.z);
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1.4, (plot.plotRadius ?? 2.6) * projector.scale * 0.45), 0, Math.PI * 2);
      ctx.stroke();
    }

    // House dots, tinted by each keeper's palette.
    for (const [keeperId, home] of Object.entries(layout.homes)) {
      const p = projector.toCanvas(home.x, home.z);
      ctx.fillStyle = paletteOf(keeperId).primary ?? keeperTone;
      ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
    }

    // Live keeper dots: all the same pink.
    ctx.fillStyle = keeperTone;
    for (const a of live.keepers ?? []) {
      if (!Number.isFinite(a?.x) || !Number.isFinite(a?.z)) continue;
      const p = projector.toCanvas(a.x, a.z);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Camera frustum wedge.
    if (live.camera) {
      const pts = wedgePoints(live.camera).map((w) => projector.toCanvas(w.x, w.z));
      ctx.fillStyle = "rgba(255,255,255,.16)";
      ctx.strokeStyle = "rgba(255,255,255,.55)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.lineTo(pts[2].x, pts[2].y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, 2, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,.8)";
      ctx.fill();
    }

    // Click ping: soft expanding ring at the jump point.
    if (ping) {
      const s = pingState(now() - ping.start);
      ctx.strokeStyle = `rgba(248,167,192,${s.alpha.toFixed(3)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(ping.cx, ping.cy, s.radius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function animatePing() {
    pingRaf = 0;
    if (disposed || !ping) return;
    if (pingState(now() - ping.start).done) {
      ping = null;
      draw(); // clear the ring
      return;
    }
    draw();
    if (typeof win.requestAnimationFrame === "function") {
      pingRaf = win.requestAnimationFrame(animatePing);
    } else {
      ping = null; // no rAF host: settle for the single frame already drawn
    }
  }

  function onClick(e) {
    ensureLayout();
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const cx = ((e.clientX - rect.left) / rect.width) * MAP_W;
    const cy = ((e.clientY - rect.top) / rect.height) * MAP_H;
    const world = projector.toWorld(cx, cy);
    ping = { cx, cy, start: now() };
    draw();
    if (!pingRaf && typeof win.requestAnimationFrame === "function") {
      pingRaf = win.requestAnimationFrame(animatePing);
    }
    bus?.emit("minimap:jump", { x: world.x, z: world.z });
  }
  canvas.addEventListener("click", onClick);

  function syncVisible(mode = state?.mode) {
    const key = String(mode ?? "overworld").split(":")[0];
    panel.style.display = key === "overworld" ? "" : "none";
  }
  syncVisible();

  const offs = [
    bus?.on?.("minimap:update", (p) => {
      live = { keepers: p?.keepers ?? [], camera: p?.camera ?? null };
      draw();
    }),
    bus?.on?.("state:loaded", () => draw()),
    bus?.on?.("mode:changed", (p) => syncVisible(p?.mode)),
  ].filter(Boolean);

  draw();

  return {
    dispose() {
      disposed = true;
      if (pingRaf && typeof win.cancelAnimationFrame === "function") {
        win.cancelAnimationFrame(pingRaf);
      }
      pingRaf = 0;
      ping = null;
      for (const off of offs) off();
      canvas.removeEventListener("click", onClick);
      panel.remove();
    },
  };
}
