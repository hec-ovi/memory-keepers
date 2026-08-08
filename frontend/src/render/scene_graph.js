// Consolidation graph scene: "the movie". Dark space backdrop, glow-sprite
// nodes, edges that draw themselves with a travelling bright head, assembly
// playback driven by the sim/graphlayout timeline, slow auto-orbit camera,
// then a settled interactive state (orbit controls + hover highlighting).
//
// Factory only, no module-level side effects. Pure helpers (easing, schedule,
// colors, label picking, starfield, curves) are exported for unit tests; all
// three.js work stays inside createGraphScene.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { computeGraphLayout, edgeId, mulberry32 } from "../sim/graphlayout.js";
import { createGraphHud } from "../ui/graph_hud.js";
import { config as defaultConfig } from "../config.js";

// --- pure helpers (unit-tested, no three.js) ---------------------------------

export function easeInOutCubic(t) {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export function easeOutBack(t) {
  const x = Math.min(1, Math.max(0, t));
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

// Progress of item i inside a wave: items land staggered across the wave, all
// reaching 1 when the wave finishes. spread in [0,1) is the stagger fraction.
export function staggeredProgress(waveProgress, index, count, spread = 0.55) {
  const wp = Math.min(1, Math.max(0, waveProgress));
  const start = count > 1 ? (spread * index) / count : 0;
  const span = 1 - spread || 1e-6;
  return Math.min(1, Math.max(0, (wp - start) / span));
}

// Turn the normalized layout timeline into absolute seconds. Waves overlap a
// little so the assembly flows instead of stuttering.
export function buildPlaybackSchedule(
  timeline,
  { nodeWaveSeconds = 2.2, edgeDrawSeconds = 1.6, overlap = 0.25 } = {},
) {
  const waves = [];
  let cursor = 0;
  let total = 0;
  for (const wave of timeline ?? []) {
    const duration = wave.edgeIds ? edgeDrawSeconds : nodeWaveSeconds;
    const start = cursor;
    waves.push({ ...wave, start, duration });
    total = Math.max(total, start + duration);
    cursor = start + duration * (1 - overlap);
  }
  return { waves, total };
}

// Only the top-weight nodes get labels so the graph stays compact and readable.
export function pickLabeledNodeIds(nodes, max) {
  return [...(nodes ?? [])]
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || (a.id < b.id ? -1 : 1))
    .slice(0, Math.max(0, max))
    .map((n) => n.id);
}

export function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return { r: ((v >> 16) & 255) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255 };
}

export function mixHex(hexA, hexB, t) {
  const a = parseHex(hexA) ?? { r: 1, g: 1, b: 1 };
  const b = parseHex(hexB) ?? { r: 1, g: 1, b: 1 };
  const k = Math.min(1, Math.max(0, t));
  const c = (x) =>
    Math.round((x * 255))
      .toString(16)
      .padStart(2, "0");
  return `#${c(a.r + (b.r - a.r) * k)}${c(a.g + (b.g - a.g) * k)}${c(a.b + (b.b - a.b) * k)}`;
}

export const ENTITY_GOLD = "#ffd9a0"; // warm white-gold for entity nodes
const FALLBACK_NODE = "#b9a7f8";

// keeper_id -> palette, gathered from live keepers plus the run's newborn keepers.
export function keeperPaletteMap(state, report) {
  const map = new Map();
  const all = [...(state?.keepers ?? []), ...(report?.created_keepers ?? [])];
  for (const keeper of all) {
    if (keeper?.id && keeper?.palette?.primary) map.set(keeper.id, keeper.palette);
  }
  return map;
}

// Node tint: keeper and book nodes take their keeper's palette (books lightened a
// touch so clusters read as "keeper plus her books"); entities are warm gold.
export function nodeColorHex(node, palettes) {
  if (node.kind === "entity") return ENTITY_GOLD;
  const palette = palettes?.get?.(node.keeper_id);
  const primary = palette?.primary && parseHex(palette.primary) ? palette.primary : FALLBACK_NODE;
  if (node.kind === "book") return mixHex(primary, "#ffffff", 0.3);
  return primary;
}

// World size of a node sprite: kind base scaled gently by weight.
export function nodeScale(node) {
  const base = node.kind === "keeper" ? 3.4 : node.kind === "book" ? 1.5 : 2.1;
  return base * (0.7 + 0.3 * Math.sqrt(Math.max(0, node.weight ?? 1)));
}

// Deterministic starfield shell positions (Float32Array of xyz triples).
export function starfieldPositions(count, innerRadius, outerRadius, seed = 42) {
  const rand = mulberry32(seed >>> 0);
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const u = rand() * 2 - 1; // cos(phi), uniform on sphere
    const theta = rand() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const r = innerRadius + (outerRadius - innerRadius) * Math.cbrt(rand());
    out[i * 3] = r * s * Math.cos(theta);
    out[i * 3 + 1] = r * u;
    out[i * 3 + 2] = r * s * Math.sin(theta);
  }
  return out;
}

// Gentle arc between two points: quadratic bezier, midpoint pushed away from
// the origin so edges bow outward instead of slicing through clusters.
export function edgeCurvePoints(a, b, segments = 24, bulge = 0.16) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const mz = (a.z + b.z) / 2;
  const mLen = Math.sqrt(mx * mx + my * my + mz * mz);
  const span = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2);
  const lift = bulge * span; // bounded outward bow, even when mid ~ origin
  const dir = mLen > 1e-6 ? { x: mx / mLen, y: my / mLen, z: mz / mLen } : { x: 0, y: 1, z: 0 };
  const cx = mx + dir.x * lift;
  const cy = my + dir.y * lift;
  const cz = mz + dir.z * lift;
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const q = 1 - t;
    pts.push({
      x: q * q * a.x + 2 * q * t * cx + t * t * b.x,
      y: q * q * a.y + 2 * q * t * cy + t * t * b.y,
      z: q * q * a.z + 2 * q * t * cz + t * t * b.z,
    });
  }
  return pts;
}

// --- textures (canvas, created per scene instance) ---------------------------

function makeGlowTexture(doc, size = 128) {
  const canvas = doc.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d");
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(255,255,255,0.85)");
  grad.addColorStop(0.55, "rgba(255,255,255,0.25)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

function makeRingTexture(doc, size = 128) {
  const canvas = doc.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d");
  g.strokeStyle = "rgba(255,255,255,0.9)";
  g.lineWidth = size * 0.045;
  g.beginPath();
  g.arc(size / 2, size / 2, size * 0.42, 0, Math.PI * 2);
  g.stroke();
  return new THREE.CanvasTexture(canvas);
}

function makeLabelSprite(doc, text, colorHex) {
  const font = "600 30px system-ui, sans-serif";
  const measure = doc.createElement("canvas").getContext("2d");
  measure.font = font;
  const w = Math.ceil(measure.measureText(text).width) + 28;
  const h = 44;
  const canvas = doc.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d");
  g.font = font;
  g.textBaseline = "middle";
  g.shadowColor = "rgba(0,0,0,0.9)";
  g.shadowBlur = 6;
  g.fillStyle = colorHex;
  g.fillText(text, 14, h / 2);
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  const scale = 0.028;
  sprite.scale.set(w * scale, h * scale, 1);
  return sprite;
}

// --- the scene ----------------------------------------------------------------
//
// Audio note: the wave-landing pulse is played by src/render/audio.js, which
// listens for the "graph:wave" bus event emitted below and honors the HUD
// mute button; this scene keeps no audio of its own.

export function createGraphScene(ctx = {}) {
  const {
    state = {},
    bus,
    container,
    config = defaultConfig,
    renderer: givenRenderer = null,
    camera: givenCamera = null,
  } = ctx;
  const report = ctx.report ?? state.latestReport ?? null;
  const graph = report?.graph ?? { nodes: [], edges: [] };
  const gcfg = config.graph ?? defaultConfig.graph;
  const doc = container?.ownerDocument ?? globalThis.document;
  const win = doc?.defaultView ?? globalThis;

  // Layout + playback schedule.
  const layout = computeGraphLayout(graph);
  const schedule = buildPlaybackSchedule(layout.timeline, {
    nodeWaveSeconds: gcfg.NODE_WAVE_SECONDS,
    edgeDrawSeconds: gcfg.EDGE_DRAW_SECONDS,
  });

  // Renderer / camera (owned unless supplied).
  const ownRenderer = !givenRenderer;
  const renderer =
    givenRenderer ??
    new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
  const width = container?.clientWidth || 800;
  const height = container?.clientHeight || 600;
  if (ownRenderer) {
    renderer.setPixelRatio(Math.min(win.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    container?.appendChild(renderer.domElement);
  }
  const camera =
    givenCamera ?? new THREE.PerspectiveCamera(config.camera?.fov ?? 50, width / height, 0.1, 500);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05040d);

  // Furthest node radius sizes the starfield and the camera pull-back.
  let graphRadius = 8;
  for (const p of layout.positions.values()) {
    graphRadius = Math.max(graphRadius, Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z));
  }

  // Subtle starfield backdrop.
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(starfieldPositions(900, graphRadius * 3, graphRadius * 8, 42), 3),
  );
  const starMat = new THREE.PointsMaterial({
    color: 0x8fa3d8,
    size: 0.7,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });
  scene.add(new THREE.Points(starGeo, starMat));

  const glowTexture = makeGlowTexture(doc);
  const ringTexture = makeRingTexture(doc);
  const palettes = keeperPaletteMap(state, report);
  const labeledIds = new Set(pickLabeledNodeIds(graph.nodes, gcfg.MAX_LABELS ?? 24));

  // Nodes: additive glow sprites, one material each so hover can dim per-node.
  const nodeEntries = new Map(); // id -> entry
  const nodeGroup = new THREE.Group();
  scene.add(nodeGroup);
  for (const node of graph.nodes ?? []) {
    const pos = layout.positions.get(node.id);
    if (!pos) continue;
    const colorHex = nodeColorHex(node, palettes);
    const material = new THREE.SpriteMaterial({
      map: glowTexture,
      color: new THREE.Color(colorHex),
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.position.set(pos.x, pos.y, pos.z);
    sprite.scale.set(0.001, 0.001, 1);
    sprite.userData.nodeId = node.id;
    nodeGroup.add(sprite);

    let label = null;
    if (labeledIds.has(node.id) && node.label) {
      label = makeLabelSprite(doc, node.label, mixHex(colorHex, "#ffffff", 0.55));
      const size = nodeScale(node);
      label.position.set(pos.x, pos.y + size * 0.62 + 0.5, pos.z);
      scene.add(label);
    }

    nodeEntries.set(node.id, {
      node,
      sprite,
      material,
      label,
      size: nodeScale(node),
      baseOpacity: node.kind === "keeper" ? 0.95 : 0.8,
      progress: 0,
      neighbors: new Set(),
    });
  }

  // Edges: line that grows from source to target plus a bright travelling head.
  const edgeEntries = new Map(); // edgeId -> entry
  const segments = 24;
  (graph.edges ?? []).forEach((edge, i) => {
    const a = layout.positions.get(edge.source);
    const b = layout.positions.get(edge.target);
    if (!a || !b) return;
    const id = edgeId(edge, i);
    const points = edgeCurvePoints(a, b, segments);
    const array = new Float32Array(points.length * 3);
    points.forEach((p, j) => {
      array[j * 3] = p.x;
      array[j * 3 + 1] = p.y;
      array[j * 3 + 2] = p.z;
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(array, 3));
    geometry.setDrawRange(0, 0);
    const srcColor = nodeColorHex(
      nodeEntries.get(edge.source)?.node ?? { kind: "entity" },
      palettes,
    );
    const dstColor = nodeColorHex(
      nodeEntries.get(edge.target)?.node ?? { kind: "entity" },
      palettes,
    );
    const material = new THREE.LineBasicMaterial({
      color: new THREE.Color(mixHex(mixHex(srcColor, dstColor, 0.5), "#ffffff", 0.1)),
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const line = new THREE.Line(geometry, material);
    scene.add(line);

    const headMaterial = new THREE.SpriteMaterial({
      map: glowTexture,
      color: 0xffffff,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const head = new THREE.Sprite(headMaterial);
    head.scale.set(1.1, 1.1, 1);
    scene.add(head);

    const baseOpacity = 0.28 + 0.1 * Math.min(edge.weight ?? 1, 4);
    edgeEntries.set(id, { edge, points, geometry, material, line, head, headMaterial, baseOpacity, progress: 0 });

    nodeEntries.get(edge.source)?.neighbors.add(edge.target);
    nodeEntries.get(edge.target)?.neighbors.add(edge.source);
  });

  // Pulse rings (one per wave landing, recycled).
  const rings = [];
  function spawnRing(center, colorHex) {
    const material = new THREE.SpriteMaterial({
      map: ringTexture,
      color: new THREE.Color(colorHex),
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.position.copy(center);
    sprite.scale.set(0.5, 0.5, 1);
    scene.add(sprite);
    rings.push({ sprite, material, age: 0 });
  }

  function waveCenter(wave) {
    const v = new THREE.Vector3();
    let count = 0;
    for (const id of wave.nodeIds ?? []) {
      const e = nodeEntries.get(id);
      if (e) {
        v.add(e.sprite.position);
        count++;
      }
    }
    for (const id of wave.edgeIds ?? []) {
      const e = edgeEntries.get(id);
      if (e) {
        const mid = e.points[Math.floor(e.points.length / 2)];
        v.add(new THREE.Vector3(mid.x, mid.y, mid.z));
        count++;
      }
    }
    return count ? v.divideScalar(count) : v;
  }

  // HUD overlay (narrative + progress + Skip/Back). Mounted on the #ui root.
  const hudRoot = doc?.getElementById?.("ui") ?? container ?? null;
  const hud = bus && hudRoot ? createGraphHud({ root: hudRoot, bus, report }) : null;

  // --- playback state ---
  let time = 0;
  let settled = false;
  let lastEmittedProgress = -1;
  let controls = null;
  let hoveredId = null;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const landed = new Set();

  // Camera rig: slow orbit while the movie plays, easing out to fit the graph.
  const camStartRadius = Math.max(14, graphRadius * 1.15);
  const camEndRadius = graphRadius * 2.3 + 8;
  const camPhi = 1.12; // polar angle, slightly above the plane
  const camTheta0 = 0.6;
  function placeCamera(playT, elapsed) {
    const radius = camStartRadius + (camEndRadius - camStartRadius) * easeInOutCubic(playT);
    const theta = camTheta0 + elapsed * (gcfg.ORBIT_SPEED ?? 0.05);
    camera.position.set(
      radius * Math.sin(camPhi) * Math.cos(theta),
      radius * Math.cos(camPhi),
      radius * Math.sin(camPhi) * Math.sin(theta),
    );
    camera.lookAt(0, 0, 0);
  }
  placeCamera(0, 0);

  function applyWaveVisuals(silent) {
    schedule.waves.forEach((wave, wi) => {
      const wp =
        wave.duration > 0 ? Math.min(1, Math.max(0, (time - wave.start) / wave.duration)) : 1;
      if (wp > 0 && !landed.has(wi)) {
        landed.add(wi);
        if (!silent) {
          const first =
            nodeEntries.get(wave.nodeIds?.[0]) ??
            (wave.edgeIds ? edgeEntries.get(wave.edgeIds[0]) : null);
          const colorHex = first?.node ? nodeColorHex(first.node, palettes) : "#cfd8ff";
          spawnRing(waveCenter(wave), colorHex);
          bus?.emit("graph:wave", { index: wi, t: wave.t });
        }
      }
      if (wave.nodeIds) {
        wave.nodeIds.forEach((id, i) => {
          const entry = nodeEntries.get(id);
          if (entry) entry.progress = staggeredProgress(wp, i, wave.nodeIds.length);
        });
      }
      if (wave.edgeIds) {
        wave.edgeIds.forEach((id, i) => {
          const entry = edgeEntries.get(id);
          if (entry) entry.progress = staggeredProgress(wp, i, wave.edgeIds.length, 0.4);
        });
      }
    });
  }

  function updateNodeVisuals() {
    const highlightSet = hoveredId ? nodeEntries.get(hoveredId)?.neighbors : null;
    for (const entry of nodeEntries.values()) {
      const appear = easeOutBack(entry.progress);
      const s = Math.max(0.001, entry.size * appear);
      entry.sprite.scale.set(s, s, 1);
      let target = entry.baseOpacity * Math.min(1, entry.progress * 1.5);
      if (hoveredId) {
        const lit = entry.node.id === hoveredId || highlightSet?.has(entry.node.id);
        target = lit ? 1 : 0.12;
      }
      entry.material.opacity += (target - entry.material.opacity) * 0.25;
      if (entry.label) {
        const labelTarget =
          entry.progress >= 1 ? (hoveredId && entry.node.id !== hoveredId && !highlightSet?.has(entry.node.id) ? 0.15 : 0.95) : 0;
        entry.label.material.opacity += (labelTarget - entry.label.material.opacity) * 0.15;
      }
    }
    for (const entry of edgeEntries.values()) {
      const p = entry.progress;
      const visible = Math.max(0, Math.floor(p * segments) + (p > 0 ? 1 : 0));
      entry.geometry.setDrawRange(0, Math.min(visible, segments + 1));
      let target = p > 0 ? entry.baseOpacity : 0;
      if (hoveredId) {
        const touches = entry.edge.source === hoveredId || entry.edge.target === hoveredId;
        target = touches ? 0.9 : 0.05;
      }
      entry.material.opacity += (target - entry.material.opacity) * 0.25;

      // Travelling bright head while the edge is drawing.
      if (p > 0 && p < 1) {
        const pt = entry.points[Math.min(entry.points.length - 1, Math.floor(p * segments))];
        entry.head.position.set(pt.x, pt.y, pt.z);
        entry.headMaterial.opacity = 0.9;
      } else {
        entry.headMaterial.opacity = Math.max(0, entry.headMaterial.opacity - 0.06);
      }
    }
  }

  function updateRings(dt) {
    for (let i = rings.length - 1; i >= 0; i--) {
      const ring = rings[i];
      ring.age += dt;
      const life = 0.7;
      const k = ring.age / life;
      if (k >= 1) {
        scene.remove(ring.sprite);
        ring.material.dispose();
        rings.splice(i, 1);
        continue;
      }
      const s = 0.5 + easeInOutCubic(k) * 6;
      ring.sprite.scale.set(s, s, 1);
      ring.material.opacity = 0.8 * (1 - k);
    }
  }

  function settle() {
    if (settled) return;
    settled = true;
    if (ownRenderer || givenRenderer?.domElement) {
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.autoRotate = true;
      controls.autoRotateSpeed = (gcfg.ORBIT_SPEED ?? 0.05) * 12;
      controls.minDistance = 4;
      controls.maxDistance = camEndRadius * 2.5;
      controls.target.set(0, 0, 0);
    }
    bus?.emit("graph:settled", { report });
  }

  function skipToSettled() {
    time = schedule.total;
    applyWaveVisuals(true); // no pulses when fast-forwarding
    for (const entry of nodeEntries.values()) entry.progress = 1;
    for (const entry of edgeEntries.values()) entry.progress = 1;
    updateNodeVisuals();
    placeCamera(1, time);
    bus?.emit("graph:progress", { t: 1, settled: true });
    settle();
  }

  // --- interaction ---
  function onPointerMove(event) {
    if (!settled) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(nodeGroup.children, false);
    hoveredId = hits.length ? hits[0].object.userData.nodeId : null;
  }
  renderer.domElement?.addEventListener?.("pointermove", onPointerMove);

  function onResize() {
    if (!ownRenderer || !container) return;
    const w = container.clientWidth || width;
    const h = container.clientHeight || height;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  win.addEventListener?.("resize", onResize);

  const unsubs = [];
  if (bus) {
    unsubs.push(bus.on("graph:skip", skipToSettled));
    unsubs.push(bus.on("graph:back", () => bus.emit("mode:set", "overworld")));
  }

  // --- per-frame update, driven by main.js ---
  function update(dt) {
    if (!settled) {
      time += dt;
      applyWaveVisuals(false);
      const playT = schedule.total > 0 ? Math.min(1, time / schedule.total) : 1;
      placeCamera(playT, time);
      if (Math.abs(playT - lastEmittedProgress) >= 0.01 || playT === 1) {
        lastEmittedProgress = playT;
        bus?.emit("graph:progress", { t: playT, settled: playT >= 1 });
      }
      if (time >= schedule.total) settle();
    } else {
      controls?.update();
    }
    updateNodeVisuals();
    updateRings(dt);
    renderer.render(scene, camera);
  }

  function dispose() {
    for (const off of unsubs) off?.();
    win.removeEventListener?.("resize", onResize);
    renderer.domElement?.removeEventListener?.("pointermove", onPointerMove);
    controls?.dispose();
    hud?.dispose();

    for (const entry of nodeEntries.values()) {
      entry.material.dispose();
      if (entry.label) {
        entry.label.material.map?.dispose();
        entry.label.material.dispose();
      }
    }
    for (const entry of edgeEntries.values()) {
      entry.geometry.dispose();
      entry.material.dispose();
      entry.headMaterial.dispose();
    }
    for (const ring of rings) ring.material.dispose();
    starGeo.dispose();
    starMat.dispose();
    glowTexture.dispose();
    ringTexture.dispose();

    if (ownRenderer) {
      renderer.dispose();
      renderer.domElement?.remove?.();
    }
  }

  return { scene, camera, update, dispose, skip: skipToSettled, get settled() { return settled; } };
}
