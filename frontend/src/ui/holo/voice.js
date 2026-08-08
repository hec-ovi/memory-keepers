// Voice visualizer for the holo kit. Generic (no keeper/game knowledge): a
// canvas animation built around ONE central crisp speaker icon (vector-drawn,
// rendered at 2x for sharpness) wrapped by concentric alive waveform strands
// (5-7 wavy rings, like the voice-ring reference). Three modes, driven by
// setMode:
//
//   idle       faint slow strands, dim icon
//   listening  bright cyan strands
//   speaking   purple/blue strands (voice-orb reference palette)
//
//   const viz = createVoiceViz({ size: 160 });
//   host.appendChild(viz.el);          // <div class="holo-voice" data-mode>
//   viz.setMode("listening");          // unknown modes are ignored
//   viz.dispose();                     // cancels rAF, removes el
//
// Deterministic-ish: everything is a pure function of elapsed time (no random
// state per frame), so two instances at the same time look the same. The pure
// state machine (createVoiceState/setVoiceMode/modeBlend/vizFrame) and the
// geometry helpers (ringRadius/strandParams/speakerGeometry) are exported and
// tested without a canvas; jsdom's null 2d context or missing rAF just means
// nothing draws.

import { ensureHoloStyles } from "./holo.js";

export const VOICE_MODES = ["idle", "listening", "speaking"];

// The canvas backing store is 2x the CSS size so the icon edges stay crisp.
export const RENDER_SCALE = 2;

// How many concentric waveform strands wrap the speaker icon.
export const STRAND_COUNT = 6;

// Per-mode animation parameters, blended during transitions. `hue` is the
// center strand hue (deg), `hueSpread` fans the strands around it: cyan while
// listening, purple center fading to blue edges while speaking, faint cyan
// at rest.
export const MODE_PARAMS = {
  idle: { alpha: 0.2, wobble: 0.022, waves: 5, speed: 0.35, scale: 0.9, hue: 195, hueSpread: 10 },
  listening: { alpha: 0.95, wobble: 0.075, waves: 7, speed: 1.7, scale: 1, hue: 190, hueSpread: 16 },
  speaking: { alpha: 0.92, wobble: 0.05, waves: 6, speed: 1.2, scale: 1, hue: 258, hueSpread: 62 },
};

export const MODE_FADE_MS = 450;

// --- pure state machine ------------------------------------------------------

export function createVoiceState(now = 0) {
  return { mode: "idle", prev: "idle", since: now };
}

// Returns a NEW state on a valid change; the same state otherwise.
export function setVoiceMode(state, mode, now = 0) {
  if (!VOICE_MODES.includes(mode) || mode === state.mode) return state;
  return { mode, prev: state.mode, since: now };
}

// 0..1 progress of the current cross-fade.
export function modeBlend(state, now, fadeMs = MODE_FADE_MS) {
  if (state.prev === state.mode) return 1;
  return Math.min(1, Math.max(0, (now - state.since) / fadeMs));
}

const lerp = (a, b, t) => a + (b - a) * t;

// Blended frame descriptor: what the canvas should draw at `now` (ms).
export function vizFrame(state, now, fadeMs = MODE_FADE_MS) {
  const t = modeBlend(state, now, fadeMs);
  const from = MODE_PARAMS[state.prev] ?? MODE_PARAMS.idle;
  const to = MODE_PARAMS[state.mode] ?? MODE_PARAMS.idle;
  return {
    alpha: lerp(from.alpha, to.alpha, t),
    wobble: lerp(from.wobble, to.wobble, t),
    waves: Math.round(lerp(from.waves, to.waves, t)),
    speed: lerp(from.speed, to.speed, t),
    scale: lerp(from.scale, to.scale, t),
    hue: lerp(from.hue, to.hue, t),
    hueSpread: lerp(from.hueSpread, to.hueSpread, t),
  };
}

// Wavy-ring radius factor at angle theta (radians) and time (seconds).
// Two drifting sine bands give the organic "cloth ring" wobble.
export function ringRadius(theta, time, { wobble = 0.05, waves = 6, speed = 1 } = {}) {
  return (
    1 +
    wobble *
      (Math.sin(waves * theta + time * speed * 2.1) +
        0.6 * Math.sin((waves + 2) * theta - time * speed * 1.4 + 1.7))
  );
}

// Per-strand modifiers for strand i of `count`: concentric radius spread,
// de-phased wobble, slightly different drift speed, outer strands fainter,
// and a 0..1 hue position across the mode's hueSpread. Pure and
// deterministic in (i, count).
export function strandParams(i, count = STRAND_COUNT) {
  const t = count > 1 ? i / (count - 1) : 0;
  return {
    radius: 0.84 + 0.3 * t,
    phase: i * 1.9,
    wobbleMul: 0.75 + 0.5 * t,
    speedMul: 0.85 + (0.3 * ((i * 7) % count)) / count,
    alphaMul: 1 - 0.55 * t,
    hueT: t,
  };
}

// The central speaker icon geometry (the classic volume glyph: driver box,
// cone, two sound arcs), centered in a size x size canvas and scaled with it.
// Pure; the canvas draws exactly these shapes so tests can verify them.
export function speakerGeometry(size = 160) {
  const u = size / 160;
  const k = 2.1 * u; // 24-unit glyph -> ~50 px wide at size 160
  const cx = size / 2 - 5 * u; // nudged left so the arcs balance visually
  const cy = size / 2;
  const x = (gx) => cx + (gx - 12) * k;
  const y = (gy) => cy + (gy - 12) * k;
  return {
    body: { x: x(3), y: y(9), w: 4 * k, h: 6 * k },
    cone: [
      [x(7), y(9)],
      [x(12), y(4)],
      [x(12), y(20)],
      [x(7), y(15)],
    ],
    arcs: [
      { x: x(13), y: y(12), r: 4.6 * k, a0: -Math.PI / 4, a1: Math.PI / 4 },
      { x: x(13), y: y(12), r: 7.4 * k, a0: -Math.PI / 4, a1: Math.PI / 4 },
    ],
  };
}

// --- the canvas component ----------------------------------------------------

export function createVoiceViz({ size = 160 } = {}) {
  const doc = globalThis.document;
  ensureHoloStyles(doc);
  const win = doc?.defaultView ?? globalThis;

  const el = doc.createElement("div");
  el.className = "holo-voice";
  el.dataset.mode = "idle";
  const canvas = doc.createElement("canvas");
  canvas.width = size * RENDER_SCALE;
  canvas.height = size * RENDER_SCALE;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  el.appendChild(canvas);

  let ctx = null;
  try {
    ctx = canvas.getContext?.("2d") ?? null;
  } catch {
    ctx = null;
  }

  let state = createVoiceState(0);
  let disposed = false;
  let rafId = 0;
  const raf = win.requestAnimationFrame?.bind(win);
  const caf = win.cancelAnimationFrame?.bind(win) ?? (() => {});

  const half = size / 2;
  const R = size * 0.34;
  const geom = speakerGeometry(size);

  function drawStrands(time, frame) {
    if (frame.alpha <= 0.01) return;
    const steps = 96;
    for (let i = 0; i < STRAND_COUNT; i++) {
      const s = strandParams(i);
      const wave = {
        wobble: frame.wobble * s.wobbleMul,
        waves: frame.waves,
        speed: frame.speed,
      };
      ctx.beginPath();
      for (let k = 0; k <= steps; k++) {
        const theta = (k / steps) * Math.PI * 2;
        const r = R * frame.scale * s.radius * ringRadius(theta + s.phase, time * s.speedMul, wave);
        const px = half + Math.cos(theta) * r;
        const py = half + Math.sin(theta) * r;
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      const hue = frame.hue + frame.hueSpread * (s.hueT - 0.5);
      ctx.globalAlpha = frame.alpha * s.alphaMul;
      ctx.strokeStyle = `hsl(${hue} 92% 64%)`;
      ctx.shadowColor = `hsl(${hue} 92% 60%)`;
      ctx.shadowBlur = 9;
      ctx.lineWidth = 1.3;
      ctx.stroke();
    }
  }

  function drawSpeaker(frame) {
    const color = `hsl(${frame.hue} 85% 74%)`;
    ctx.globalAlpha = Math.min(1, 0.35 + 0.6 * frame.alpha);
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;
    // driver box
    const b = geom.body;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x + b.w, b.y);
    ctx.lineTo(b.x + b.w, b.y + b.h);
    ctx.lineTo(b.x, b.y + b.h);
    ctx.closePath();
    ctx.fill();
    // cone
    ctx.beginPath();
    geom.cone.forEach(([px, py], i) => (i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)));
    ctx.closePath();
    ctx.fill();
    // sound arcs
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    for (const arc of geom.arcs) {
      ctx.beginPath();
      ctx.arc(arc.x, arc.y, arc.r, arc.a0, arc.a1);
      ctx.stroke();
    }
  }

  function draw(now) {
    if (disposed) return;
    if (ctx) {
      const time = now / 1000;
      const frame = vizFrame(state, now);
      ctx.setTransform?.(RENDER_SCALE, 0, 0, RENDER_SCALE, 0, 0);
      ctx.clearRect(0, 0, size, size);
      ctx.globalCompositeOperation = "lighter";
      drawStrands(time, frame);
      drawSpeaker(frame);
      ctx.globalAlpha = 1;
    }
    rafId = raf(draw);
  }
  if (ctx && raf) rafId = raf(draw);

  return {
    el,
    setMode(mode) {
      const next = setVoiceMode(state, mode, win.performance?.now?.() ?? Date.now());
      if (next === state) return;
      state = next;
      el.dataset.mode = state.mode;
    },
    getMode: () => state.mode,
    dispose() {
      if (disposed) return;
      disposed = true;
      caf(rafId);
      el.remove();
    },
  };
}
