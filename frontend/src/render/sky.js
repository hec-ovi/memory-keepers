// Sky for the overworld: gradient dome, drifting cumulus clusters that cast
// soft moving shadow blobs over the day village, thin wisps + a localized
// starfield + a slow aurora ribbon + a glowing moon and a darker "pall" of
// sky over the unconscious quarter. All procedural canvas textures. The
// cloud placement math (cloudLayout) is pure and unit-tested.

import * as THREE from "three";
import { mulberry32, smoothstep } from "../sim/world.js";
import { ENV, mixHexColor } from "./blend.js";

const clamp01 = (x) => Math.min(1, Math.max(0, x));

// ---------------------------------------------------------------------------
// Pure: cloud layout (tested in tests/sky_helpers.test.js)
// ---------------------------------------------------------------------------

// Deterministic cloud clusters: a FEW large, soft, translucent cumulus high
// over the day side (with faint ground shadow blobs), thin wisps over the
// night quarter. Deliberately sparse, high and slow so they drift as
// atmosphere and never sit heavy over the village paths.
export function cloudLayout({ world, seed = 11, cumulus = 6, wisps = 4 } = {}) {
  const rng = mulberry32(seed >>> 0);
  const day = world.sectors.day;
  const night = world.sectors.night;
  const clusters = [];

  // The play camera looks DOWN at the island (pitch ~25-40 degrees). The
  // layer flies at y ~22..30: still in frame at normal zoom, but clearly
  // sky, not fog rolling through the streets. Clusters drift the whole
  // width of the island, slowly.
  const wrapMin = Math.min(day.center.x, night.center.x) - 40;
  const wrapMax = Math.max(day.center.x, night.center.x) + 40;
  for (let c = 0; c < cumulus; c++) {
    const x = day.center.x + (rng() - 0.5) * 2 * day.radius * 1.5;
    const z = day.center.z + (rng() - 0.5) * 2 * day.radius * 1.1;
    const y = 22 + rng() * 8;
    const n = 2 + Math.floor(rng() * 2);
    const puffs = [];
    for (let i = 0; i < n; i++) {
      puffs.push({
        dx: (i - (n - 1) / 2) * 5.2 + (rng() - 0.5) * 2.2,
        dy: (rng() - 0.35) * 1.8,
        dz: (rng() - 0.5) * 3,
        w: 16 + rng() * 12,
        o: 0.28 + rng() * 0.16,
      });
    }
    clusters.push({
      kind: "cumulus",
      x,
      z,
      y,
      puffs,
      drift: 0.1 + rng() * 0.16,
      wrapMin,
      wrapMax,
      shadow: true,
    });
  }

  for (let c = 0; c < wisps; c++) {
    const x = night.center.x + (rng() - 0.5) * 2 * night.radius * 1.4;
    const z = night.center.z + (rng() - 0.5) * 2 * night.radius * 1.2;
    const y = 21 + rng() * 7;
    const puffs = [
      { dx: -3 - rng() * 2, dy: 0, dz: (rng() - 0.5) * 1.5, w: 12 + rng() * 8, o: 0.24 + rng() * 0.1 },
      { dx: 3 + rng() * 2, dy: (rng() - 0.5) * 0.8, dz: (rng() - 0.5) * 1.5, w: 10 + rng() * 7, o: 0.2 + rng() * 0.1 },
    ];
    clusters.push({
      kind: "wisp",
      x,
      z,
      y,
      puffs,
      drift: 0.07 + rng() * 0.1,
      wrapMin: night.center.x - night.radius * 1.8,
      wrapMax: night.center.x + night.radius * 1.8,
      shadow: false,
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// Canvas textures
// ---------------------------------------------------------------------------

function canvasTexture(w, h, draw) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx) draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Exported for tests: the puff is nothing but big soft radial gradients,
// every one fading to FULLY transparent well inside the canvas, in plain
// source-over compositing. No base band, no clipping tricks, no visible
// rims or rectangles at any zoom; softness comes entirely from the
// gradient falloff.
export function drawCumulusPuff(ctx, w, h) {
  const blobs = [
    [0.5, 0.5, 0.48, 0.4],
    [0.38, 0.56, 0.34, 0.3],
    [0.63, 0.55, 0.32, 0.3],
  ];
  for (const [fx, fy, fr, fo] of blobs) {
    const cx = w * fx;
    const cy = h * fy;
    const r = Math.min(w, h) * fr;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, `rgba(255,255,255,${fo})`);
    g.addColorStop(0.5, `rgba(252,252,255,${fo * 0.5})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
}

function puffTexture() {
  return canvasTexture(256, 256, drawCumulusPuff);
}

function wispTexture() {
  return canvasTexture(256, 96, (ctx, w, h) => {
    const rng = mulberry32(33);
    for (let i = 0; i < 7; i++) {
      const y = h * (0.25 + rng() * 0.5);
      const g = ctx.createRadialGradient(w / 2, y, 2, w / 2, y, w * 0.42);
      g.addColorStop(0, "rgba(225,232,255,0.5)");
      g.addColorStop(1, "rgba(225,232,255,0)");
      ctx.save();
      ctx.translate(w / 2, y);
      ctx.scale(1, 0.16 + rng() * 0.1);
      ctx.translate(-w / 2, -y);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  });
}

function shadowBlobTexture() {
  return canvasTexture(128, 128, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 4, w / 2, h / 2, w / 2);
    g.addColorStop(0, "rgba(0,0,0,0.55)");
    g.addColorStop(0.6, "rgba(0,0,0,0.3)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

function moonTexture() {
  return canvasTexture(128, 128, (ctx, w, h) => {
    const glow = ctx.createRadialGradient(w / 2, h / 2, 6, w / 2, h / 2, w / 2);
    glow.addColorStop(0, "rgba(235,240,255,0.95)");
    glow.addColorStop(0.32, "rgba(190,205,255,0.5)");
    glow.addColorStop(1, "rgba(160,180,255,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "rgba(240,244,255,0.95)";
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, w * 0.16, 0, Math.PI * 2);
    ctx.fill();
    // A couple of soft craters.
    ctx.fillStyle = "rgba(190,200,235,0.5)";
    for (const [dx, dy, r] of [[-4, -3, 3.4], [5, 4, 2.6], [1, 7, 2]]) {
      ctx.beginPath();
      ctx.arc(w / 2 + dx, h / 2 + dy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

function auroraTexture() {
  return canvasTexture(256, 128, (ctx, w, h) => {
    const bands = ctx.createLinearGradient(0, 0, w, 0);
    bands.addColorStop(0, "rgba(80,220,180,0)");
    bands.addColorStop(0.25, "rgba(90,230,190,0.5)");
    bands.addColorStop(0.5, "rgba(120,190,255,0.42)");
    bands.addColorStop(0.75, "rgba(190,140,255,0.5)");
    bands.addColorStop(1, "rgba(80,220,180,0)");
    ctx.fillStyle = bands;
    ctx.fillRect(0, 0, w, h);
    // Vertical curtain streaks + a FULL fade to transparent on every edge
    // (any leftover alpha shows up as a hard rectangle against the day sky).
    const rng = mulberry32(55);
    ctx.globalCompositeOperation = "destination-out";
    for (let i = 0; i < 60; i++) {
      const x = rng() * w;
      ctx.fillStyle = `rgba(0,0,0,${0.12 + rng() * 0.3})`;
      ctx.fillRect(x, 0, 1 + rng() * 3, h);
    }
    const fadeV = ctx.createLinearGradient(0, 0, 0, h);
    fadeV.addColorStop(0, "rgba(0,0,0,1)");
    fadeV.addColorStop(0.4, "rgba(0,0,0,0)");
    fadeV.addColorStop(0.7, "rgba(0,0,0,0)");
    fadeV.addColorStop(1, "rgba(0,0,0,1)");
    ctx.fillStyle = fadeV;
    ctx.fillRect(0, 0, w, h);
    const fadeH = ctx.createLinearGradient(0, 0, w, 0);
    fadeH.addColorStop(0, "rgba(0,0,0,1)");
    fadeH.addColorStop(0.18, "rgba(0,0,0,0)");
    fadeH.addColorStop(0.82, "rgba(0,0,0,0)");
    fadeH.addColorStop(1, "rgba(0,0,0,1)");
    ctx.fillStyle = fadeH;
    ctx.fillRect(0, 0, w, h);
  });
}

// ---------------------------------------------------------------------------
// Sky dome
// ---------------------------------------------------------------------------

export function buildSkyDome({ radius = 260 } = {}) {
  const geo = new THREE.SphereGeometry(radius, 24, 16);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.BackSide,
    fog: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "sky";
  mesh.frustumCulled = false;

  const zen = new THREE.Color();
  const hor = new THREE.Color();
  const tmp = new THREE.Color();
  let last = -1;

  function update(nightness) {
    const n = clamp01(nightness);
    if (Math.abs(n - last) < 0.004) return;
    last = n;
    zen.set(mixHexColor(ENV.day.skyZenith, ENV.night.skyZenith, n));
    hor.set(mixHexColor(ENV.day.skyHorizon, ENV.night.skyHorizon, n));
    for (let i = 0; i < pos.count; i++) {
      const t = smoothstep(-0.06, 0.42, pos.getY(i) / radius);
      tmp.copy(hor).lerp(zen, t);
      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }
    geo.attributes.color.needsUpdate = true;
  }
  update(0);

  return { mesh, update };
}

// ---------------------------------------------------------------------------
// Clouds (cumulus clusters with ground shadows + night wisps)
// ---------------------------------------------------------------------------

// How visible a cloud cluster is at a given camera distance: 1 far away,
// easing to 0 as the camera flies into it. Without this a single sprite
// across the lens whites out the whole frame. `radius` is the cluster's
// widest sprite half-width. Pure; tested.
export function cloudProximityFade(dist, radius) {
  return smoothstep(radius * 0.8, radius * 1.5, dist);
}

export function buildClouds({ world, layout = null } = {}) {
  const clusters = layout ?? cloudLayout({ world });
  const group = new THREE.Group();
  group.name = "clouds";
  const cumulusTex = puffTexture();
  const wispTex = wispTexture();
  const blobTex = shadowBlobTexture();
  const wl = world.waterLevel ?? 0;

  const live = [];
  for (const c of clusters) {
    const holder = new THREE.Group();
    holder.position.set(c.x, c.y, c.z);
    const mats = [];
    for (const p of c.puffs) {
      const mat = new THREE.SpriteMaterial({
        map: c.kind === "wisp" ? wispTex : cumulusTex,
        transparent: true,
        opacity: p.o,
        depthWrite: false,
        fog: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.position.set(p.dx, p.dy, p.dz);
      const stretch = c.kind === "wisp" ? 0.24 : 0.58;
      sprite.scale.set(p.w * (c.kind === "wisp" ? 2 : 1), p.w * stretch, 1);
      holder.add(sprite);
      mats.push({ mat, baseO: p.o });
    }
    // Widest sprite half-width: the camera-proximity fade radius.
    const fadeR = Math.max(...c.puffs.map((p) => (p.w * (c.kind === "wisp" ? 2 : 1)) / 2));
    group.add(holder);

    let shadow = null;
    if (c.shadow) {
      const smat = new THREE.MeshBasicMaterial({
        map: blobTex,
        transparent: true,
        opacity: 0.06, // a passing dimness, not a stain
        depthWrite: false,
        color: 0x10182a,
      });
      shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), smat);
      shadow.rotation.x = -Math.PI / 2;
      const spread = 13 + c.puffs.length * 4;
      shadow.scale.set(spread, spread * 0.7, 1);
      shadow.renderOrder = 1;
      group.add(shadow);
    }
    live.push({ c, holder, mats, shadow, fadeR });
  }

  const tintColor = new THREE.Color();
  return {
    group,
    update(dt, { tint = 0xffffff, camPos = null } = {}) {
      for (const item of live) {
        const { c, holder, mats, shadow, fadeR } = item;
        holder.position.x += c.drift * dt;
        if (holder.position.x > c.wrapMax) holder.position.x = c.wrapMin;
        const localNight = world.nightMaskAt(holder.position.x, holder.position.z);
        // Fade the sprites out when the camera flies into the cluster (the
        // ground shadow stays: the cloud is still overhead).
        const fade = camPos
          ? cloudProximityFade(
              Math.hypot(
                holder.position.x - camPos.x,
                holder.position.y - (camPos.y ?? 0),
                holder.position.z - camPos.z,
              ),
              fadeR,
            )
          : 1;
        // Camera-driven tint, pulled cooler over the night quarter.
        tintColor.set(mixHexColor(tint, 0x7e8cc2, localNight * 0.75));
        for (const { mat, baseO } of mats) {
          mat.color.copy(tintColor);
          mat.opacity = baseO * fade;
        }
        if (shadow) {
          shadow.position.set(
            holder.position.x + 6, // sun sits east-ish; offset the blob
            Math.max(world.heightAt(holder.position.x + 6, holder.position.z + 3), wl) + 0.14,
            holder.position.z + 3,
          );
          shadow.material.opacity = 0.06 * (1 - localNight);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The night quarter's sky: localized stars, moon, aurora, darker pall
// ---------------------------------------------------------------------------

export function buildNightSky({ world, starCount = 320, seed = 0x51ab5 } = {}) {
  const night = world.sectors.night;
  const day = world.sectors.day;
  const group = new THREE.Group();
  group.name = "night-sky";
  const rng = mulberry32(typeof seed === "number" ? seed : 0x51ab5);
  // Unit direction pointing away from the island, past the quarter: the
  // moon and aurora hang out there so they rise above the quarter's horizon
  // when seen from the village at the normal down-looking pitch.
  const awayLen = Math.hypot(night.center.x - day.center.x, night.center.z - day.center.z) || 1;
  const away = {
    x: (night.center.x - day.center.x) / awayLen,
    z: (night.center.z - day.center.z) / awayLen,
  };

  // Stars in a dome over the quarter (not the whole sky).
  const pts = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * night.radius * 2.4;
    pts[i * 3] = night.center.x + Math.cos(a) * r;
    pts[i * 3 + 1] = 24 + rng() * 34; // well above the rooftops, reads as sky
    pts[i * 3 + 2] = night.center.z + Math.sin(a) * r;
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute("position", new THREE.BufferAttribute(pts, 3));
  const starMat = new THREE.PointsMaterial({
    color: 0xf3f2ff,
    size: 0.5,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.6,
    fog: false,
    depthWrite: false,
  });
  const stars = new THREE.Points(starGeo, starMat);
  group.add(stars);

  // Darker sky overhead: a soft dark disc high above the quarter.
  const pallMat = new THREE.MeshBasicMaterial({
    map: canvasTexture(128, 128, (ctx, w, h) => {
      const g = ctx.createRadialGradient(w / 2, h / 2, 6, w / 2, h / 2, w / 2);
      g.addColorStop(0, "rgba(9,11,34,0.6)");
      g.addColorStop(0.65, "rgba(10,13,38,0.35)");
      g.addColorStop(1, "rgba(10,13,38,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }),
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const pall = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), pallMat);
  pall.rotation.x = -Math.PI / 2;
  pall.scale.setScalar(night.radius * 5.2);
  pall.position.set(night.center.x, 52, night.center.z);
  group.add(pall);

  // The moon, hanging over the quarter.
  const moonMat = new THREE.SpriteMaterial({
    map: moonTexture(),
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    fog: false,
  });
  const moon = new THREE.Sprite(moonMat);
  moon.position.set(night.center.x + away.x * 16, 21, night.center.z + away.z * 16);
  moon.scale.set(9, 9, 1);
  group.add(moon);

  // Aurora ribbon: a gently swaying additive curtain.
  const auroraTex = auroraTexture();
  auroraTex.wrapS = THREE.ClampToEdgeWrapping;
  const auroraMat = new THREE.MeshBasicMaterial({
    map: auroraTex,
    transparent: true,
    opacity: 0.32,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const auroraGeo = new THREE.PlaneGeometry(night.radius * 3.6, 7.5, 48, 1);
  // Bend the ribbon into a shallow arc and store base positions for the sway.
  const apos = auroraGeo.attributes.position;
  for (let i = 0; i < apos.count; i++) {
    const t = (apos.getX(i) / (night.radius * 3.6)) * Math.PI;
    apos.setZ(i, Math.sin(t) * -4);
  }
  auroraGeo.computeVertexNormals();
  const aurora = new THREE.Mesh(auroraGeo, auroraMat);
  aurora.position.set(night.center.x + away.x * 11, 15.5, night.center.z + away.z * 11);
  const auroraBaseY = Math.atan2(-away.x, -away.z); // curtain faces the island
  aurora.rotation.y = auroraBaseY;
  aurora.rotation.x = 0.22;
  group.add(aurora);

  return {
    group,
    // camBlend: 0 camera over the village, 1 over the quarter. The night sky
    // is always present (spatial night), just more intense up close.
    update(dt, camBlend = 0, elapsed = 0) {
      const n = clamp01(camBlend);
      starMat.opacity = 0.3 + 0.7 * n;
      moonMat.opacity = 0.7 + 0.3 * n;
      auroraMat.opacity = (0.14 + 0.26 * n) * (1 + 0.2 * Math.sin(elapsed * 0.5));
      aurora.rotation.y = auroraBaseY + Math.sin(elapsed * 0.07) * 0.08;
      aurora.rotation.z = Math.sin(elapsed * 0.11) * 0.05;
    },
  };
}
