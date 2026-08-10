// Speech bubbles: canvas-texture sprites floating above a keeper. Pop-in with
// a little overshoot, hold, fade-out. Big font on the canvas so lines stay
// readable at game camera distance.
//
// Pure helpers (wrapBubbleText, popScale, bubbleSeconds) are unit-tested.

import * as THREE from "three";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// Greedy word wrap; hard-breaks single words longer than maxChars. Returns at
// most maxLines lines, ellipsizing the last one when the text overflows.
export function wrapBubbleText(text, maxChars = 22, maxLines = 4) {
  const words = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (let word of words) {
    while (word.length > maxChars) {
      if (line) {
        lines.push(line);
        line = "";
      }
      lines.push(word.slice(0, maxChars - 1) + "-");
      word = word.slice(maxChars - 1);
    }
    const candidate = line ? line + " " + word : word;
    if (candidate.length <= maxChars) line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/.{0,3}$/, "") + "...";
    return kept;
  }
  return lines;
}

// Pop-in scale over u in [0,1]: 0 -> overshoot -> settle at 1 (ease-out-back).
export function popScale(u) {
  const t = Math.min(1, Math.max(0, u));
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

// How long a bubble should stay up: base plus a little per-character.
export function bubbleSeconds(text, base = 4.5) {
  return base + Math.min(3, String(text ?? "").length * 0.03);
}

// ---------------------------------------------------------------------------
// Sprite factory
// ---------------------------------------------------------------------------

const POP_S = 0.28;
const FADE_S = 0.55;
const FONT_PX = 44;
const PAD = 34;
const WORLD_PER_PX = 0.0075; // canvas pixel -> world units

function drawBubble(text) {
  const lines = wrapBubbleText(text);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    // Headless DOM without a canvas backend (tests): a blank canvas still
    // yields a valid sprite, just without pixels.
    canvas.width = 64;
    canvas.height = 64;
    return canvas;
  }
  ctx.font = `600 ${FONT_PX}px "Segoe UI", system-ui, sans-serif`;
  const widest = Math.max(60, ...lines.map((l) => ctx.measureText(l).width));
  const lineH = FONT_PX * 1.22;
  const tail = 26;
  canvas.width = Math.ceil(widest + PAD * 2);
  canvas.height = Math.ceil(lines.length * lineH + PAD * 2 + tail);

  const w = canvas.width;
  const bh = canvas.height - tail;
  const r = 30;

  // Rounded rect + tail.
  ctx.fillStyle = "rgba(255, 252, 250, 0.96)";
  ctx.strokeStyle = "rgba(90, 60, 80, 0.35)";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(r, 1);
  ctx.lineTo(w - r, 1);
  ctx.quadraticCurveTo(w - 1, 1, w - 1, r);
  ctx.lineTo(w - 1, bh - r);
  ctx.quadraticCurveTo(w - 1, bh, w - r, bh);
  ctx.lineTo(w / 2 + tail * 0.8, bh);
  ctx.lineTo(w / 2, bh + tail - 2);
  ctx.lineTo(w / 2 - tail * 0.8, bh);
  ctx.lineTo(r, bh);
  ctx.quadraticCurveTo(1, bh, 1, bh - r);
  ctx.lineTo(1, r);
  ctx.quadraticCurveTo(1, 1, r, 1);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Text.
  ctx.font = `600 ${FONT_PX}px "Segoe UI", system-ui, sans-serif`;
  ctx.fillStyle = "#4a2b3f";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  lines.forEach((l, i) => {
    ctx.fillText(l, w / 2, PAD + lineH * (i + 0.5));
  });

  return canvas;
}

// createSpeech() -> { show({text, target, offsetY, seconds}), update(dt),
// setTint(hex), dispose() }. `target` is the Object3D the bubble hovers
// over (it is added as a child, so it follows the keeper for free).
export function createSpeech() {
  const active = []; // { sprite, texture, material, life, total }
  let tintHex = 0xffffff;

  function remove(entry) {
    entry.sprite.removeFromParent();
    entry.material.dispose();
    entry.texture.dispose();
    const i = active.indexOf(entry);
    if (i >= 0) active.splice(i, 1);
  }

  return {
    get count() {
      return active.length;
    },

    // Environment tint (the overworld drives it with the district blend's
    // bubbleTint): white paper by day, moonlit paper over the night quarter
    // so bubbles stay under the night bloom threshold and stay readable.
    setTint(hex) {
      if (!Number.isFinite(hex) || hex === tintHex) return;
      tintHex = hex;
      for (const entry of active) entry.material.color.setHex(tintHex);
    },

    show({ text, target, offsetY = 1.3, seconds } = {}) {
      if (!target || !text) return null;
      const canvas = drawBubble(text);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false, // always readable over the scene
      });
      material.color.setHex(tintHex);
      const sprite = new THREE.Sprite(material);
      sprite.center.set(0.5, 0); // anchor at the tail tip
      const w = canvas.width * WORLD_PER_PX;
      const h = canvas.height * WORLD_PER_PX;
      sprite.scale.set(0.001, 0.001, 1);
      sprite.position.set(0, offsetY, 0);
      sprite.renderOrder = 999;
      target.add(sprite);

      const total = seconds ?? bubbleSeconds(text);
      const entry = { sprite, texture, material, life: 0, total, w, h };
      active.push(entry);
      return entry;
    },

    update(dt) {
      if (!Number.isFinite(dt) || dt < 0) dt = 0;
      for (const entry of [...active]) {
        entry.life += dt;
        const { sprite, material, life, total, w, h } = entry;
        if (life >= total) {
          remove(entry);
          continue;
        }
        const pop = life < POP_S ? popScale(life / POP_S) : 1;
        sprite.scale.set(w * pop, h * pop, 1);
        const fadeLeft = total - life;
        material.opacity = fadeLeft < FADE_S ? fadeLeft / FADE_S : 1;
      }
    },

    dispose() {
      for (const entry of [...active]) remove(entry);
    },
  };
}
