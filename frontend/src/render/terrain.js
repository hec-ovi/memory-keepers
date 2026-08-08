// Ground, water and coast for the overworld: the heightfield terrain mesh
// (vertex colors x a procedural macro texture: grass grain, meadow mottling,
// contour/terrace hinting on slopes, clover + flower patches, worn dirt
// around doors and the plaza, mossy tones in the night quarter), depth-tinted
// water with moving sun/moon glints, an animated shore foam line, a rocky
// coast rim on the steep stretches (beaches stay bare sand), and dense
// instanced grass tufts with a soft sway. Everything is generated
// procedurally (canvas textures and displaced geometry only, nothing
// downloaded). Sky, clouds and stars live in render/sky.js.
//
// Pure helpers (groundShade, macroShade, grassPlacements, extractShoreline,
// foamMotion, coastSteepness) hold the color/placement math and are
// unit-tested; the build* factories are three.js-only and are never touched
// by tests.

import * as THREE from "three";
import { makeNoise2D, makeFbm2D, mulberry32, smoothstep } from "../sim/world.js";
import { mixHexColor, blendBand } from "./blend.js";

const clamp01 = (x) => Math.min(1, Math.max(0, x));

// ---------------------------------------------------------------------------
// Pure helpers (tested in tests/terrain_helpers.test.js)
// ---------------------------------------------------------------------------

const GROUND = {
  grassA: [0.28, 0.53, 0.18],
  grassB: [0.46, 0.68, 0.23],
  sandDry: [0.83, 0.75, 0.54],
  sandWet: [0.72, 0.64, 0.46],
  seafloor: [0.28, 0.4, 0.42],
  path: [0.66, 0.57, 0.4], // sandy lanes, like the diorama
  cobble: [0.58, 0.56, 0.54],
  rock: [0.45, 0.42, 0.4],
  nightGround: [0.26, 0.26, 0.42],
  nightPath: [0.4, 0.37, 0.5],
};

function mix3(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// Vertex color for a ground sample. All inputs are plain scalars so this is
// trivially testable: height (world y), slope (1 - normalY), street/hub
// weights (0..1), night-district mask (0..1), grass tone jitter (0..1),
// dither (0..1 noise sample that shifts every transition band so no material
// border is a hard line; 0.5 = the plain band). The coast reads
// grass -> dry sand -> wet sand -> seafloor.
export function groundShade({
  height = 0,
  slope = 0,
  streetW = 0,
  hubW = 0,
  nightW = 0,
  tone = 0.5,
  waterLevel = 0,
  dither = 0.5,
} = {}) {
  let c = mix3(GROUND.grassA, GROUND.grassB, clamp01(tone));
  // The beach band: dry sand above the waterline, wet sand at it, seafloor
  // fading in below. Every band is noise-dithered (blendBand) so the
  // grass-sand-water transitions read organic at close zoom.
  c = mix3(c, GROUND.sandDry, 1 - blendBand(height, waterLevel + 0.18, waterLevel + 0.62, dither));
  c = mix3(c, GROUND.sandWet, 1 - blendBand(height, waterLevel - 0.25, waterLevel + 0.1, dither, 0.4));
  c = mix3(c, GROUND.seafloor, 1 - blendBand(height, waterLevel - 1.4, waterLevel - 0.35, dither, 0.3));
  // Sandy lanes and the cobbled plaza / hub, edges dissolved by the dither:
  // the weight is perturbed only INSIDE its transition (w*(1-w) envelope),
  // so bare meadow stays bare and the roadbed core stays solid.
  const wobble = (clamp01(dither) - 0.5) * 1.2;
  const sw = clamp01(streetW);
  const swd = clamp01(sw + wobble * sw * (1 - sw));
  c = mix3(c, GROUND.path, swd * 0.9);
  const hw = clamp01(hubW);
  const hwd = clamp01(hw + wobble * hw * (1 - hw));
  c = mix3(c, GROUND.cobble, hwd * 0.92);
  // Rock face wherever the ground is steep (coast cliffs, ridge sides).
  c = mix3(c, GROUND.rock, blendBand(slope, 0.3, 0.55, dither, 0.5));
  // The unconscious quarter: deep-blue moonlit ground, darker but readable.
  const nightC = mix3(GROUND.nightGround, GROUND.nightPath, clamp01(Math.max(streetW, hubW)));
  c = mix3(c, nightC, clamp01(nightW) * 0.82);
  return c;
}

// Macro-texture texel (multiplied over the vertex colors): grass-blade grain,
// large-scale mottling, flower sparkle near the village, contour/terrace
// hinting on the slopes (the diorama look), worn dirt near doors and the
// plaza, moss in the night quarter. Inputs are 0..1 scalars; output rgb
// stays in [0, 1] and averages ~0.82 (the terrain material re-normalizes
// with a >1 color multiplier).
export function macroShade({
  grain = 0.5,
  mottle = 0.5,
  flowerW = 0,
  mossW = 0,
  contourW = 0,
  wearW = 0,
  sandW = 0,
} = {}) {
  const base = 0.72 + clamp01(grain) * 0.2; // blade-level luminance jitter
  let r = base;
  let g = base;
  let b = base;
  const sd = clamp01(sandW); // beach-transition texels: warm sandy lift
  r += sd * 0.16;
  g += sd * 0.09;
  b -= sd * 0.02;
  const m = (clamp01(mottle) - 0.5) * 0.16; // patchy meadows
  r += m * 0.9;
  g += m * 1.3;
  b += m * 0.5;
  const moss = clamp01(mossW); // night quarter: darker, cooler
  r -= moss * 0.12;
  g -= moss * 0.05;
  b += moss * 0.08;
  const f = clamp01(flowerW); // flower patches: lift red + blue (pink cast)
  r += f * 0.32;
  g += f * 0.08;
  b += f * 0.26;
  const ct = clamp01(contourW); // terrace lines: a soft dark warm cut
  r -= ct * 0.1;
  g -= ct * 0.11;
  b -= ct * 0.13;
  const w = clamp01(wearW); // worn dirt: warm, trodden, less green
  r += w * 0.1;
  g -= w * 0.04;
  b -= w * 0.12;
  return [clamp01(r), clamp01(g), clamp01(b)];
}

// How rocky a stretch of coast is: the SEAWARD drop per unit distance at a
// shoreline point (the inland dune bank does not count; a beach may rise to
// the meadow behind it). Gentle beach shelves stay under the threshold and
// get no rocky rim; cliffy stretches rise above it. Pure; tested.
export function coastSteepness(world, x, z, span = 1.6) {
  const eps = 0.6;
  const gx = (world.heightAt(x + eps, z) - world.heightAt(x - eps, z)) / (2 * eps);
  const gz = (world.heightAt(x, z + eps) - world.heightAt(x, z - eps)) / (2 * eps);
  const m = Math.hypot(gx, gz) || 1e-9;
  const sx = -gx / m; // downhill = toward the sea at the shoreline
  const sz = -gz / m;
  const h0 = world.heightAt(x, z);
  let steep = 0;
  for (const d of [span * 0.5, span]) {
    const drop = (h0 - world.heightAt(x + sx * d, z + sz * d)) / d;
    steep = Math.max(steep, drop);
  }
  return steep;
}

// Deterministic grass-tuft placements: on land, off streets/plazas/plots,
// never on steep faces. Each entry carries its local night factor so the
// tufts tint green in the village and mossy blue in the quarter, plus a
// size tier (0 small filler, 1 standard, 2 tall accent).
export function grassPlacements(world, { count = 2300, seed = 77 } = {}) {
  const rng = mulberry32(seed >>> 0);
  const day = world.sectors.day;
  const night = world.sectors.night;
  const homes = Object.values(world.homes ?? {});
  const out = [];
  const maxAttempts = count * 6;
  for (let a = 0; a < maxAttempts && out.length < count; a++) {
    // Sample where the land is: the two district discs plus the ridge neck.
    const pick = rng();
    let cx;
    let cz;
    let cr;
    if (pick < 0.55) {
      cx = day.center.x;
      cz = day.center.z;
      cr = day.radius * 1.1;
    } else if (pick < 0.85) {
      cx = night.center.x;
      cz = night.center.z;
      cr = night.radius * 1.15;
    } else {
      const t = rng();
      cx = day.center.x + (night.center.x - day.center.x) * t;
      cz = day.center.z + (night.center.z - day.center.z) * t;
      cr = 8;
    }
    const ang = rng() * Math.PI * 2;
    const rr = Math.sqrt(rng()) * cr;
    const x = cx + Math.cos(ang) * rr;
    const z = cz + Math.sin(ang) * rr;
    const tierRoll = rng();
    const tier = tierRoll < 0.5 ? 0 : tierRoll < 0.88 ? 1 : 2;
    const s = (0.6 + rng() * 0.8) * (tier === 0 ? 0.62 : tier === 1 ? 1 : 1.45);
    const rot = rng() * Math.PI;
    const h = world.heightAt(x, z);
    if (h <= (world.waterLevel ?? 0) + 0.4) continue;
    if (world.normalAt(x, z).y < 0.88) continue;
    if (world.streetWeightAt(x, z) > 0.15) continue;
    if (world.hubWeightAt(x, z) > 0.05) continue;
    if (homes.some((hm) => Math.hypot(hm.x - x, hm.z - z) < 1.7)) continue;
    out.push({ x, z, y: h, scale: s, rot, tier, night: world.nightMaskAt(x, z) });
  }
  return out;
}

// Marching-squares contour of the heightfield at the waterline: returns
// polyline chains ({x, z} arrays) tracing the coast. Deterministic for a
// given world; used by the foam line and the rocky coast rim.
export function extractShoreline(world, { step = 1.1, level = null, minPoints = 8 } = {}) {
  const lv = level ?? (world.waterLevel ?? 0) + 0.06;
  const half = (world.size ?? 170) / 2 + 3;
  const n = Math.max(8, Math.ceil((half * 2) / step));
  const cell = (half * 2) / n;
  const coord = (i) => -half + i * cell;

  const H = new Float64Array((n + 1) * (n + 1));
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) H[j * (n + 1) + i] = world.heightAt(coord(i), coord(j)) - lv;
  }

  // Segment table: which cell edges the contour crosses per corner mask
  // (bit1 = a at (x0,z0), bit2 = b at (x1,z0), bit4 = c at (x1,z1),
  // bit8 = d at (x0,z1)). Ambiguous 5/10 split into two segments.
  const TABLE = {
    1: [["T", "L"]],
    2: [["T", "R"]],
    3: [["L", "R"]],
    4: [["R", "B"]],
    5: [["T", "L"], ["R", "B"]],
    6: [["T", "B"]],
    7: [["L", "B"]],
    8: [["L", "B"]],
    9: [["T", "B"]],
    10: [["T", "R"], ["L", "B"]],
    11: [["R", "B"]],
    12: [["L", "R"]],
    13: [["T", "R"]],
    14: [["T", "L"]],
  };

  const segs = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = H[j * (n + 1) + i];
      const b = H[j * (n + 1) + i + 1];
      const c = H[(j + 1) * (n + 1) + i + 1];
      const d = H[(j + 1) * (n + 1) + i];
      let mask = 0;
      if (a > 0) mask |= 1;
      if (b > 0) mask |= 2;
      if (c > 0) mask |= 4;
      if (d > 0) mask |= 8;
      const rows = TABLE[mask];
      if (!rows) continue;
      const x0 = coord(i);
      const z0 = coord(j);
      const cross = {
        T: () => ({ x: x0 + (a / (a - b)) * cell, z: z0 }),
        R: () => ({ x: x0 + cell, z: z0 + (b / (b - c)) * cell }),
        B: () => ({ x: x0 + (d / (d - c)) * cell, z: z0 + cell }),
        L: () => ({ x: x0, z: z0 + (a / (a - d)) * cell }),
      };
      for (const [e1, e2] of rows) segs.push([cross[e1](), cross[e2]()]);
    }
  }

  // Chain segments into polylines by matching endpoints.
  const key = (p) => `${Math.round(p.x * 1000)},${Math.round(p.z * 1000)}`;
  const byEnd = new Map(); // endpoint key -> [{seg index, end index}]
  segs.forEach((seg, i) => {
    for (const end of [0, 1]) {
      const k = key(seg[end]);
      if (!byEnd.has(k)) byEnd.set(k, []);
      byEnd.get(k).push({ i, end });
    }
  });

  const used = new Array(segs.length).fill(false);
  const chains = [];
  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue;
    used[s] = true;
    const chain = [segs[s][0], segs[s][1]];
    // Extend forward from the tail, then backward from the head.
    for (const dir of [1, 0]) {
      for (;;) {
        const tip = dir === 1 ? chain[chain.length - 1] : chain[0];
        const cands = (byEnd.get(key(tip)) ?? []).filter((c) => !used[c.i]);
        if (!cands.length) break;
        const c = cands[0];
        used[c.i] = true;
        const nextPt = segs[c.i][c.end === 0 ? 1 : 0];
        if (dir === 1) chain.push(nextPt);
        else chain.unshift(nextPt);
      }
    }
    if (chain.length >= minPoints) chains.push(chain);
  }
  chains.sort((a, b) => b.length - a.length);
  return chains;
}

// Foam animation curve: texture scroll offset + opacity pulse. Deterministic.
export function foamMotion(t, phase = 0) {
  const offset = (t * 0.045 + phase) % 1;
  return {
    offset: offset < 0 ? offset + 1 : offset,
    opacity: 0.38 + 0.15 * Math.sin(t * 1.1 + phase * Math.PI * 2),
  };
}

// ---------------------------------------------------------------------------
// Canvas textures (procedural only)
// ---------------------------------------------------------------------------

function groundTexture(world, size = 1280) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (!ctx) return tex;

  const worldSize = world.size;
  const grainN = makeNoise2D(2027);
  const mottleN = makeFbm2D(919, 3);
  const flowerN = makeNoise2D(551);
  const cloverN = makeNoise2D(717);
  const day = world.sectors.day;

  // Coarse height/slope grid: cheap per-pixel terrain queries for contour
  // (terrace) hinting without a million heightAt calls.
  const HN = 220;
  const hGrid = new Float32Array((HN + 1) * (HN + 1));
  for (let j = 0; j <= HN; j++) {
    for (let i = 0; i <= HN; i++) {
      hGrid[j * (HN + 1) + i] = world.heightAt(
        (i / HN - 0.5) * worldSize,
        (j / HN - 0.5) * worldSize,
      );
    }
  }
  const gridAt = (x, z) => {
    const u = clamp01(x / worldSize + 0.5) * HN;
    const v = clamp01(z / worldSize + 0.5) * HN;
    const i = Math.min(HN - 1, Math.floor(u));
    const j = Math.min(HN - 1, Math.floor(v));
    const fu = u - i;
    const fv = v - j;
    const a = hGrid[j * (HN + 1) + i];
    const b = hGrid[j * (HN + 1) + i + 1];
    const c = hGrid[(j + 1) * (HN + 1) + i];
    const d = hGrid[(j + 1) * (HN + 1) + i + 1];
    return a + (b - a) * fu + (c - a) * fv + (a - b - c + d) * fu * fv;
  };

  const cellW = worldSize / HN;
  const img = ctx.createImageData(size, size);
  const px = img.data;
  for (let j = 0; j < size; j++) {
    const z = (j / size - 0.5) * worldSize;
    for (let i = 0; i < size; i++) {
      const x = (i / size - 0.5) * worldSize;
      const moss = world.nightMaskAt(x, z);
      const dr = Math.hypot(x - day.center.x, z - day.center.z) / day.radius;
      const h = gridAt(x, z);
      // Flower patches on a meadow ring around the village, gated by noise
      // and elevation (never on the beach sand).
      const ring = smoothstep(0.25, 0.4, dr) * (1 - smoothstep(0.85, 1.1, dr));
      const fw =
        ring *
        smoothstep(0.62, 0.82, flowerN(x * 0.5 + 7, z * 0.5 - 3)) *
        (1 - moss) *
        smoothstep(0.55, 0.75, h);
      // Clover: darker saturated meadow patches (reads as ground cover).
      const clover = smoothstep(0.6, 0.78, cloverN(x * 0.22 - 11, z * 0.22 + 5)) * 0.5;
      // Contour/terrace hinting: banded elevation lines that only show on
      // sloped land (flat plots and beaches stay clean).
      const gx = (gridAt(x + cellW, z) - gridAt(x - cellW, z)) / (2 * cellW);
      const gz = (gridAt(x, z + cellW) - gridAt(x, z - cellW)) / (2 * cellW);
      const slope = Math.hypot(gx, gz);
      const band = Math.abs(((h * 3.2) % 1 + 1) % 1 - 0.5) * 2; // 0 at contour line
      const onLand = smoothstep(0.25, 0.6, h);
      const contour = (1 - smoothstep(0.06, 0.2, band)) * smoothstep(0.04, 0.14, slope) * onLand;
      const grainV = grainN(x * 3.1, z * 3.1);
      // Grass-to-sand dither at texel resolution: near the beach band the
      // texels flip sandy per high-frequency noise, so the transition reads
      // speckled and organic instead of a drawn ring.
      const sandBand =
        (1 - smoothstep(0.3, 0.85, h + (grainV - 0.5) * 0.55)) * smoothstep(-0.35, 0.1, h);
      const c = macroShade({
        grain: grainV,
        mottle: mottleN(x * 0.16, z * 0.16) - clover * 0.4,
        flowerW: fw * 0.5,
        mossW: moss,
        contourW: contour * 0.85,
        sandW: sandBand,
      });
      const k = (j * size + i) * 4;
      px[k] = c[0] * 255;
      px[k + 1] = c[1] * 255;
      px[k + 2] = c[2] * 255;
      px[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const toPx = (wx) => (wx / worldSize + 0.5) * size;

  // Worn dirt: trodden warm patches around every plot door, the plaza and
  // the night hub (multiplied over the base so the grain shows through).
  ctx.globalCompositeOperation = "multiply";
  const wearSpots = [];
  for (const plot of world.plots ?? []) {
    wearSpots.push({ x: plot.door.x, z: plot.door.z, r: 1.7, a: 0.24 });
    wearSpots.push({ x: plot.x, z: plot.z, r: plot.plotRadius * 0.9, a: 0.09 });
  }
  wearSpots.push({ x: world.plaza.center.x, z: world.plaza.center.z, r: world.plaza.radius * 1.35, a: 0.14 });
  wearSpots.push({ x: world.hub.center.x, z: world.hub.center.z, r: world.hub.radius * 1.35, a: 0.14 });
  for (const w of wearSpots) {
    const cx = toPx(w.x);
    const cy = toPx(w.z);
    const rr = (w.r / worldSize) * size;
    const g = ctx.createRadialGradient(cx, cy, rr * 0.15, cx, cy, rr);
    g.addColorStop(0, `rgba(196,168,124,${w.a})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(cx - rr, cy - rr, rr * 2, rr * 2);
  }
  ctx.globalCompositeOperation = "source-over";

  // Grass-blade streaks (subtle directional grain).
  const rng = mulberry32(4242);
  ctx.globalAlpha = 0.08;
  for (let s = 0; s < 4200; s++) {
    const i = rng() * size;
    const j = rng() * size;
    ctx.fillStyle = rng() < 0.5 ? "#ffffff" : "#1e3a14";
    ctx.fillRect(i, j, 1, 2 + rng() * 3);
  }

  // Flower dots sprinkled on the meadow ring (kept off streets and water).
  ctx.globalAlpha = 0.9;
  const petals = ["#f2b6d0", "#f8dc8a", "#ffffff", "#f8b9a0", "#c9d8ff"];
  for (let s = 0; s < 1500; s++) {
    const ang = rng() * Math.PI * 2;
    const rr = (0.3 + rng() * 0.75) * day.radius;
    const x = day.center.x + Math.cos(ang) * rr;
    const z = day.center.z + Math.sin(ang) * rr;
    if (world.nightMaskAt(x, z) > 0.3) continue;
    if (world.heightAt(x, z) < (world.waterLevel ?? 0) + 0.4) continue;
    if (world.streetWeightAt(x, z) > 0.1 || world.hubWeightAt(x, z) > 0.05) continue;
    ctx.fillStyle = petals[Math.floor(rng() * petals.length)];
    ctx.beginPath();
    ctx.arc(toPx(x), toPx(z), 0.8 + rng() * 1.1, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  tex.needsUpdate = true;
  tex.anisotropy = 8;
  return tex;
}

function glintTexture(size = 256) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  if (!ctx) return tex;
  ctx.fillStyle = "#dde6ec";
  ctx.fillRect(0, 0, size, size);
  const rng = mulberry32(808);
  // Broad soft swell shading first, then calm sparkles on top (fewer and
  // dimmer than before: the sea glitters, it does not strobe).
  for (let i = 0; i < 70; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = 14 + rng() * 30;
    const g = ctx.createRadialGradient(x, y, 1, x, y, r);
    g.addColorStop(0, "rgba(255,255,255,0.1)");
    g.addColorStop(1, "rgba(150,180,200,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let i = 0; i < 240; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const w = 2 + rng() * 6;
    const bright = rng() < 0.3;
    ctx.fillStyle = bright ? "rgba(255,255,255,0.55)" : "rgba(170,200,215,0.3)";
    ctx.fillRect(x, y, w, bright ? 1 + rng() : 1 + rng() * 1.4);
  }
  tex.needsUpdate = true;
  return tex;
}

function foamTexture(w = 256, h = 64) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  if (!ctx) return tex;
  ctx.clearRect(0, 0, w, h);
  const rng = mulberry32(1717);
  // Streaky white foam, dense at the land edge (v=0), dissolving seaward.
  for (let i = 0; i < 520; i++) {
    const v = Math.pow(rng(), 1.6); // bias toward the land edge
    const y = v * h;
    const x = rng() * w;
    const len = 4 + rng() * 18;
    const alpha = (1 - v) * (0.35 + rng() * 0.5);
    ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
    ctx.fillRect(x, y, len, 1.4 + rng() * 1.6);
  }
  tex.needsUpdate = true;
  return tex;
}

function rockTexture(size = 256) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  if (!ctx) return tex;
  const fbm = makeFbm2D(3111, 3);
  const img = ctx.createImageData(size, size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const v = fbm(i * 0.045, j * 0.045);
      const lum = 105 + v * 95;
      const k = (j * size + i) * 4;
      img.data[k] = lum;
      img.data[k + 1] = lum * 0.94;
      img.data[k + 2] = lum * 0.86;
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // Cracks.
  const rng = mulberry32(909);
  ctx.strokeStyle = "rgba(30,26,24,0.35)";
  ctx.lineWidth = 1.2;
  for (let c = 0; c < 46; c++) {
    let x = rng() * size;
    let y = rng() * size;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let s = 0; s < 5; s++) {
      x += (rng() - 0.5) * 34;
      y += rng() * 22;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  tex.needsUpdate = true;
  return tex;
}

function grassBladeTexture(size = 96) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (!ctx) return tex;
  ctx.clearRect(0, 0, size, size);
  const rng = mulberry32(606);
  // A dense little tuft: many thin blades fanning from the base, darker at
  // the root, bright at the tip (the instance color multiplies on top).
  for (let b = 0; b < 26; b++) {
    const x0 = size * (0.28 + rng() * 0.44);
    const lean = (rng() - 0.5) * size * 0.7;
    const top = size * (0.04 + rng() * 0.4);
    const grad = ctx.createLinearGradient(0, size, 0, top);
    const lum = 150 + rng() * 105;
    grad.addColorStop(0, `rgba(${Math.round(lum * 0.45)},${Math.round(lum * 0.5)},${Math.round(lum * 0.32)},0.95)`);
    grad.addColorStop(1, `rgba(${Math.round(lum)},${Math.round(lum)},${Math.round(lum * 0.82)},0.95)`);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 0.9 + rng() * 1.1;
    ctx.beginPath();
    ctx.moveTo(x0, size);
    ctx.quadraticCurveTo(x0 + lean * 0.25, size * 0.5, x0 + lean, top);
    ctx.stroke();
  }
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Terrain mesh
// ---------------------------------------------------------------------------

export function buildTerrain({ world, resolution = null } = {}) {
  const size = world.size;
  // Keep vertex density constant as the island grows (~1.7 verts per unit).
  const res = resolution ?? Math.min(300, Math.max(176, Math.round(size * 1.7)));
  const geo = new THREE.PlaneGeometry(size, size, res, res);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const tone = makeNoise2D(1911);
  const grain = makeNoise2D(4177);
  const ditherN = makeFbm2D(3313, 2); // shifts every material band per vertex

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = world.heightAt(x, z);
    pos.setY(i, h);
    const n = world.normalAt(x, z);
    const dither = ditherN(x * 0.33, z * 0.33);
    const c = groundShade({
      height: h,
      // The ribbons carry the lane visuals; the terrain only tints the
      // roadbed itself (a wide halo would sand-wash the whole village).
      streetW: smoothstep(0.42, 0.95, world.streetWeightAt(x, z)) * 0.7,
      slope: 1 - n.y,
      hubW: world.hubWeightAt(x, z),
      // The district tint border wanders with the dither too.
      nightW: clamp01(world.nightMaskAt(x, z) + (dither - 0.5) * 0.1),
      tone: tone(x * 0.11 + 31, z * 0.11 - 17),
      waterLevel: world.waterLevel,
      dither,
    });
    const j = (grain(x * 0.9, z * 0.9) - 0.5) * 0.07; // hand-painted grain
    colors[i * 3] = clamp01(c[0] + j);
    colors[i * 3 + 1] = clamp01(c[1] + j);
    colors[i * 3 + 2] = clamp01(c[2] + j);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: groundTexture(world),
    // Smooth-shaded: the faceted low-poly look came from flat shading; the
    // macro texture + vertex colors carry the stylized detail instead.
    flatShading: false,
    roughness: 1,
    metalness: 0,
  });
  // The macro texture averages ~0.82; re-normalize so it adds detail, not
  // darkness.
  mat.color.setScalar(1.22);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "terrain";
  mesh.receiveShadow = true;
  return { mesh };
}

// ---------------------------------------------------------------------------
// Water: depth-tinted (shallow bright, deep dark), moving glints
// ---------------------------------------------------------------------------

export function buildWater({ world, size = null, segments = 200 } = {}) {
  // Reaches past the fog far plane so the plane's edge is never in frame.
  const span = size ?? (world?.size ?? 170) * 3.6;
  const geo = new THREE.PlaneGeometry(span, span, segments, segments);
  geo.rotateX(-Math.PI / 2);
  const base = geo.attributes.position.array.slice();
  const wl = world?.waterLevel ?? 0;

  // Depth tint per vertex: bright turquoise shallows along the beach fading
  // into a deep saturated blue open water (the reference look).
  const colors = new Float32Array(geo.attributes.position.count * 3);
  const shallow = [0.45, 0.8, 0.82];
  const deep = [0.05, 0.26, 0.52];
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const depth = typeof world?.heightAt === "function" ? wl - world.heightAt(x, z) : 3;
    // Slightly wider, clearer shallow band (the turquoise reads further out).
    const t = 1 - smoothstep(0.05, 3.0, depth);
    colors[i * 3] = deep[0] + (shallow[0] - deep[0]) * t;
    colors[i * 3 + 1] = deep[1] + (shallow[1] - deep[1]) * t;
    colors[i * 3 + 2] = deep[2] + (shallow[2] - deep[2]) * t;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const glints = glintTexture();
  glints.repeat.set(Math.round(span / 26), Math.round(span / 26));
  // Opaque: the per-vertex depth tint already reads shallow/deep, and an
  // alpha'd plane lets the terrain mesh's square edge ghost through far out.
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: glints,
    flatShading: true,
    roughness: 0.22,
    metalness: 0.12,
  });
  mat.color.setScalar(1.1);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "water";
  mesh.position.y = wl;

  const tint = new THREE.Color(0xffffff);
  let lastWave = -1;
  return {
    mesh,
    update(elapsed, tintHex = 0xffffff) {
      // The wave displacement loop is the water's only real CPU cost;
      // 30 Hz is visually identical.
      if (elapsed - lastWave >= 1 / 30) {
        lastWave = elapsed;
        const p = geo.attributes.position;
        for (let i = 0; i < p.count; i++) {
          const x = base[i * 3];
          const z = base[i * 3 + 2];
          p.setY(
            i,
            Math.sin(x * 0.14 + elapsed * 0.8) * Math.cos(z * 0.11 + elapsed * 0.63) * 0.1 +
              Math.sin((x + z) * 0.05 + elapsed * 0.35) * 0.06,
          );
        }
        p.needsUpdate = true;
      }
      // Glints drift slowly; the tint follows the camera's district blend
      // (white sun sparkle by day, cool moon glints over the quarter).
      glints.offset.set((elapsed * 0.006) % 1, (elapsed * 0.0038) % 1);
      tint.set(tintHex).multiplyScalar(1.1);
      mat.color.copy(tint);
    },
  };
}

// ---------------------------------------------------------------------------
// Shore foam + rocky coast rim (built along the extracted shoreline)
// ---------------------------------------------------------------------------

// Seaward unit direction at a shore point: downhill along the height gradient.
function seawardDir(world, x, z, eps = 0.6) {
  const gx = (world.heightAt(x + eps, z) - world.heightAt(x - eps, z)) / (2 * eps);
  const gz = (world.heightAt(x, z + eps) - world.heightAt(x, z - eps)) / (2 * eps);
  const m = Math.hypot(gx, gz) || 1e-9;
  return { x: -gx / m, z: -gz / m };
}

function stripGeometry(rows) {
  // rows: array of columns, each column an array of {x, y, z, u, v}.
  const cols = rows.length;
  const rowsPer = rows[0].length;
  const positions = new Float32Array(cols * rowsPer * 3);
  const uvs = new Float32Array(cols * rowsPer * 2);
  rows.forEach((col, i) => {
    col.forEach((p, j) => {
      const k = i * rowsPer + j;
      positions[k * 3] = p.x;
      positions[k * 3 + 1] = p.y;
      positions[k * 3 + 2] = p.z;
      uvs[k * 2] = p.u;
      uvs[k * 2 + 1] = p.v;
    });
  });
  const indices = [];
  for (let i = 0; i + 1 < cols; i++) {
    for (let j = 0; j + 1 < rowsPer; j++) {
      const a = i * rowsPer + j;
      const b = a + 1;
      const c = a + rowsPer;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// Animated foam line where the terrain meets the water.
export function buildShoreFoam({ world, chains = null } = {}) {
  const wl = world.waterLevel ?? 0;
  const lines = chains ?? extractShoreline(world, { level: wl + 0.06 });
  const group = new THREE.Group();
  group.name = "shore-foam";
  const tex = foamTexture();
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  for (const chain of lines) {
    let dist = 0;
    const cols = chain.map((p, idx) => {
      if (idx > 0) dist += Math.hypot(p.x - chain[idx - 1].x, p.z - chain[idx - 1].z);
      const dir = seawardDir(world, p.x, p.z);
      const u = dist / 3.5;
      return [
        { x: p.x - dir.x * 0.25, y: wl + 0.09, z: p.z - dir.z * 0.25, u, v: 0 },
        { x: p.x + dir.x * 1.1, y: wl + 0.04, z: p.z + dir.z * 1.1, u, v: 1 },
      ];
    });
    const mesh = new THREE.Mesh(stripGeometry(cols), mat);
    mesh.renderOrder = 2;
    group.add(mesh);
  }

  return {
    group,
    update(elapsed, tintHex = 0xffffff) {
      const m = foamMotion(elapsed);
      tex.offset.x = m.offset;
      mat.opacity = m.opacity;
      mat.color.set(tintHex); // follows the camera's district blend
    },
  };
}

// Coast rim: intentionally builds NOTHING. The rocky collar strips read as
// large brown mud slabs at play distance and the owner asked for them to be
// removed (BACKLOG item 1); grass now fades into sand and water everywhere.
// The signature stays so the scene wiring keeps working until the next
// scene-owned cleanup removes the call site.
export function buildCoastRim() {
  const group = new THREE.Group();
  group.name = "coast-rim";
  return { group };
}

// ---------------------------------------------------------------------------
// Instanced grass tufts
// ---------------------------------------------------------------------------

function tuftGeometry() {
  // Three quads fanned at 60 degrees, origin at the base: a small dense tuft
  // instead of two giant crossed billboards.
  const planes = [];
  for (let k = 0; k < 3; k++) {
    const plane = new THREE.PlaneGeometry(1, 1);
    plane.translate(0, 0.5, 0);
    plane.rotateY((k / 3) * Math.PI);
    planes.push(plane);
  }
  // Merge by hand (only position/normal/uv, all non-indexed after toNonIndexed).
  const merged = new THREE.BufferGeometry();
  const posArrs = [];
  const uvArrs = [];
  const idx = [];
  let offset = 0;
  for (const p of planes) {
    posArrs.push(p.attributes.position.array);
    uvArrs.push(p.attributes.uv.array);
    for (let i = 0; i < p.index.count; i++) idx.push(p.index.array[i] + offset);
    offset += p.attributes.position.count;
  }
  const cat = (arrs) => {
    const total = arrs.reduce((n, a) => n + a.length, 0);
    const out = new Float32Array(total);
    let o = 0;
    for (const a of arrs) {
      out.set(a, o);
      o += a.length;
    }
    return out;
  };
  merged.setAttribute("position", new THREE.BufferAttribute(cat(posArrs), 3));
  merged.setAttribute("uv", new THREE.BufferAttribute(cat(uvArrs), 2));
  merged.setIndex(idx);
  merged.computeVertexNormals();
  for (const p of planes) p.dispose();
  return merged;
}

export function buildGrass({ world, placements = null } = {}) {
  const tufts = placements ?? grassPlacements(world);
  const geo = tuftGeometry();
  // Unlit: the blades' billboard normals are near-horizontal, so lit
  // materials render them black under the low moon/hemisphere light. The
  // per-instance tint already carries the district mood (green village,
  // mossy blue quarter), so flat shading reads right on both sides.
  const mat = new THREE.MeshBasicMaterial({
    map: grassBladeTexture(),
    alphaTest: 0.32,
    side: THREE.DoubleSide,
  });
  // Gentle sway: bend the tuft tips sideways with a slow field, phase keyed
  // off each instance's world position (no per-frame matrix rewrites).
  let swayUniform = null;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSwayTime = { value: 0 };
    swayUniform = shader.uniforms.uSwayTime;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uSwayTime;")
      .replace(
        "#include <begin_vertex>",
        [
          "#include <begin_vertex>",
          "#ifdef USE_INSTANCING",
          "  float swayPhase = instanceMatrix[3][0] * 0.71 + instanceMatrix[3][2] * 0.93;",
          "  float sway = sin(uSwayTime * 1.7 + swayPhase) * 0.06;",
          "  transformed.x += sway * position.y * position.y;",
          "#endif",
        ].join("\n"),
      );
  };
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, tufts.length));
  mesh.name = "grass";
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const color = new THREE.Color();
  tufts.forEach((t, i) => {
    q.setFromAxisAngle(up, t.rot);
    // Small dense tufts (readable at close zoom, subtle at play distance).
    s.set(t.scale * 0.34, t.scale * 0.3, t.scale * 0.34);
    p.set(t.x, t.y - 0.02, t.z);
    m.compose(p, q, s);
    mesh.setMatrixAt(i, m);
    color.set(mixHexColor(0x74a850, 0x46557d, t.night));
    // Slight per-tuft tone jitter so the meadow never bands.
    const jitter = 0.88 + ((i * 37) % 23) / 23 * 0.24;
    color.multiplyScalar(jitter);
    mesh.setColorAt(i, color);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return {
    mesh,
    update(elapsed) {
      if (swayUniform) swayUniform.value = elapsed;
    },
  };
}
