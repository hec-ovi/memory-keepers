// Wireframe-triangle shard animation for the holo kit (internal module).
// Phase 1 of every holo panel: scattered stroked triangles in teal/white/amber
// fly toward the panel rect and tessellate to fill it; closing plays the same
// thing backwards. Pure math (tessellate/shardPlan/shardState) is exported and
// unit-tested without a canvas; runShards is the thin rAF driver.
//
// No game knowledge, no DOM classes, no bus. jsdom-safe: a missing 2d context
// or missing requestAnimationFrame degrades to an immediate onDone.

export const SHARD_COLORS = ["#7ef7e0", "#ffffff", "#ffb658", "#7ef7e0"]; // teal-heavy mix

// Small deterministic PRNG so the scatter is stable for a given seed.
export function mulberry32(seed = 1) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

// Split a width x height rect into a grid of right triangles (2 per cell,
// alternating diagonal so the field reads as a mesh, like the reference).
// Returns [{ points: [[x,y]x3], cx, cy }]. Deterministic.
export function tessellate(width, height, cell = 26) {
  const cols = Math.max(1, Math.round(width / cell));
  const rows = Math.max(1, Math.round(height / cell));
  const cw = width / cols;
  const ch = height / rows;
  const tris = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = c * cw;
      const y0 = r * ch;
      const x1 = x0 + cw;
      const y1 = y0 + ch;
      const pair =
        (r + c) % 2 === 0
          ? [
              [[x0, y0], [x1, y0], [x0, y1]],
              [[x1, y0], [x1, y1], [x0, y1]],
            ]
          : [
              [[x0, y0], [x1, y0], [x1, y1]],
              [[x0, y0], [x1, y1], [x0, y1]],
            ];
      for (const points of pair) {
        const cx = (points[0][0] + points[1][0] + points[2][0]) / 3;
        const cy = (points[0][1] + points[1][1] + points[2][1]) / 3;
        tris.push({ points, cx, cy });
      }
    }
  }
  return tris;
}

// Per-shard flight plan: a scattered start offset (random direction, distance
// proportional to the panel diagonal), a start rotation, a stagger delay in
// 0..0.35 of the animation, and a stroke color. Deterministic per seed.
export function shardPlan(tris, { seed = 7, width = 320, height = 240, spread = 1.1 } = {}) {
  const rand = mulberry32(seed);
  const reach = Math.max(width, height) * spread;
  return tris.map(() => {
    const angle = rand() * Math.PI * 2;
    const dist = (0.35 + rand() * 0.85) * reach;
    return {
      dx: Math.cos(angle) * dist,
      dy: Math.sin(angle) * dist,
      rot: (rand() - 0.5) * 3.2,
      delay: rand() * 0.35,
      color: SHARD_COLORS[(rand() * SHARD_COLORS.length) | 0],
    };
  });
}

// Where one shard is at global progress t (0 = fully scattered, 1 = seated).
// Each shard flies inside its own [delay, delay + 0.65] window.
export function shardState(plan, t) {
  const local = Math.min(1, Math.max(0, (t - plan.delay) / 0.65));
  const k = 1 - easeOutCubic(local); // 1 = at scatter position
  return {
    offX: plan.dx * k,
    offY: plan.dy * k,
    rot: plan.rot * k,
    alpha: local <= 0 ? 0 : 0.28 + 0.72 * local,
  };
}

// Drive the shard animation on a canvas. mode "in" flies shards toward the
// rect, "out" scatters them. Returns { cancel() }. Calls onDone exactly once
// (immediately when the environment cannot animate).
export function runShards(canvas, { mode = "in", duration = 420, seed = 7, win, onDone } = {}) {
  const w = canvas?.width ?? 0;
  const h = canvas?.height ?? 0;
  const view = win ?? canvas?.ownerDocument?.defaultView ?? globalThis;
  const raf = view?.requestAnimationFrame?.bind(view);
  const caf = view?.cancelAnimationFrame?.bind(view) ?? (() => {});
  let ctx = null;
  try {
    ctx = canvas?.getContext?.("2d") ?? null;
  } catch {
    ctx = null;
  }

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    onDone?.();
  };

  if (!ctx || !raf || w < 4 || h < 4) {
    finish();
    return { cancel: finish };
  }

  const cell = Math.max(18, Math.min(36, Math.round(Math.max(w, h) / 11)));
  const tris = tessellate(w, h, cell);
  const plans = shardPlan(tris, { seed, width: w, height: h });

  let rafId = 0;
  let start = null;

  const draw = (now) => {
    if (done) return;
    if (start === null) start = now;
    const raw = Math.min(1, (now - start) / duration);
    const t = mode === "out" ? 1 - raw : raw;
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";
    ctx.lineWidth = 1;
    for (let i = 0; i < tris.length; i++) {
      const s = shardState(plans[i], t);
      if (s.alpha <= 0) continue;
      const tri = tris[i];
      ctx.save();
      ctx.translate(tri.cx + s.offX, tri.cy + s.offY);
      ctx.rotate(s.rot);
      ctx.globalAlpha = s.alpha;
      ctx.strokeStyle = plans[i].color;
      ctx.shadowColor = plans[i].color;
      ctx.shadowBlur = 7;
      ctx.beginPath();
      ctx.moveTo(tri.points[0][0] - tri.cx, tri.points[0][1] - tri.cy);
      ctx.lineTo(tri.points[1][0] - tri.cx, tri.points[1][1] - tri.cy);
      ctx.lineTo(tri.points[2][0] - tri.cx, tri.points[2][1] - tri.cy);
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }
    if (raw >= 1) {
      if (mode === "out") ctx.clearRect(0, 0, w, h);
      finish();
      return;
    }
    rafId = raf(draw);
  };
  rafId = raf(draw);

  return {
    cancel() {
      caf(rafId);
      finish();
    },
  };
}
