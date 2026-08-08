// Buildings and scenery for the overworld: cottages (one builder, seeded
// variations per keeper: roof shape, tint families, chimney spot, window
// layout, tiny extensions), sandy street ribbons draped over the
// heightfield with soft blended edges, the cobbled plaza and night-hub
// centerpieces, "undiscovered" empty-plot markers (stone circle + signpost
// + mist), instanced tree species, and the small prop kinds (rocks,
// crystals, wisps, ...). cottagePalette + cottageVariant are pure and
// unit-tested; the builders are three.js.

import * as THREE from "three";
import { hashString, mulberry32, makeNoise2D } from "../sim/world.js";
import { mixHex, darkenHex } from "./keeper_mesh.js";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// jsdom (tests) has no 2d canvas backend; builders that draw fall back to
// undrawn textures there instead of crashing.
function ctx2d(canvas) {
  try {
    return canvas.getContext("2d");
  } catch {
    return null;
  }
}

// Seeded per-keeper cottage variation: same silhouette language, clearly
// individual. Deterministic for an keeper id. Pure; tested.
export function cottageVariant(keeperId) {
  const rng = mulberry32(hashString("cottage-variant:" + (keeperId ?? "?")));
  const roofs = ["gable", "hip", "steep"];
  const wallFamilies = ["cream", "rose", "sage", "sky", "sand"];
  const roofFamilies = ["terracotta", "slate", "moss", "plum"];
  const extensions = ["porch", "shed", "flowerbox", "none"];
  return {
    roof: roofs[Math.floor(rng() * roofs.length)],
    wallFamily: wallFamilies[Math.floor(rng() * wallFamilies.length)],
    roofFamily: roofFamilies[Math.floor(rng() * roofFamilies.length)],
    chimney: {
      x: rng() < 0.5 ? -0.55 : 0.55,
      z: rng() < 0.5 ? -0.42 : 0.28,
    },
    frontWindows: 1 + Math.floor(rng() * 2), // 1..2
    sideWindows: Math.floor(rng() * 3), // 0..2 (0 none, 1 right, 2 both)
    extension: extensions[Math.floor(rng() * extensions.length)],
    lanternSide: rng() < 0.5 ? -1 : 1,
    scale: 0.94 + rng() * 0.14,
  };
}

// World-space collision circles for a cottage's variant EXTENSIONS (the
// porch pillars, the side shed), on top of the base house circle sim/world.js
// already carries. The scene feeds these to the walkers, so wander, join and
// sleep walks never clip through a porch or shed. The door approach corridor
// stays open: the porch adds only its two flanking pillars, never a circle
// across the doorstep. Pure; deterministic per keeper id.
// home: { x, z, angle } (the plot position + facing angle, world units).
export function cottageObstacles(keeperId, { x = 0, z = 0, angle = 0 } = {}) {
  const v = cottageVariant(keeperId);
  const s = v.scale;
  // The cottage group is rotated by (PI/2 - angle) about y; three.js maps a
  // local (lx, lz) to world (lx*cos + lz*sin, -lx*sin + lz*cos).
  const theta = Math.PI / 2 - angle;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const at = (lx, lz, r) => ({
    x: x + (lx * cos + lz * sin) * s,
    z: z + (-lx * sin + lz * cos) * s,
    r: r * s,
  });
  const out = [];
  if (v.extension === "porch") {
    // The two porch pillars flank the doorway (local x = +-0.48, z = 1.4).
    out.push(at(-0.48, 1.4, 0.22));
    out.push(at(0.48, 1.4, 0.22));
  } else if (v.extension === "shed") {
    // The side shed (local 0.8 x 1.0 box centered at (shedX, -0.2)).
    out.push(at(-1.32 * v.lanternSide, -0.2, 0.62));
  }
  return out;
}

const WALL_FAMILY = {
  cream: 0xf3e6d2,
  rose: 0xeed3cd,
  sage: 0xdfe6c6,
  sky: 0xd6e2ec,
  sand: 0xecdcb4,
};
const ROOF_FAMILY = {
  terracotta: 0xa85f43,
  slate: 0x67748a,
  moss: 0x6f7f4e,
  plum: 0x7d5b75,
};

// Material colors for one cottage, tinted by the keeper's palette and the
// variant's wall/roof families. The dark variant (night quarter) shifts
// everything cold and dim, with warm window glow against the moonlit blues.
export function cottagePalette(palette = {}, dark = false, variant = null) {
  const primary = palette.primary ?? 0xf8a7c0;
  const accent = palette.accent ?? 0x7c4a6b;
  const wallBase = WALL_FAMILY[variant?.wallFamily] ?? WALL_FAMILY.cream;
  const roofBase = ROOF_FAMILY[variant?.roofFamily] ?? 0x9a5b47;
  if (!dark) {
    const wall = mixHex(primary, wallBase, 0.72);
    const roof = mixHex(accent, roofBase, 0.62);
    return {
      wall,
      trim: darkenHex(wall, 0.42),
      roof,
      ridge: darkenHex(roof, 0.3),
      door: darkenHex(accent, 0.2),
      frame: mixHex(wall, 0x6b4a3a, 0.55),
      plinth: 0x8f8a82,
      chimney: 0x9a8f85,
      glow: 0xffd88a,
    };
  }
  const wall = mixHex(mixHex(primary, mixHex(wallBase, 0x8f86b3, 0.75), 0.62), 0x221b3c, 0.5);
  const roof = mixHex(mixHex(accent, roofBase, 0.4), 0x151027, 0.6);
  return {
    wall,
    trim: darkenHex(wall, 0.45),
    roof,
    ridge: darkenHex(roof, 0.35),
    door: darkenHex(mixHex(accent, 0x2a2145, 0.5), 0.25),
    frame: darkenHex(wall, 0.3),
    plinth: 0x3a3350,
    chimney: 0x453d5c,
    // Warm window glow: the one warm accent against the quarter's cold
    // moonlit blues (keeps the permanent-night district readable and homely).
    glow: 0xffc27d,
  };
}

// Fine cobblestone canvas texture for the plaza and hub discs only (streets
// are sandy lanes now). Multiplied under vertex colors, so district tinting
// still works.
export function makeCobbleTexture(size = 256) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = ctx2d(canvas);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  if (!ctx) return tex;

  // Mortar base.
  ctx.fillStyle = "#8d8579";
  ctx.fillRect(0, 0, size, size);
  const rng = mulberry32(hashString("cobbles"));
  const cols = 11; // fine stones: plaza-scaled, never plastic-oversized
  const rows = 14;
  const cw = size / cols;
  const ch = size / rows;
  for (let r = -1; r <= rows; r++) {
    const offset = (r % 2) * cw * 0.5; // staggered courses
    for (let c = -1; c <= cols; c++) {
      const x = c * cw + offset + (rng() - 0.5) * 2;
      const y = r * ch + (rng() - 0.5) * 2;
      const w = cw * (0.8 + rng() * 0.12);
      const h = ch * (0.76 + rng() * 0.14);
      const lum = 196 + Math.floor(rng() * 46);
      const warm = rng() * 10;
      ctx.fillStyle = `rgb(${lum},${lum - 4 - warm},${lum - 12 - warm})`;
      ctx.beginPath();
      ctx.roundRect(x + 1.5, y + 1.5, w, h, Math.min(w, h) * 0.34);
      ctx.fill();
      // Top-light bevel.
      ctx.fillStyle = "rgba(255,255,255,0.14)";
      ctx.beginPath();
      ctx.roundRect(x + 1.5, y + 1.5, w, h * 0.34, Math.min(w, h) * 0.34);
      ctx.fill();
      // Speckle.
      ctx.fillStyle = "rgba(60,55,48,0.22)";
      for (let s = 0; s < 2; s++) ctx.fillRect(x + 3 + rng() * w, y + 3 + rng() * h * 0.8, 1.2, 1.2);
    }
  }
  tex.needsUpdate = true;
  return tex;
}

// Sandy path texture for street ribbons: worn dirt lane with faint pebbles,
// wheel-wear streaks along the direction of travel (v axis) and SOFT ALPHA
// EDGES across it (u axis), so the lane blends into the meadow instead of
// reading as a hard plastic ribbon. u is clamped, v tiles along the street.
export function makeSandPathTexture(w = 128, h = 256) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = ctx2d(canvas);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  if (!ctx) return tex;

  const rng = mulberry32(hashString("sandpath"));
  const edgeN = makeNoise2D(hashString("sandpath:edge"));
  const img = ctx.createImageData(w, h);
  const px = img.data;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const u = i / (w - 1); // across the lane
      // Sandy base with soft mottling.
      const n = rng() * 0.12;
      let r = 0.78 + n - 0.06;
      let g = 0.7 + n - 0.06;
      let b = 0.52 + n - 0.05;
      // Two worn wheel ruts.
      for (const ruts of [0.32, 0.68]) {
        const d = Math.abs(u - ruts);
        const wear = Math.max(0, 1 - d / 0.09);
        r -= wear * 0.07;
        g -= wear * 0.07;
        b -= wear * 0.06;
      }
      // Grass-tinged edges before the alpha fade (greener, so mid-alpha
      // texels already read like the meadow they dissolve into).
      const edge = Math.max(0, Math.abs(u - 0.5) * 2 - 0.4) / 0.6;
      r -= edge * 0.16;
      g -= edge * 0.03;
      b -= edge * 0.11;
      // Organic alpha edges: a WIDE fade band undulating with low-frequency
      // noise along the lane (sampled on a circle in noise space, so the
      // texture stays seamless under v-repeat), plus a little per-texel
      // dither so the last texels dissolve grain by grain.
      const va = (j / h) * Math.PI * 2;
      const wobble = (edgeN(u * 3.1 + Math.cos(va) * 1.4, Math.sin(va) * 1.4) - 0.5) * 0.34;
      const grainDither = (rng() - 0.5) * 0.14;
      const alpha = Math.min(
        1,
        Math.max(0, (1 - Math.abs(u - 0.5) * 2) / 0.52 + wobble + grainDither),
      );
      const k = (j * w + i) * 4;
      px[k] = Math.min(255, r * 255);
      px[k + 1] = Math.min(255, g * 255);
      px[k + 2] = Math.min(255, b * 255);
      px[k + 3] = Math.min(1, alpha) * 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Faint pebbles and worn stones, low contrast, kept small.
  for (let s = 0; s < 130; s++) {
    const x = w * (0.12 + rng() * 0.76);
    const y = rng() * h;
    const rr = 1 + rng() * 2.4;
    const lum = 150 + rng() * 70;
    ctx.fillStyle = `rgba(${lum},${lum - 8},${lum - 22},${0.24 + rng() * 0.2})`;
    ctx.beginPath();
    ctx.ellipse(x, y, rr, rr * (0.6 + rng() * 0.4), rng() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Tiny geometry merge (positions/normals/uvs + index), used by the tree
// species and the cottage roofs. Zero-build: no BufferGeometryUtils import.
// ---------------------------------------------------------------------------

function mergeGeoms(geos) {
  const merged = new THREE.BufferGeometry();
  const attrs = ["position", "normal", "uv"];
  const idx = [];
  let offset = 0;
  const buffers = { position: [], normal: [], uv: [] };
  for (const g of geos) {
    for (const name of attrs) {
      if (g.attributes[name]) buffers[name].push(g.attributes[name].array);
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) idx.push(g.index.array[i] + offset);
    } else {
      for (let i = 0; i < g.attributes.position.count; i++) idx.push(i + offset);
    }
    offset += g.attributes.position.count;
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
  merged.setAttribute("position", new THREE.BufferAttribute(cat(buffers.position), 3));
  if (buffers.uv.length === geos.length) {
    merged.setAttribute("uv", new THREE.BufferAttribute(cat(buffers.uv), 2));
  }
  merged.setIndex(idx);
  merged.computeVertexNormals();
  for (const g of geos) g.dispose();
  return merged;
}

// ---------------------------------------------------------------------------
// Cottage
// ---------------------------------------------------------------------------

// buildCottage({keeper, dark}) -> { group, door, windowMats, lanternMats }
// The group's origin sits on the flattened plot; the front (door) faces +z.
// One builder, seeded variations (cottageVariant) keyed by the keeper id.
// The whole group picks as her house (userData.pick "house": clicking any
// part of the cottage selects its owner); the door and its knob keep their
// own "door" pick, so a door click still enters the interior.
export function buildCottage({ keeper = {}, dark = false } = {}) {
  const variant = cottageVariant(keeper.id);
  const pal = cottagePalette(keeper.palette, dark, variant);
  const rng = mulberry32(hashString("cottage:" + (keeper.id ?? "?")));
  const group = new THREE.Group();
  group.name = `cottage:${keeper.id ?? "?"}`;
  group.userData.pick = "house";
  group.userData.keeperId = keeper.id;

  const solid = (geo, hex, opts = {}) => {
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ color: hex, flatShading: true, roughness: 0.9, ...opts }),
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };

  // Stone plinth + walls + corner trim.
  solid(new THREE.BoxGeometry(2.15, 0.22, 1.85), pal.plinth).position.y = 0.11;
  solid(new THREE.BoxGeometry(1.9, 1.3, 1.6), pal.wall).position.y = 0.87;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      solid(new THREE.BoxGeometry(0.16, 1.34, 0.16), pal.trim).position.set(0.88 * sx, 0.87, 0.73 * sz);
    }
  }

  // Roof: variant-shaped (gable / hip / steep), overhanging, with chimney.
  const eaveY = 1.52;
  const steep = variant.roof === "steep";
  const rise = steep ? 1.12 : 0.62;
  const ridgeY = eaveY + rise;
  const half = 1.05; // horizontal half-span incl. overhang
  if (variant.roof === "hip") {
    // Four-sided pyramid cap, slightly overhanging.
    const cap = new THREE.ConeGeometry(1, rise + 0.12, 4);
    cap.rotateY(Math.PI / 4);
    const roofMesh = solid(cap, pal.roof);
    roofMesh.scale.set(1.55, 1, 1.25);
    roofMesh.position.y = eaveY + (rise + 0.12) / 2;
    solid(new THREE.BoxGeometry(2.3, 0.09, 1.95), pal.ridge).position.y = eaveY + 0.01;
  } else {
    const slope = Math.hypot(rise, half);
    const pitch = Math.atan2(rise, half);
    for (const s of [-1, 1]) {
      const slab = solid(new THREE.BoxGeometry(2.5, 0.09, slope + 0.06), pal.roof);
      slab.position.set(0, (eaveY + ridgeY) / 2, (half / 2) * s);
      slab.rotation.x = pitch * s;
    }
    solid(new THREE.BoxGeometry(2.56, 0.13, 0.2), pal.ridge).position.y = ridgeY + 0.02;
    const gableShape = new THREE.Shape([
      new THREE.Vector2(-0.8, 0),
      new THREE.Vector2(0.8, 0),
      new THREE.Vector2(0, rise),
    ]);
    for (const s of [-1, 1]) {
      const gable = solid(new THREE.ShapeGeometry(gableShape), pal.wall, { side: THREE.DoubleSide });
      gable.position.set(0.949 * s, eaveY, 0);
      gable.rotation.y = (Math.PI / 2) * s;
    }
  }
  const chimTop = variant.roof === "hip" ? eaveY + rise * 0.7 : ridgeY * 0.92;
  solid(new THREE.BoxGeometry(0.24, 0.8, 0.24), pal.chimney).position.set(variant.chimney.x, chimTop, variant.chimney.z);
  solid(new THREE.BoxGeometry(0.32, 0.09, 0.32), darkenHex(pal.chimney, 0.35)).position.set(
    variant.chimney.x,
    chimTop + 0.44,
    variant.chimney.z,
  );

  // Door: its own pickable mesh, framed, slightly proud of the front wall.
  solid(new THREE.BoxGeometry(0.6, 0.95, 0.1), pal.frame).position.set(0, 0.7, 0.82);
  const door = solid(new THREE.BoxGeometry(0.44, 0.8, 0.08), pal.door, { roughness: 0.7 });
  door.position.set(0, 0.62, 0.87);
  door.userData.pick = "door";
  door.userData.keeperId = keeper.id;
  const knob = solid(new THREE.SphereGeometry(0.035, 8, 6), 0xf7e7b0, { roughness: 0.3, metalness: 0.6 });
  knob.position.set(0.14, 0.6, 0.92);
  knob.userData.pick = "door"; // the knob is part of the door, not the house
  knob.userData.keeperId = keeper.id;
  solid(new THREE.BoxGeometry(0.64, 0.1, 0.4), darkenHex(pal.plinth, 0.15)).position.set(0, 0.05, 1.05);

  // Windows: variant layout, emissive at night. One material per cottage so
  // the scene can drive the glow.
  const windowMat = new THREE.MeshStandardMaterial({
    color: 0x2c2c3a,
    emissive: new THREE.Color(pal.glow),
    emissiveIntensity: 0,
    roughness: 0.4,
  });
  const paneGeo = new THREE.PlaneGeometry(0.3, 0.3);
  const frameGeo = new THREE.BoxGeometry(0.42, 0.42, 0.08);
  const addWindow = (x, y, z, rotY = 0) => {
    const f = solid(frameGeo, pal.frame);
    f.position.set(x, y, z);
    f.rotation.y = rotY;
    const pane = new THREE.Mesh(paneGeo, windowMat);
    const off = 0.055;
    pane.position.set(x + Math.sin(rotY) * off, y, z + Math.cos(rotY) * off);
    pane.rotation.y = rotY;
    group.add(pane);
  };
  if (variant.frontWindows === 1) {
    addWindow(0.5 * (rng() < 0.5 ? -1 : 1), 1.05, 0.81);
  } else {
    addWindow(-0.55, 1.05, 0.81);
    addWindow(0.55, 1.05, 0.81);
  }
  const sides = variant.sideWindows === 0 ? [] : variant.sideWindows === 1 ? [1] : [-1, 1];
  for (const sx of sides) {
    addWindow(0.96 * sx, 1.0, -0.15, (Math.PI / 2) * sx);
  }

  // Yard: a lantern by the door plus one seeded extra.
  const lanternMat = new THREE.MeshStandardMaterial({
    color: 0x3a3430,
    emissive: new THREE.Color(pal.glow),
    emissiveIntensity: 0,
    roughness: 0.5,
  });
  const lanternSide = variant.lanternSide;
  const pole = solid(new THREE.CylinderGeometry(0.03, 0.045, 0.78, 6), 0x4a4038);
  pole.position.set(1.05 * lanternSide, 0.39, 0.8);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.17, 0.15), lanternMat);
  head.position.set(1.05 * lanternSide, 0.84, 0.8);
  group.add(head);

  // Tiny extension: porch, side shed or a flowerbox under the front window.
  if (variant.extension === "porch") {
    solid(new THREE.BoxGeometry(1.1, 0.08, 0.7), darkenHex(pal.plinth, 0.1)).position.set(0, 0.1, 1.15);
    for (const sx of [-1, 1]) {
      solid(new THREE.CylinderGeometry(0.045, 0.05, 0.85, 6), pal.trim).position.set(0.48 * sx, 0.55, 1.4);
    }
    const porchRoof = solid(new THREE.BoxGeometry(1.2, 0.07, 0.85), pal.roof);
    porchRoof.position.set(0, 1.05, 1.22);
    porchRoof.rotation.x = 0.18;
  } else if (variant.extension === "shed") {
    const shedX = -1.32 * lanternSide;
    solid(new THREE.BoxGeometry(0.8, 0.72, 1.0), darkenHex(pal.wall, 0.12)).position.set(shedX, 0.36, -0.2);
    const shedRoof = solid(new THREE.BoxGeometry(0.95, 0.07, 1.15), darkenHex(pal.roof, 0.12));
    shedRoof.position.set(shedX, 0.82, -0.2);
    shedRoof.rotation.z = 0.22 * Math.sign(shedX);
  } else if (variant.extension === "flowerbox") {
    const boxX = variant.frontWindows === 1 ? 0 : 0.55;
    solid(new THREE.BoxGeometry(0.46, 0.12, 0.14), darkenHex(pal.frame, 0.1)).position.set(boxX, 0.8, 0.86);
    const petals = [0xf2b6d0, 0xf8dc8a, 0xc9d8ff];
    for (let i = 0; i < 3; i++) {
      const bloom = solid(new THREE.IcosahedronGeometry(0.045, 0), petals[i % petals.length]);
      bloom.position.set(boxX - 0.14 + i * 0.14, 0.89, 0.87);
    }
  } else {
    // seeded classic yard bits
    const extra = rng();
    if (extra < 0.5) {
      const bush = solid(new THREE.IcosahedronGeometry(0.3, 0), dark ? 0x2c3450 : 0x4e7a3f);
      bush.scale.y = 0.72;
      bush.position.set(-1.05 * lanternSide, 0.2, 0.7 + rng() * 0.4);
    } else {
      const barrel = solid(new THREE.CylinderGeometry(0.18, 0.21, 0.42, 9), dark ? 0x3f3855 : 0x8a6a48);
      barrel.position.set(-1.15 * lanternSide, 0.21, 0.35);
    }
  }

  group.scale.setScalar(variant.scale);
  // Topic flag (BACKLOG item 8): a small corner pole flying a banner with the
  // keeper's topic, readable from BOTH sides (two faces, one shared texture,
  // MeshBasic so it stays legible in the night quarter).
  const topic = (keeper.topic ?? keeper.name ?? "").toString().trim();
  if (topic) {
    const pole = solid(new THREE.CylinderGeometry(0.03, 0.04, 2.45, 6), darkenHex(pal.trim, 0.1));
    pole.position.set(1.25, 1.22, 0.75);
    pole.name = "topic-flag-pole";
    const flagMat = new THREE.MeshBasicMaterial({ map: flagTexture(topic, keeper.palette?.primary) });
    const flagGeo = new THREE.PlaneGeometry(0.85, 0.3);
    const front = new THREE.Mesh(flagGeo, flagMat);
    front.name = "topic-flag-front";
    front.position.set(1.25 - 0.445, 2.28, 0.75 + 0.011);
    const back = new THREE.Mesh(flagGeo, flagMat);
    back.name = "topic-flag-back";
    back.position.set(1.25 - 0.445, 2.28, 0.75 - 0.011);
    back.rotation.y = Math.PI;
    group.add(front);
    group.add(back);
  }

  return { group, door, windowMats: [windowMat], lanternMats: [lanternMat] };
}

// ---------------------------------------------------------------------------
// Empty plots: undiscovered sites (stone circle + signpost + mist wisp)
// ---------------------------------------------------------------------------

function mistTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = ctx2d(canvas);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (!ctx) return tex;
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, "rgba(235,240,250,0.5)");
  g.addColorStop(0.55, "rgba(225,232,248,0.22)");
  g.addColorStop(1, "rgba(225,232,248,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  tex.needsUpdate = true;
  return tex;
}

let sharedMistTex = null;

// The topic banner texture: palette-tinted cloth with the topic name in
// dark high-contrast lettering. jsdom-safe (null 2d context tolerated).
export function flagTexture(topic, primaryHex = "#f8a7c0") {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 96;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const ctx = canvas.getContext("2d");
  if (!ctx) return tex;
  ctx.fillStyle = typeof primaryHex === "string" ? primaryHex : "#f8a7c0";
  ctx.fillRect(0, 0, 256, 96);
  const shade = ctx.createLinearGradient(0, 0, 0, 96);
  shade.addColorStop(0, "rgba(255,255,255,0.25)");
  shade.addColorStop(1, "rgba(40,20,30,0.25)");
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, 256, 96);
  ctx.strokeStyle = "rgba(45,25,35,0.6)";
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, 250, 90);
  ctx.fillStyle = "#2d1a26";
  const label = topic.toUpperCase().slice(0, 14);
  let px = 46;
  ctx.font = `bold ${px}px system-ui, sans-serif`;
  while (px > 18 && ctx.measureText(label).width > 224) {
    px -= 2;
    ctx.font = `bold ${px}px system-ui, sans-serif`;
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, 128, 52);
  tex.needsUpdate = true;
  return tex;
}

// The VACANT signboard face: one shared canvas texture, drawn on BOTH sides
// of every empty plot's board. The spec is pure (tested); the draw helper
// takes any 2d-context-shaped object so tests can record the calls.
export function vacantSignSpec() {
  return {
    text: "VACANT",
    w: 128,
    h: 64,
    bg: "#f1e4c8", // pale board
    ink: "#372a1e", // dark stain: high contrast, readable at play zoom
    frame: "#8a6a48",
    font: "bold 30px 'Trebuchet MS', 'Segoe UI', sans-serif",
  };
}

export function drawVacantSign(ctx, spec = vacantSignSpec()) {
  const { w, h } = spec;
  ctx.fillStyle = spec.bg;
  ctx.fillRect(0, 0, w, h);
  // Wood-grain hairlines, subtle.
  ctx.strokeStyle = "rgba(122,90,62,0.18)";
  ctx.lineWidth = 1;
  const rng = mulberry32(hashString("vacant-grain"));
  for (let i = 0; i < 7; i++) {
    const y = 4 + rng() * (h - 8);
    ctx.beginPath();
    ctx.moveTo(2, y);
    ctx.lineTo(w - 2, y + (rng() - 0.5) * 5);
    ctx.stroke();
  }
  ctx.strokeStyle = spec.frame;
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, w - 4, h - 4);
  ctx.fillStyle = spec.ink;
  ctx.font = spec.font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(spec.text, w / 2, h / 2 + 1);
}

function vacantTexture() {
  const spec = vacantSignSpec();
  const canvas = document.createElement("canvas");
  canvas.width = spec.w;
  canvas.height = spec.h;
  const ctx = ctx2d(canvas);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (ctx) drawVacantSign(ctx, spec);
  tex.needsUpdate = true;
  return tex;
}

// buildEmptyPlots({plots}) -> { group, mist: [{sprite, baseY, phase}] }
// Undiscovered sites for EVERY empty plot at once, instanced: one draw call
// each for the stone circles, the faint rings, the signposts, their boards
// and the two VACANT faces (front + back), plus one small mist sprite per
// plot. Subtle and discoverable; the sign is readable from both sides.
export function buildEmptyPlots({ plots = [] } = {}) {
  const group = new THREE.Group();
  group.name = "empty-plots";
  const mist = [];
  if (!plots.length) return { group, mist };

  const STONES = 9;
  const stoneGeo = new THREE.DodecahedronGeometry(0.16, 0);
  // No ground ring here: the faint white circle read badly and the owner
  // asked for it to be removed (BACKLOG item 2). Stones + signpost + mist
  // carry the "undiscovered" look on their own.
  // The post stops where the board begins, so it never crosses the VACANT
  // lettering on either face.
  const postGeo = new THREE.CylinderGeometry(0.04, 0.05, 0.68, 6);
  const boardGeo = new THREE.BoxGeometry(0.58, 0.3, 0.05);
  const faceGeo = new THREE.PlaneGeometry(0.52, 0.26);

  const lit = (opts = {}) => new THREE.MeshStandardMaterial({ flatShading: true, roughness: 1, ...opts });
  const stones = new THREE.InstancedMesh(stoneGeo, lit(), plots.length * STONES);
  const posts = new THREE.InstancedMesh(postGeo, lit(), plots.length);
  const boards = new THREE.InstancedMesh(boardGeo, lit(), plots.length);
  // The VACANT text: two instanced faces per board (front and back), one
  // shared canvas texture. MeshBasic keeps the lettering readable in the
  // night quarter too.
  const faceMat = new THREE.MeshBasicMaterial({ map: vacantTexture() });
  const faceFront = new THREE.InstancedMesh(faceGeo, faceMat, plots.length);
  const faceBack = new THREE.InstancedMesh(faceGeo, faceMat, plots.length);
  faceFront.name = "vacant-face-front";
  faceBack.name = "vacant-face-back";
  stones.castShadow = true;
  stones.receiveShadow = true;
  posts.castShadow = true;
  boards.castShadow = true;

  if (!sharedMistTex) sharedMistTex = mistTexture();

  const plotM = new THREE.Matrix4();
  const localM = new THREE.Matrix4();
  const outM = new THREE.Matrix4();
  const faceLocal = new THREE.Matrix4();
  const faceM = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const lq = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3(1, 1, 1);
  const euler = new THREE.Euler();
  const color = new THREE.Color();

  plots.forEach((plot, pi) => {
    const dark = plot.sector === "night";
    const rng = mulberry32(hashString("emptyplot:" + (plot?.id ?? "?")));
    q.setFromAxisAngle(up, Math.PI / 2 - (plot.angle ?? 0)); // +z faces the hub
    pos.set(plot.x, plot.y ?? 0, plot.z);
    plotM.compose(pos, q, scl);

    // Stone circle.
    for (let i = 0; i < STONES; i++) {
      const a = (i / STONES) * Math.PI * 2 + rng() * 0.3;
      const r = 1.45 + (rng() - 0.5) * 0.2;
      pos.set(Math.cos(a) * r, 0.05, Math.sin(a) * r);
      lq.setFromAxisAngle(up, rng() * Math.PI);
      scl.set(0.8 + rng() * 0.5, 0.5 + rng() * 0.3, 0.8 + rng() * 0.5);
      localM.compose(pos, lq, scl);
      outM.multiplyMatrices(plotM, localM);
      const k = pi * STONES + i;
      stones.setMatrixAt(k, outM);
      stones.setColorAt(k, color.set(dark ? 0x4c4a68 : 0x9a938a));
    }

    // Signpost near the front (post + tilted board).
    lq.identity();
    scl.set(1, 1, 1);
    pos.set(0.5, 0.34, 1.5);
    localM.compose(pos, lq, scl);
    outM.multiplyMatrices(plotM, localM);
    posts.setMatrixAt(pi, outM);
    posts.setColorAt(pi, color.set(dark ? 0x453d5c : 0x7a5a3e));
    pos.set(0.5, 0.82, 1.5);
    euler.set(0, 0.2 + rng() * 0.3, (rng() - 0.5) * 0.12);
    lq.setFromEuler(euler);
    localM.compose(pos, lq, scl);
    outM.multiplyMatrices(plotM, localM);
    boards.setMatrixAt(pi, outM);
    boards.setColorAt(pi, color.set(mixHex(dark ? 0x453d5c : 0x7a5a3e, 0xffffff, 0.18)));
    // The VACANT lettering, just proud of BOTH board sides.
    faceLocal.makeTranslation(0, 0, 0.033);
    faceM.multiplyMatrices(localM, faceLocal);
    outM.multiplyMatrices(plotM, faceM);
    faceFront.setMatrixAt(pi, outM);
    faceLocal.makeRotationY(Math.PI).setPosition(0, 0, -0.033);
    faceM.multiplyMatrices(localM, faceLocal);
    outM.multiplyMatrices(plotM, faceM);
    faceBack.setMatrixAt(pi, outM);

    // One wisp of mist, gently bobbing (the scene animates the refs).
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: sharedMistTex,
        transparent: true,
        opacity: dark ? 0.14 : 0.18,
        depthWrite: false,
      }),
    );
    sprite.position.set(plot.x + (rng() - 0.5) * 1.2, (plot.y ?? 0) + 0.55, plot.z + (rng() - 0.5) * 1.2);
    sprite.scale.set(2.8, 1.7, 1);
    group.add(sprite);
    mist.push({ sprite, baseY: sprite.position.y, phase: rng() * Math.PI * 2 });
  });

  for (const m of [stones, posts, boards, faceFront, faceBack]) {
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    group.add(m);
  }
  return { group, mist };
}

// ---------------------------------------------------------------------------
// Gardens: a tiny dirt loop + 2-3 small props around every OCCUPIED cottage
// ---------------------------------------------------------------------------

// buildGardens({plots, world, texture}) -> { group, glowMats }
// Draws each plot's pre-planned garden props (existing prop kinds only).
// The garden LOOP stays walkable (sim/world.js plot.garden.loop feeds the
// walkers) but draws no ribbon texture: the owner asked for the circular
// path texture around houses to be removed (BACKLOG item 3). The world and
// texture params stay for signature compatibility.
export function buildGardens({ plots = [], world = null, texture = null } = {}) {
  void world;
  void texture;
  const group = new THREE.Group();
  group.name = "gardens";
  const glowMats = [];
  for (const plot of plots) {
    const garden = plot.garden;
    if (!garden) continue;
    const dark = plot.sector === "night";
    for (const p of garden.props ?? []) {
      const built = buildProp(p, dark);
      built.group.position.y = p.y - 0.03;
      group.add(built.group);
      glowMats.push(...built.glowMats);
    }
  }
  return { group, glowMats };
}

// ---------------------------------------------------------------------------
// Street ribbons and plazas
// ---------------------------------------------------------------------------

// Per-vertex alpha at a ribbon TERMINAL: 0 exactly at the tip, back to 1
// after `fadeLen` along the lane. Quadratic, so most of the stretch reads
// well faded (aggressive): ends dissolve instead of drawing a collided edge
// where a lane meets the plaza, the hub or another lane. Pure; tested.
export function endFadeAlpha(d, fadeLen = 2.4) {
  const t = Math.min(1, Math.max(0, d / Math.max(1e-6, fadeLen)));
  return t * t;
}

// A street: a ribbon draped over the heightfield carrying the sandy path
// texture (soft alpha edges across, tiling along), tinted toward the night
// palette by the world's district mask (the ridge road darkens as it
// crosses over). width comes from the street's tier (spurs narrow, mains
// wide); `fade` dims the whole lane (empty-plot spurs read fainter).
// `endFade` ({head, tail, length = 2.4}) fades the ribbon alpha out over the
// last stretch of the flagged terminals (per-vertex RGBA colors), driven by
// the street graph's junction hints: ends meeting the plaza, the hub or
// another lane dissolve; plot ends (door approaches) stay solid.
// uv u runs across the ribbon, v along it.
export function buildStreetRibbon({
  points = [],
  world,
  width = 1.15,
  texture = null,
  fade = 1,
  endFade = null,
} = {}) {
  if (points.length < 2) return null;
  const halfW = width / 2;
  const noise = colorJitterNoise(7331);
  const sections = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const dx = next.x - prev.x;
    const dz = next.z - prev.z;
    const len = Math.hypot(dx, dz) || 1e-6;
    sections.push({ p: points[i], nx: -dz / len, nz: dx / len });
  }

  const cols = 4; // outerL, innerL, innerR, outerR
  const offsets = [-halfW, -halfW * 0.55, halfW * 0.55, halfW];
  const positions = new Float32Array(sections.length * cols * 3);
  const colors = new Float32Array(sections.length * cols * 4); // RGBA: ends fade out
  const uvs = new Float32Array(sections.length * cols * 2);

  // Cumulative distance along the lane per section (for the end fades).
  const dists = [0];
  for (let i = 1; i < points.length; i++) {
    dists.push(dists[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
  }
  const total = dists[dists.length - 1];
  // Never let the fade eat more than 40% of a short lane per end.
  const fadeLen = Math.min(endFade?.length ?? 2.4, total * 0.4);
  const alphaAt = (d) => {
    let a = 1;
    if (endFade?.head) a = Math.min(a, endFadeAlpha(d, fadeLen));
    if (endFade?.tail) a = Math.min(a, endFadeAlpha(total - d, fadeLen));
    return a;
  };
  // Near-white multipliers: the sand texture carries the color; vertex
  // colors carry district tint + subtle wear jitter.
  const sand = texture ? [0.98, 0.96, 0.92] : [0.66, 0.57, 0.4];
  const border = texture ? [0.88, 0.86, 0.8] : [0.5, 0.44, 0.32];
  const nightSand = [0.52, 0.52, 0.72];
  const nightBorder = [0.42, 0.42, 0.6];

  sections.forEach((s, i) => {
    const along = dists[i];
    const alpha = alphaAt(along);
    const nightW = world.nightMaskAt(s.p.x, s.p.z);
    offsets.forEach((off, j) => {
      const x = s.p.x + s.nx * off;
      const z = s.p.z + s.nz * off;
      const k = (i * cols + j) * 3;
      positions[k] = x;
      positions[k + 1] = world.heightAt(x, z) + 0.05;
      positions[k + 2] = z;
      const u = (i * cols + j) * 2;
      uvs[u] = (off / halfW + 1) / 2; // 0..1 across the ribbon
      uvs[u + 1] = along / 2.4; // texture tiles along the street, world-scaled
      const edge = j === 0 || j === cols - 1;
      let c = edge ? mix(border, nightBorder, nightW) : mix(sand, nightSand, nightW);
      const jitter = (noise(x * 1.7, z * 1.7) - 0.5) * (edge ? 0.05 : 0.1);
      const kc = (i * cols + j) * 4;
      colors[kc] = c[0] + jitter;
      colors[kc + 1] = c[1] + jitter;
      colors[kc + 2] = c[2] + jitter;
      colors[kc + 3] = alpha;
    });
  });

  const indices = [];
  for (let i = 0; i + 1 < sections.length; i++) {
    for (let j = 0; j + 1 < cols; j++) {
      const a = i * cols + j;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      // Counter-clockwise seen from above (+y), so the ribbon faces up and
      // is not backface-culled from the play camera.
      indices.push(a, b, c, b, d, c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  // itemSize 4 turns on three's vertex alpha path (USE_COLOR_ALPHA).
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 4));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: texture ?? null,
    flatShading: false,
    roughness: 1,
    metalness: 0,
    transparent: true,
    opacity: Math.min(1, Math.max(0, fade)),
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  if (texture) mat.color.setScalar(1.12); // the sand map averages ~0.88
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "street";
  mesh.renderOrder = 1;
  mesh.receiveShadow = true;
  return mesh;
}

// Cheap positional hash noise for color jitter (deterministic).
function colorJitterNoise(seed) {
  return (x, z) => {
    const h = hashString(`${seed}:${Math.round(x * 10)}:${Math.round(z * 10)}`);
    return (h % 1000) / 1000;
  };
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// The plaza (day) or night hub (dark): a cobbled disc draped on the terrain
// with a centerpiece (well by day, glowing obelisk in the night quarter).
// Pass the shared cobblestone texture for drawn stones (cloned per disc so
// the repeat can match the radius). -> { group, glowMats }
export function buildPlaza({ center, radius, world, dark = false, texture = null } = {}) {
  const group = new THREE.Group();
  group.name = dark ? "night-hub" : "plaza";
  const glowMats = [];
  const noise = colorJitterNoise(9241);

  const geo = new THREE.CircleGeometry(radius, 48, 0, Math.PI * 2);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  // Break the perfect circle: the rim wobbles with periodic noise (sampled
  // on a circle, so the loop closes seamlessly) and the widened, dithered
  // terrain hub band underneath dissolves the edge into the meadow.
  const rimN = makeNoise2D(hashString(dark ? "plaza-rim:night" : "plaza-rim:day"));
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i);
    const pz = pos.getZ(i);
    const r = Math.hypot(px, pz);
    if (r > radius * 0.6) {
      const ca = px / r;
      const sa = pz / r;
      const mod = 1 + (rimN(ca * 2.1 + 5.7, sa * 2.1 - 3.2) - 0.5) * 0.22 * (r / radius);
      pos.setX(i, px * mod);
      pos.setZ(i, pz * mod);
    }
  }
  const colors = new Float32Array(pos.count * 3);
  const light = dark ? [0.38, 0.35, 0.5] : texture ? [0.7, 0.68, 0.65] : [0.6, 0.58, 0.55];
  const dim = dark ? [0.28, 0.26, 0.4] : texture ? [0.58, 0.55, 0.53] : [0.5, 0.47, 0.45];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + center.x;
    const z = pos.getZ(i) + center.z;
    pos.setY(i, world.heightAt(x, z) + 0.055); // drape on the terrain
    const r = Math.hypot(pos.getX(i), pos.getZ(i));
    const ring = Math.floor((r / radius) * 4) % 2 === 0;
    const c = ring ? light : dim;
    const j = (noise(x * 2.1, z * 2.1) - 0.5) * 0.08;
    colors[i * 3] = c[0] + j;
    colors[i * 3 + 1] = c[1] + j;
    colors[i * 3 + 2] = c[2] + j;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  let discMap = null;
  if (texture) {
    discMap = texture.clone(); // same image, disc-scaled repeat
    discMap.repeat.set(radius * 0.5, radius * 0.5);
    discMap.needsUpdate = true;
  }
  const discMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: discMap,
    flatShading: false,
    roughness: 1,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  if (discMap) discMat.color.setScalar(1.16);
  const disc = new THREE.Mesh(geo, discMat);
  disc.position.set(center.x, 0, center.z);
  disc.receiveShadow = true;
  group.add(disc);

  const baseY = world.heightAt(center.x, center.z) + 0.05;
  if (!dark) {
    // A little well: open ring (so the water inside is visible from the
    // play camera) with a stone rim.
    const stoneMat = new THREE.MeshStandardMaterial({
      color: 0x8a8378,
      flatShading: true,
      roughness: 1,
      side: THREE.DoubleSide,
    });
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.95, 0.55, 12, 1, true), stoneMat);
    wall.position.set(center.x, baseY + 0.27, center.z);
    wall.castShadow = true;
    wall.receiveShadow = true;
    group.add(wall);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.09, 8, 14), stoneMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.set(center.x, baseY + 0.55, center.z);
    rim.castShadow = true;
    group.add(rim);
    const waterMat = new THREE.MeshStandardMaterial({
      color: 0x3f86b5,
      emissive: new THREE.Color(0x2f6f9f),
      emissiveIntensity: 0.25,
      roughness: 0.2,
    });
    glowMats.push(waterMat);
    const disc2 = new THREE.Mesh(new THREE.CircleGeometry(0.72, 14), waterMat);
    disc2.rotation.x = -Math.PI / 2;
    disc2.position.set(center.x, baseY + 0.48, center.z);
    group.add(disc2);
  } else {
    // A glowing obelisk.
    const obeliskMat = new THREE.MeshStandardMaterial({
      color: 0x6d5a8f,
      emissive: new THREE.Color(0x9f8fe0),
      emissiveIntensity: 0.3,
      roughness: 0.3,
      flatShading: true,
    });
    glowMats.push(obeliskMat);
    const obelisk = new THREE.Mesh(new THREE.OctahedronGeometry(0.5, 0), obeliskMat);
    obelisk.scale.y = 2.4;
    obelisk.position.set(center.x, baseY + 1.1, center.z);
    obelisk.castShadow = true;
    group.add(obelisk);
  }

  return { group, glowMats };
}

// ---------------------------------------------------------------------------
// Instanced trees (4 species, day/night tint per instance)
// ---------------------------------------------------------------------------

// Species part factories: local geometry with the origin at the ground.
function speciesGeometry(kind) {
  switch (kind) {
    case "pine": {
      const trunk = new THREE.CylinderGeometry(0.07, 0.11, 0.5, 6);
      trunk.translate(0, 0.25, 0);
      const cones = [];
      for (let i = 0; i < 3; i++) {
        const cone = new THREE.ConeGeometry(0.55 - i * 0.13, 0.7, 7);
        cone.translate(0, 0.7 + i * 0.45, 0);
        cones.push(cone);
      }
      return { trunk, foliage: mergeGeoms(cones) };
    }
    case "tall": {
      const trunk = new THREE.CylinderGeometry(0.06, 0.1, 0.4, 6);
      trunk.translate(0, 0.2, 0);
      const crown = new THREE.IcosahedronGeometry(0.42, 1);
      crown.scale(1, 2.3, 1);
      crown.translate(0, 1.35, 0);
      return { trunk, foliage: crown };
    }
    case "bush": {
      const blobs = [];
      for (const [dx, dz, r] of [[-0.16, 0.08, 0.3], [0.18, -0.05, 0.26], [0, 0.02, 0.34]]) {
        const blob = new THREE.IcosahedronGeometry(r, 0);
        blob.scale(1, 0.72, 1);
        blob.translate(dx, r * 0.6, dz);
        blobs.push(blob);
      }
      return { trunk: null, foliage: mergeGeoms(blobs) };
    }
    default: {
      // round
      const trunk = new THREE.CylinderGeometry(0.09, 0.14, 0.6, 6);
      trunk.translate(0, 0.3, 0);
      const blobs = [];
      const main = new THREE.IcosahedronGeometry(0.56, 1);
      main.scale(1, 0.92, 1);
      main.translate(0, 1.05, 0);
      blobs.push(main);
      const side = new THREE.IcosahedronGeometry(0.34, 1);
      side.translate(0.34, 1.32, 0.12);
      blobs.push(side);
      return { trunk, foliage: mergeGeoms(blobs) };
    }
  }
}

// buildTrees({trees}) -> { group }
// One InstancedMesh per species part (max 8 draw calls for the whole
// forest). Per-instance color carries species jitter + the night tint.
export function buildTrees({ trees = [] } = {}) {
  const group = new THREE.Group();
  group.name = "trees";
  const byKind = new Map();
  for (const t of trees) {
    if (!byKind.has(t.kind)) byKind.set(t.kind, []);
    byKind.get(t.kind).push(t);
  }

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const color = new THREE.Color();

  // Night foliage stays readable under the cool moon key (never pitch-black
  // silhouettes): moonlit blue-greens, clearly darker than day but lit.
  const FOLIAGE_DAY = { round: 0x5a9448, pine: 0x3e7a4a, tall: 0x6aa050, bush: 0x74a854 };
  const FOLIAGE_NIGHT = { round: 0x53689c, pine: 0x475b8c, tall: 0x5d74a8, bush: 0x5c5a92 };
  const TRUNK_DAY = 0x8a6242;
  const TRUNK_NIGHT = 0x6a628f;

  for (const [kind, list] of byKind) {
    const geos = speciesGeometry(kind);
    const rng = mulberry32(hashString("treejitter:" + kind));
    const parts = [];
    if (geos.trunk) {
      parts.push({
        geo: geos.trunk,
        colorOf: (t) => color.set(mixHex(TRUNK_DAY, TRUNK_NIGHT, t.night)),
      });
    }
    parts.push({
      geo: geos.foliage,
      colorOf: (t) => {
        color.set(mixHex(FOLIAGE_DAY[kind], FOLIAGE_NIGHT[kind], t.night));
        color.multiplyScalar(0.85 + rng() * 0.3);
        return color;
      },
    });
    for (const part of parts) {
      const mat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.95, metalness: 0 });
      const mesh = new THREE.InstancedMesh(part.geo, mat, list.length);
      mesh.name = `trees:${kind}`;
      list.forEach((t, i) => {
        q.setFromAxisAngle(up, t.rotation);
        s.setScalar(t.scale * 1.35);
        p.set(t.x, t.y - 0.04, t.z);
        m.compose(p, q, s);
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, part.colorOf(t));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      group.add(mesh);
    }
  }
  return { group };
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

// buildProp(prop, dark) -> { group, glowMats, floaty }
// The group's origin sits on the ground (the scene adds prop.y).
export function buildProp(prop, dark = false) {
  const group = new THREE.Group();
  const s = prop.scale;
  const rng = mulberry32(hashString(`prop:${prop.kind}:${prop.x.toFixed(2)}:${prop.z.toFixed(2)}`));
  const glowMats = [];
  let floaty = false;

  const mk = (geo, hex, opts = {}) => {
    const m = new THREE.MeshStandardMaterial({ color: hex, flatShading: true, roughness: 0.9, ...opts });
    const mesh = new THREE.Mesh(geo, m);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };

  const foliageDay = mixHex(0x4e8a44, 0x74a854, rng());
  const foliageNight = mixHex(0x2c3a5c, 0x3c3555, rng());
  const foliage = dark ? foliageNight : foliageDay;

  switch (prop.kind) {
    case "tree": {
      const trunk = mk(new THREE.CylinderGeometry(0.09 * s, 0.14 * s, 0.55 * s, 6), dark ? 0x4a4060 : 0x8a6242);
      trunk.position.y = 0.27 * s;
      const crown1 = mk(new THREE.ConeGeometry(0.62 * s, 0.95 * s, 7), foliage);
      crown1.position.y = 0.95 * s;
      const crown2 = mk(new THREE.ConeGeometry(0.45 * s, 0.75 * s, 7), mixHex(foliage, 0xffffff, 0.12));
      crown2.position.y = 1.45 * s;
      break;
    }
    case "pine": {
      const trunk = mk(new THREE.CylinderGeometry(0.07 * s, 0.11 * s, 0.5 * s, 6), dark ? 0x453d5c : 0x7a5a3e);
      trunk.position.y = 0.25 * s;
      for (let i = 0; i < 3; i++) {
        const cone = mk(
          new THREE.ConeGeometry((0.55 - i * 0.13) * s, 0.7 * s, 7),
          mixHex(foliage, 0x1d3a2a, dark ? 0 : 0.25 * i),
        );
        cone.position.y = (0.7 + i * 0.5) * s;
      }
      break;
    }
    case "bush": {
      for (let i = 0; i < 3; i++) {
        const blob = mk(new THREE.IcosahedronGeometry(0.28 * s, 0), mixHex(foliage, 0xffffff, rng() * 0.15));
        blob.scale.y = 0.7;
        blob.position.set((rng() - 0.5) * 0.5 * s, 0.18 * s, (rng() - 0.5) * 0.5 * s);
      }
      break;
    }
    case "rock": {
      const rock = mk(new THREE.DodecahedronGeometry(0.4 * s, 0), dark ? 0x4c4462 : 0x8f8a82);
      rock.scale.y = 0.62;
      rock.position.y = 0.18 * s;
      break;
    }
    case "flower": {
      const stem = mk(new THREE.CylinderGeometry(0.02 * s, 0.03 * s, 0.3 * s, 5), 0x5c9a52);
      stem.position.y = 0.15 * s;
      const petals = [0xf2b6d0, 0xf8dc8a, 0xb9d0f8, 0xf8b9a0];
      const head = mk(new THREE.IcosahedronGeometry(0.1 * s, 0), petals[Math.floor(rng() * petals.length)]);
      head.position.y = 0.34 * s;
      break;
    }
    case "crystal": {
      const mat = { emissive: new THREE.Color(dark ? 0x9f8fe0 : 0xb9a7f8), emissiveIntensity: 0.2, roughness: 0.3 };
      const crystal = mk(new THREE.OctahedronGeometry(0.26 * s, 0), dark ? 0x7a6ab0 : 0xb9a7f8, mat);
      crystal.scale.y = 1.7;
      crystal.position.y = 0.4 * s;
      crystal.rotation.y = rng() * Math.PI;
      glowMats.push(crystal.material);
      const shard = mk(new THREE.OctahedronGeometry(0.13 * s, 0), dark ? 0x6d5a8f : 0xcabcf8, mat);
      shard.scale.y = 1.5;
      shard.position.set(0.3 * s, 0.2 * s, 0.1 * s);
      glowMats.push(shard.material);
      break;
    }
    case "wisp": {
      const wispMat = new THREE.MeshStandardMaterial({
        color: 0xbfd8ff,
        emissive: new THREE.Color(0x9fc8ff),
        emissiveIntensity: 0.6,
        transparent: true,
        opacity: 0.85,
        roughness: 0.2,
      });
      const orb = new THREE.Mesh(new THREE.SphereGeometry(0.14 * s, 10, 8), wispMat);
      orb.position.y = 0.9 * s;
      group.add(orb);
      glowMats.push(wispMat);
      floaty = true;
      break;
    }
    default: {
      // stump
      const stump = mk(new THREE.CylinderGeometry(0.22 * s, 0.26 * s, 0.28 * s, 7), dark ? 0x4a4060 : 0x9a7a56);
      stump.position.y = 0.14 * s;
      const top = mk(new THREE.CircleGeometry(0.21 * s, 7), dark ? 0x5c527a : 0xb99a6e);
      top.rotation.x = -Math.PI / 2;
      top.position.y = 0.285 * s;
    }
  }

  group.position.set(prop.x, 0, prop.z);
  group.rotation.y = prop.rotation;
  return { group, glowMats, floaty };
}
