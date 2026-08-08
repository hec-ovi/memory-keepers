// The island: irregular terrain with soft texture blends, water, organic
// paths, plaza and monument, dark-side spire, scattered trees.
import * as THREE from "three";
import { islandRadiusAt, PLAZA, DARK_HEART } from "../sim/plots.js";
import { hashSeed, mulberry32 } from "../sim/rng.js";

const GRASS = new THREE.Color(0x679a52);
const GRASS_DARK = new THREE.Color(0x3c3060);
const SAND = new THREE.Color(0xd9c489);
const DIRT = new THREE.Color(0xb99c6b);

export function buildIsland(scene, layout) {
  const group = new THREE.Group();

  // Terrain: radial mesh shaped by the shore function, vertex-color blends.
  const rng = mulberry32(hashSeed("terrain"));
  const geo = new THREE.CircleGeometry(1, 168, 0, Math.PI * 2);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = [];
  const bumps = [];
  for (let i = 0; i < 10; i++) {
    bumps.push({ x: (rng() - 0.5) * 70, z: (rng() - 0.5) * 70, r: 8 + rng() * 14, h: 0.6 + rng() * 1.7 });
  }
  for (let i = 0; i < pos.count; i++) {
    const x0 = pos.getX(i), z0 = pos.getZ(i);
    const angle = Math.atan2(z0, x0);
    const shore = islandRadiusAt(angle);
    const x = x0 * shore, z = z0 * shore;
    const edge = Math.hypot(x0, z0);            // 0 center, 1 shore
    let y = Math.max(0, (1 - edge)) * 1.2;
    for (const b of bumps) {
      const d = Math.hypot(x - b.x, z - b.z);
      if (d < b.r) y += Math.cos((d / b.r) * Math.PI * 0.5) * b.h * (1 - edge * 0.9);
    }
    if (edge > 0.985) y = -1.4;                  // dip under water at the rim
    pos.setXYZ(i, x, y, z);

    const darkness = THREE.MathUtils.clamp((6 - z) / 26, 0, 1);
    const color = GRASS.clone().lerp(GRASS_DARK, darkness);
    const sandiness = THREE.MathUtils.smoothstep(edge, 0.86, 0.97);
    color.lerp(SAND, sandiness);
    colors.push(color.r, color.g, color.b);
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.95, metalness: 0 }));
  terrain.receiveShadow = true;
  terrain.userData.ground = true;
  group.add(terrain);

  // Water: gently animated plane around everything.
  const waterGeo = new THREE.PlaneGeometry(340, 340, 48, 48);
  waterGeo.rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(waterGeo, new THREE.MeshStandardMaterial({
    color: 0x2a6f9e, transparent: true, opacity: 0.92,
    roughness: 0.25, metalness: 0.35 }));
  water.position.y = -0.55;
  group.add(water);
  const waterBase = waterGeo.attributes.position.array.slice();
  function waterUpdate(t) {
    const arr = waterGeo.attributes.position.array;
    for (let i = 0; i < arr.length; i += 3) {
      arr[i + 1] = waterBase[i + 1] +
        Math.sin(t * 1.1 + waterBase[i] * 0.25) * 0.12 +
        Math.cos(t * 0.7 + waterBase[i + 2] * 0.21) * 0.1;
    }
    waterGeo.attributes.position.needsUpdate = true;
    waterGeo.computeVertexNormals();
  }

  // Paths: flat ribbons along network edges, sandy color.
  const pathMat = new THREE.MeshStandardMaterial({ color: DIRT, roughness: 1 });
  const { nodes, edges } = layout.network;
  for (const [a, b] of edges) {
    const pa = nodes[a], pb = nodes[b];
    const length = Math.hypot(pb.x - pa.x, pb.z - pa.z);
    const ribbon = new THREE.Mesh(new THREE.PlaneGeometry(length, 1.5), pathMat);
    ribbon.rotateX(-Math.PI / 2);
    ribbon.position.set((pa.x + pb.x) / 2, 0.06, (pa.z + pb.z) / 2);
    ribbon.rotateZ(-Math.atan2(pb.z - pa.z, pb.x - pa.x));
    group.add(ribbon);
  }
  for (const [center, radius, color] of [[PLAZA, 6.5, DIRT], [DARK_HEART, 5, 0x2c2350]]) {
    const disc = new THREE.Mesh(new THREE.CircleGeometry(radius, 40),
      new THREE.MeshStandardMaterial({ color, roughness: 1 }));
    disc.rotateX(-Math.PI / 2);
    disc.position.set(center.x, 0.07, center.z);
    group.add(disc);
  }

  // Monument: the root agent's body at the plaza.
  const monument = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.6, 1, 8),
    new THREE.MeshStandardMaterial({ color: 0x8d8a99, roughness: 0.8 }));
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.1, 5.2, 6),
    new THREE.MeshStandardMaterial({ color: 0xa5a2b8, roughness: 0.6 }));
  pillar.position.y = 3;
  const eye = new THREE.Mesh(new THREE.OctahedronGeometry(0.9),
    new THREE.MeshStandardMaterial({ color: 0x57e6ff, emissive: 0x57e6ff,
      emissiveIntensity: 0.9, roughness: 0.2 }));
  eye.position.y = 6.4;
  monument.add(base, pillar, eye);
  monument.position.set(PLAZA.x, 0.4, PLAZA.z);
  monument.traverse((o) => { o.castShadow = true; });
  monument.userData = { pickable: true, kind: "monument" };
  group.add(monument);
  const monumentGlow = new THREE.PointLight(0x57e6ff, 1.4, 16);
  monumentGlow.position.set(PLAZA.x, 6.4, PLAZA.z);
  group.add(monumentGlow);

  // Dark heart spire.
  const spire = new THREE.Mesh(new THREE.ConeGeometry(1.4, 7, 5),
    new THREE.MeshStandardMaterial({ color: 0x151026, roughness: 0.3,
      emissive: 0x3a2a7a, emissiveIntensity: 0.5 }));
  spire.position.set(DARK_HEART.x, 3.5, DARK_HEART.z);
  group.add(spire);

  // Trees: dense small trees, green in the day zone, violet at night.
  const treeRng = mulberry32(hashSeed("trees"));
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2e, roughness: 1 });
  for (let i = 0; i < 220; i++) {
    const angle = treeRng() * Math.PI * 2;
    const rr = Math.sqrt(treeRng()) * 0.92;
    const shore = islandRadiusAt(angle);
    const x = Math.cos(angle) * rr * shore, z = Math.sin(angle) * rr * shore;
    if (nearAny(x, z, layout.plots, 5) || nearAny(x, z, [PLAZA, DARK_HEART], 9)) continue;
    if (nearPath(x, z, nodes, edges, 2.2)) continue;
    const dark = z < -6;
    const scale = 0.7 + treeRng() * 0.9;
    const tree = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, 1, 5), trunkMat);
    trunk.position.y = 0.5;
    const crown = new THREE.Mesh(
      treeRng() > 0.5 ? new THREE.ConeGeometry(0.9, 1.9, 7) : new THREE.SphereGeometry(0.85, 7, 6),
      new THREE.MeshStandardMaterial({
        color: dark ? 0x4a3a86 : (treeRng() > 0.5 ? 0x4c8a3f : 0x5f9c46), roughness: 1 }));
    crown.position.y = 1.8;
    crown.castShadow = true;
    tree.add(trunk, crown);
    tree.position.set(x, 0.1, z);
    tree.scale.setScalar(scale);
    group.add(tree);
  }

  scene.add(group);
  return { group, waterUpdate, terrain };
}

function nearAny(x, z, points, r) {
  return points.some((p) => Math.hypot(x - p.x, z - p.z) < r);
}

function nearPath(x, z, nodes, edges, r) {
  for (const [a, b] of edges) {
    const pa = nodes[a], pb = nodes[b];
    const t = THREE.MathUtils.clamp(
      ((x - pa.x) * (pb.x - pa.x) + (z - pa.z) * (pb.z - pa.z)) /
      ((pb.x - pa.x) ** 2 + (pb.z - pa.z) ** 2 || 1), 0, 1);
    if (Math.hypot(x - (pa.x + (pb.x - pa.x) * t), z - (pa.z + (pb.z - pa.z) * t)) < r) return true;
  }
  return false;
}
