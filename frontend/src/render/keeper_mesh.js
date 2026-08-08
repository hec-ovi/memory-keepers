// The keeper: a procedural kawaii pink blob matching sample/keeper.png.
// Soft pink sphere with a subtle vertical gradient (vertex colors), two big
// glossy dark-purple eyes with white highlights, blush discs, a tiny smile.
// All conscious keepers share the same keeper.png pink (Keeper.palette is ignored
// for the body); unconscious keepers keep the darker moonlit variant.
// Locomotion is a squash-stretch hop with a ground-contact squish; idle has
// breathing and periodic blinks. Unconscious keepers are darker, hover-float
// and blink slower, but fully OPAQUE like everyone else (the old body
// translucency was removed per owner feedback, BACKLOG 11).
//
// Session fatigue (round 5): setTired(level) with 0 rested / 1 unrested /
// 2 needs_sleep droops the eyelids (eye scale + offset), slows the hop a
// touch, and at level 2 shows a tiny pulsing Zzz sprite. setSleeping(true)
// closes the eyes fully and switches to slow deep breathing (the interior
// doze); the Zzz sprite shows while sleeping too.
//
// Pure helpers (derivePalette, hopPose, blinkOpenness, breathScale,
// tiredLevelFor, eyelidPose, tiredHopHz, zzzPulse) contain all the
// timing/color math and are unit-tested without WebGL.

import * as THREE from "three";

// ---------------------------------------------------------------------------
// Pure helpers (no three.js) -- tested in tests/render_helpers.test.js
// ---------------------------------------------------------------------------

const clamp01 = (x) => Math.min(1, Math.max(0, x));

export function hexToRgb(hex) {
  let h = typeof hex === "number" ? hex : parseInt(String(hex).replace(/^#/, ""), 16);
  if (!Number.isFinite(h)) h = 0xf8a7c0;
  return { r: (h >> 16) & 0xff, g: (h >> 8) & 0xff, b: h & 0xff };
}

export function rgbToHex({ r, g, b }) {
  const c = (v) => Math.round(Math.min(255, Math.max(0, v)));
  return (c(r) << 16) | (c(g) << 8) | c(b);
}

export function mixHex(a, b, t) {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  const k = clamp01(t);
  return rgbToHex({ r: A.r + (B.r - A.r) * k, g: A.g + (B.g - A.g) * k, b: A.b + (B.b - A.b) * k });
}

export function lightenHex(hex, t) {
  return mixHex(hex, 0xffffff, t);
}

export function darkenHex(hex, t) {
  return mixHex(hex, 0x000000, t);
}

// The android body white. Every conscious keeper uses the same shell:
// per-keeper palette variation is intentionally disabled for now, so
// Keeper.palette is ignored here (houses and UI accents still use it).
export const KEEPER_WHITE = 0xf2f6fa;
export const VISOR_BLUE = 0x2fb9ff;
const DEFAULT_PRIMARY = KEEPER_WHITE;
const UNCONSCIOUS_TINT = 0x6d5a8f;

// Shared material palette for every keeper (the `palette` argument is accepted
// for interface stability but ignored). kind === "unconscious" shifts
// everything darker/violet; the body stays fully opaque (BACKLOG 11).
export function derivePalette(_palette = {}, kind = "conscious") {
  const primary = DEFAULT_PRIMARY;
  let out = {
    top: lightenHex(primary, 0.5), // porcelain crown
    bottom: mixHex(darkenHex(primary, 0.16), 0x9fb6c8, 0.35), // cool shaded base
    eye: VISOR_BLUE, // digital eyes glowing behind the visor
    highlight: 0xe8fbff,
    blush: mixHex(VISOR_BLUE, 0xffffff, 0.45), // cheek status LEDs
    mouth: mixHex(0x51606e, 0x2c3a46, 0.5),
    visor: 0x0e2233, // smoked glass band
    opacity: 1,
  };
  if (kind === "unconscious") {
    out = {
      top: mixHex(out.top, UNCONSCIOUS_TINT, 0.5),
      bottom: mixHex(out.bottom, darkenHex(UNCONSCIOUS_TINT, 0.35), 0.55),
      eye: mixHex(out.eye, 0x7a5cff, 0.45), // night-shifted glow
      highlight: 0xd9d2ff,
      blush: mixHex(out.blush, UNCONSCIOUS_TINT, 0.5),
      mouth: mixHex(out.mouth, 0x241530, 0.5),
      visor: mixHex(out.visor, 0x1a1030, 0.5),
      opacity: 1, // fully opaque: only the moonlit tint marks her unconscious
    };
  }
  return out;
}

// One hop cycle, u in [0,1). Starts with a ground-contact squish, then an
// airborne arc with stretch. Volume-preserving: scaleXZ = 1/sqrt(scaleY).
export function hopPose(u, { height = 0.25, squash = 0.2, stretch = 0.12, contact = 0.22 } = {}) {
  u = ((u % 1) + 1) % 1;
  if (u < contact) {
    const dip = Math.sin(Math.PI * (u / contact));
    const sy = 1 - squash * dip;
    return { y: 0, scaleY: sy, scaleXZ: 1 / Math.sqrt(sy), airborne: false };
  }
  const a = (u - contact) / (1 - contact);
  const arc = Math.sin(Math.PI * a);
  const sy = 1 + stretch * arc;
  return { y: height * arc, scaleY: sy, scaleXZ: 1 / Math.sqrt(sy), airborne: true };
}

// Eye openness through one blink, u in [0,1]: 1 (open) -> ~0 (shut) -> 1.
export function blinkOpenness(u) {
  const t = clamp01(u);
  return Math.max(0.06, 1 - Math.sin(Math.PI * t));
}

// Idle breathing scale factor over time (seconds).
export function breathScale(t, { amplitude = 0.018, hz = 0.45 } = {}) {
  return 1 + amplitude * Math.sin(t * Math.PI * 2 * hz);
}

// --- session fatigue -------------------------------------------------------

// Session status -> tired level (0 rested, 1 unrested, 2 needs_sleep).
export const TIRED_STATUS = Object.freeze({ rested: 0, unrested: 1, needs_sleep: 2 });

// Accepts an Keeper object ({ session: { status } }), a bare session, a status
// string, or a numeric level. Anything unknown reads as rested.
export function tiredLevelFor(source) {
  if (source == null) return 0;
  if (typeof source === "number") {
    return Number.isFinite(source) ? Math.max(0, Math.min(2, Math.round(source))) : 0;
  }
  const status =
    typeof source === "string" ? source : (source.session?.status ?? source.status ?? null);
  return TIRED_STATUS[status] ?? 0;
}

// Droopy-eyelid pose for a tired level (fractional levels interpolate):
// `lid` multiplies the eye group's y scale, `offsetY` slides the eyes down.
export function eyelidPose(level) {
  const k = Math.max(0, Math.min(2, Number.isFinite(level) ? level : 0)) / 2;
  return { lid: 1 - 0.45 * k, offsetY: -0.05 * k };
}

// Hop frequency slows a touch as she tires (level 2 is ~22% slower).
export function tiredHopHz(level, base = 2.2) {
  const k = Math.max(0, Math.min(2, Number.isFinite(level) ? level : 0));
  return base * (1 - 0.11 * k);
}

// The Zzz sprite's pulse over time: opacity and scale breathe, the sprite
// drifts up a little over each cycle. Opacity never reaches 0 mid-cycle.
export function zzzPulse(t, { period = 2.6 } = {}) {
  const u = (((Number.isFinite(t) ? t : 0) / Math.max(1e-6, period)) % 1 + 1) % 1;
  const wave = Math.sin(Math.PI * u);
  return { opacity: 0.25 + 0.6 * wave, scale: 0.85 + 0.3 * wave, y: 0.12 * u };
}

// ---------------------------------------------------------------------------
// Mesh factory (three.js)
// ---------------------------------------------------------------------------

const BODY_RADIUS = 0.55;
const SLEEP_LID = 0.08; // eyes shut while dozing (never exactly 0: avoids a flat scale)
const ZZZ_BASE_Y = 0.95;
const ZZZ_SIZE = 0.42;

// Tiny "Zzz" canvas texture; jsdom/headless-safe (undrawn texture without a
// 2d context, still disposable).
function makeZzzTexture() {
  if (typeof document === "undefined") return new THREE.Texture();
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 96;
  const tex = new THREE.CanvasTexture(canvas);
  const ctx = canvas.getContext?.("2d");
  if (!ctx) return tex;
  ctx.clearRect(0, 0, 96, 96);
  ctx.fillStyle = "#fdf6ff";
  ctx.strokeStyle = "rgba(90,60,110,0.85)";
  ctx.lineWidth = 3;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const zs = [
    { x: 30, y: 68, px: 26, rot: -0.12 },
    { x: 52, y: 44, px: 34, rot: 0.1 },
    { x: 72, y: 20, px: 42, rot: -0.08 },
  ];
  for (const z of zs) {
    ctx.save();
    ctx.translate(z.x, z.y);
    ctx.rotate(z.rot);
    ctx.font = `700 ${z.px}px "Trebuchet MS","Segoe UI",sans-serif`;
    ctx.strokeText("Z", 0, 0);
    ctx.fillText("Z", 0, 0);
    ctx.restore();
  }
  tex.needsUpdate = true;
  return tex;
}

// White rounded-rect on black: alphaMap that rounds the visor's corners.
function makeRoundedMask() {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext?.("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, 256, 128);
  ctx.fillStyle = "#fff";
  const r = 46;
  ctx.beginPath();
  ctx.roundRect(6, 6, 244, 116, r);
  ctx.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

function gradientBody(geometry, topHex, bottomHex) {
  const pos = geometry.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const top = new THREE.Color(topHex);
  const bottom = new THREE.Color(bottomHex);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = clamp01((pos.getY(i) / BODY_RADIUS + 1) / 2);
    const s = t * t * (3 - 2 * t);
    c.copy(bottom).lerp(top, s);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

export function createKeeperMesh({ keeper = {}, config = {} } = {}) {
  const kind = keeper.kind === "unconscious" ? "unconscious" : "conscious";
  const pal = derivePalette(keeper.palette, kind);
  const translucent = pal.opacity < 1;

  const group = new THREE.Group();
  group.name = `keeper:${keeper.id ?? "?"}`;
  const root = new THREE.Group(); // gets hop offset + squash-stretch
  group.add(root);

  const geometries = [];
  const materials = [];
  const track = (mesh) => {
    geometries.push(mesh.geometry);
    materials.push(mesh.material);
    return mesh;
  };
  const mat = (opts) => {
    const m = new THREE.MeshStandardMaterial(opts);
    if (translucent) {
      m.transparent = true;
      m.opacity = pal.opacity;
    }
    return m;
  };

  // Body: white android shell, subtle vertical gradient via vertex colors.
  const bodyGeo = new THREE.SphereGeometry(BODY_RADIUS, 32, 24);
  bodyGeo.scale(1, 0.94, 1); // a hair squatter than a perfect sphere
  gradientBody(bodyGeo, pal.top, pal.bottom);
  const bodyMat = mat({ vertexColors: true, roughness: 0.55, metalness: 0 });
  bodyMat.emissive = new THREE.Color(pal.top);
  bodyMat.emissiveIntensity = 0;
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.castShadow = !translucent;
  body.userData.keeperId = keeper.id;
  body.userData.pick = "keeper";
  root.add(track(body));

  // Cat ears: tiny white cones, matte black inside.
  const earGeo = new THREE.ConeGeometry(0.085, 0.17, 12);
  const earMat = mat({ color: pal.top, roughness: 0.55 });
  const earInnerGeo = new THREE.ConeGeometry(0.045, 0.1, 10);
  const earInnerMat = mat({ color: 0x14181c, roughness: 0.9 });
  for (const sx of [-1, 1]) {
    const ear = new THREE.Mesh(earGeo, earMat);
    ear.position.set(0.24 * sx, 0.55, 0.03);
    ear.rotation.z = -0.28 * sx;
    const inner = new THREE.Mesh(earInnerGeo, earInnerMat);
    inner.position.set(0, -0.01, 0.035);
    ear.add(inner);
    root.add(ear);
  }
  geometries.push(earGeo, earInnerGeo);
  materials.push(earMat, earInnerMat);

  // Visor: a smoked glass band curving across the face, corners rounded by
  // an alpha mask (headless-safe: without a 2d context the band stays square).
  const visorGeo = new THREE.SphereGeometry(BODY_RADIUS + 0.045, 32, 12, 0, 1.9, 1.02, 0.72);
  const visorMat = new THREE.MeshStandardMaterial({
    color: pal.visor, transparent: true, opacity: 0.42, roughness: 0.06,
    metalness: 0.35, side: THREE.DoubleSide, depthWrite: false,
  });
  const visorMask = makeRoundedMask();
  if (visorMask) visorMat.alphaMap = visorMask;
  visorMat.emissive = new THREE.Color(pal.eye);
  visorMat.emissiveIntensity = 0.12;
  const visor = new THREE.Mesh(visorGeo, visorMat);
  visor.name = "visor"; // translucent by design (glass)
  visor.rotation.y = Math.PI / 2 - 0.95;
  geometries.push(visorGeo); // material is NOT tracked: opacity stays fixed glass
  root.add(visor);

  // Eyes: digital blue, glowing behind the glass, each with two highlights.
  const eyes = new THREE.Group(); // scaled in y for blinking + tired droop
  eyes.name = "eyes";
  root.add(eyes);
  const eyeGeo = new THREE.SphereGeometry(0.155, 20, 16);
  const eyeMat = mat({ color: pal.eye, roughness: 0.15, metalness: 0.05 });
  eyeMat.emissive = new THREE.Color(pal.eye);
  eyeMat.emissiveIntensity = 0.85;
  const hiGeoBig = new THREE.SphereGeometry(0.052, 10, 8);
  const hiGeoSmall = new THREE.SphereGeometry(0.024, 8, 6);
  const hiMat = new THREE.MeshBasicMaterial({ color: pal.highlight, toneMapped: false });
  if (translucent) {
    hiMat.transparent = true;
    hiMat.opacity = Math.min(1, pal.opacity + 0.1);
  }
  geometries.push(eyeGeo, hiGeoBig, hiGeoSmall);
  materials.push(eyeMat, hiMat);
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.position.set(0.195 * sx, 0.075, 0.42);
    eye.scale.set(1, 1.08, 0.75); // slightly tall, hugging the face
    const hi1 = new THREE.Mesh(hiGeoBig, hiMat);
    hi1.position.set(-0.045 * sx, 0.055, 0.115);
    const hi2 = new THREE.Mesh(hiGeoSmall, hiMat);
    hi2.position.set(0.05 * sx, -0.045, 0.115);
    eye.add(hi1, hi2);
    eyes.add(eye);
  }

  // Blush discs on the cheeks.
  const blushGeo = new THREE.SphereGeometry(0.095, 14, 10);
  const blushMat = mat({ color: pal.blush, roughness: 0.9 });
  blushMat.emissive = new THREE.Color(pal.blush);
  blushMat.emissiveIntensity = 0.12;
  geometries.push(blushGeo);
  materials.push(blushMat);
  for (const sx of [-1, 1]) {
    const blush = new THREE.Mesh(blushGeo, blushMat);
    blush.position.set(0.36 * sx, -0.075, 0.36);
    blush.scale.set(1, 0.72, 0.32);
    blush.lookAt(blush.position.clone().multiplyScalar(2));
    root.add(blush);
  }

  // Tiny smile: a short torus arc centered on the bottom of its circle.
  const smileArc = Math.PI * 0.62;
  const smileGeo = new THREE.TorusGeometry(0.075, 0.017, 8, 20, smileArc);
  const smileMat = mat({ color: pal.mouth, roughness: 0.6 });
  const smile = new THREE.Mesh(smileGeo, smileMat);
  smile.rotation.z = -Math.PI / 2 - smileArc / 2; // arc spans the bottom = smile
  smile.position.set(0, -0.09, 0.5);
  root.add(track(smile));

  // Zzz sprite: hidden unless tired level 2 or sleeping; pulses (zzzPulse).
  // Not in `materials`: its opacity is animated per-frame, so applyOpacity
  // leaves it alone and update() multiplies opacityMult in itself.
  const zzzTex = makeZzzTexture();
  const zzzMat = new THREE.SpriteMaterial({
    map: zzzTex,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const zzz = new THREE.Sprite(zzzMat);
  zzz.name = "zzz";
  zzz.scale.set(ZZZ_SIZE, ZZZ_SIZE, 1);
  zzz.position.set(0.3, ZZZ_BASE_Y, 0.1);
  zzz.visible = false;
  group.add(zzz);

  // --- animation state ---
  const hopHeight = config.HOP_HEIGHT ?? 0.25;
  const unconscious = kind === "unconscious";
  let t = Math.random() * 10; // desync anims across keepers
  let walking = false;
  let selected = false;
  let hopBlend = 0; // 0 idle .. 1 full hop
  let hopPhase = Math.random();
  let tired = 0; // 0 rested .. 2 needs_sleep (setTired)
  let sleeping = false; // interior doze (setSleeping)
  let hopHz = tiredHopHz(tired);
  let lidShown = 1; // eased eyelid scale (droop / doze close)
  let lidOffsetShown = 0; // eased eyelid slide

  const blinkPeriod = unconscious ? [4.5, 8.5] : [2.4, 5.2];
  const blinkDur = unconscious ? 0.26 : 0.13;
  let nextBlinkIn = blinkPeriod[0] + Math.random() * (blinkPeriod[1] - blinkPeriod[0]);
  let blinkT = -1; // <0 means not blinking

  const baseOpacities = materials.map((m) => m.opacity);
  let opacityMult = 1;
  const hiBase = hiMat.opacity;

  function applyOpacity() {
    materials.forEach((m, i) => {
      if (m === hiMat) return;
      if (opacityMult >= 0.999 && !translucent) {
        m.transparent = false;
        m.opacity = 1;
      } else {
        m.transparent = true;
        m.opacity = baseOpacities[i] * opacityMult;
      }
    });
    hiMat.opacity = hiBase * opacityMult;
    hiMat.transparent = hiMat.opacity < 0.999;
  }

  return {
    group,

    setWalking(v) {
      walking = Boolean(v);
    },

    setSelected(v) {
      selected = Boolean(v);
    },

    // Session fatigue: 0 rested, 1 unrested, 2 needs_sleep (see tiredLevelFor).
    setTired(level) {
      tired = tiredLevelFor(level);
      hopHz = tiredHopHz(tired);
    },

    // Interior doze: eyes closed, slow deep breathing, Zzz showing.
    setSleeping(v) {
      sleeping = Boolean(v);
    },

    // Scene hook for isle fade-in/out (0..1 multiplier on all materials).
    setOpacity(f) {
      opacityMult = clamp01(f);
      applyOpacity();
      group.visible = opacityMult > 0.01;
    },

    update(dt) {
      if (!Number.isFinite(dt) || dt < 0) dt = 0;
      t += dt;

      // Hop blend eases in/out so stopping mid-air is not jarring.
      const blendTarget = walking && !unconscious ? 1 : 0;
      hopBlend += (blendTarget - hopBlend) * Math.min(1, dt * 6);
      if (hopBlend > 0.01) hopPhase = (hopPhase + dt * hopHz) % 1;

      const pose = hopPose(hopPhase, { height: hopHeight });
      const breath = sleeping ? breathScale(t, { amplitude: 0.05, hz: 0.16 }) : breathScale(t);
      const idleY = unconscious ? 0.16 + Math.sin(t * 1.3) * 0.07 : 0;
      const walkBobY = unconscious && walking ? Math.sin(t * 4.2) * 0.03 : 0;

      root.position.y = idleY + walkBobY + pose.y * hopBlend;
      const sy = 1 + (pose.scaleY - 1) * hopBlend;
      const sxz = 1 + (pose.scaleXZ - 1) * hopBlend;
      root.scale.set(sxz * (2 - breath), sy * breath, sxz * (2 - breath));

      // Blink (suspended while sleeping: the lids are already shut).
      let blinkK = 1;
      if (sleeping) {
        blinkT = -1;
      } else if (blinkT >= 0) {
        blinkT += dt;
        const u = blinkT / blinkDur;
        blinkK = blinkOpenness(u);
        if (u >= 1) {
          blinkT = -1;
          blinkK = 1;
          nextBlinkIn = blinkPeriod[0] + Math.random() * (blinkPeriod[1] - blinkPeriod[0]);
        }
      } else {
        nextBlinkIn -= dt;
        if (nextBlinkIn <= 0) blinkT = 0;
      }

      // Eyelids: droop with the tired level, shut while sleeping; eased so
      // level changes and dozing off read as a slow settle, not a pop.
      const lidPose = eyelidPose(tired);
      const lidTarget = sleeping ? SLEEP_LID : lidPose.lid;
      const lidOffsetTarget = sleeping ? -0.06 : lidPose.offsetY;
      const lidEase = Math.min(1, dt * 6);
      lidShown += (lidTarget - lidShown) * lidEase;
      lidOffsetShown += (lidOffsetTarget - lidOffsetShown) * lidEase;
      eyes.scale.y = lidShown * blinkK;
      eyes.position.y = lidOffsetShown;

      // Zzz sprite: level 2 or dozing; pulses and drifts up per cycle.
      const showZzz = (tired >= 2 || sleeping) && opacityMult > 0.01;
      zzz.visible = showZzz;
      if (showZzz) {
        const p = zzzPulse(t);
        zzzMat.opacity = p.opacity * opacityMult;
        zzz.scale.set(ZZZ_SIZE * p.scale, ZZZ_SIZE * p.scale, 1);
        zzz.position.y = ZZZ_BASE_Y + p.y;
      }

      // Selection glow pulse.
      const glowTarget = selected ? 0.18 + 0.08 * Math.sin(t * 5) : 0;
      bodyMat.emissiveIntensity += (glowTarget - bodyMat.emissiveIntensity) * Math.min(1, dt * 8);
    },

    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      zzzMat.dispose();
      zzzTex.dispose();
      group.removeFromParent();
    },
  };
}
