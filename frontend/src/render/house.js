// Houses: one model, seeded variation, keeper palette on the trim.
// Empty plots show a VACANT signpost readable from both sides.
import * as THREE from "three";
import { hashSeed, mulberry32 } from "../sim/rng.js";

export function buildHouse(plot, palette) {
  const rng = mulberry32(hashSeed("house" + plot.id));
  const group = new THREE.Group();
  const dark = plot.side === "dark";
  const wallColor = dark ? 0x2c2447 : 0xe8dcc2;
  const roofColor = new THREE.Color(palette?.primary || (dark ? 0x4a3a86 : 0xb0563a));

  const base = new THREE.Mesh(new THREE.BoxGeometry(3.4, 2.2, 3),
    new THREE.MeshStandardMaterial({ color: wallColor, roughness: 0.9 }));
  base.position.y = 1.1;
  const roof = new THREE.Mesh(new THREE.ConeGeometry(2.9, 1.9, 4),
    new THREE.MeshStandardMaterial({ color: roofColor, roughness: 0.8 }));
  roof.position.y = 3.1;
  roof.rotation.y = Math.PI / 4;
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.3, 0.1),
    new THREE.MeshStandardMaterial({ color: palette?.accent || 0x5a4632 }));
  door.position.set(0, 0.65, 1.53);
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1, 0.4),
    new THREE.MeshStandardMaterial({ color: 0x8d8a99 }));
  chimney.position.set(0.9, 3.2, -0.5);
  group.add(base, roof, door, chimney);

  if (dark) {
    const glow = new THREE.PointLight(new THREE.Color(palette?.primary || 0x7c6cf0), 0.8, 8);
    glow.position.set(0, 1.6, 1.8);
    group.add(glow);
  }
  // tiny garden: a few stones by the door
  for (let i = 0; i < 4; i++) {
    const stone = new THREE.Mesh(new THREE.SphereGeometry(0.14 + rng() * 0.1, 5, 4),
      new THREE.MeshStandardMaterial({ color: 0x9a917f, roughness: 1 }));
    stone.position.set(-1 + rng() * 2, 0.08, 1.8 + rng() * 0.8);
    group.add(stone);
  }

  group.position.set(plot.x, 0.05, plot.z);
  group.rotation.y = -plot.angle + Math.PI / 2;
  group.scale.setScalar(0.92 + rng() * 0.18);
  group.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
  group.userData = { pickable: true, kind: "house", plotId: plot.id };
  return group;
}

export function buildVacantSign(plot) {
  const group = new THREE.Group();
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 1.4, 6),
    new THREE.MeshStandardMaterial({ color: 0x6b4a2e }));
  post.position.y = 0.7;
  group.add(post);

  const canvas = document.createElement("canvas");
  canvas.width = 128; canvas.height = 48;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#caa96a"; ctx.fillRect(0, 0, 128, 48);
  ctx.strokeStyle = "#7a5c30"; ctx.lineWidth = 5; ctx.strokeRect(3, 3, 122, 42);
  ctx.fillStyle = "#3a2c12"; ctx.font = "bold 22px sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("VACANT", 64, 26);
  const texture = new THREE.CanvasTexture(canvas);
  const board = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.6, 0.06),
    new THREE.MeshStandardMaterial({ map: texture }));
  const back = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.6, 0.06),
    new THREE.MeshStandardMaterial({ map: texture }));
  board.position.set(0, 1.25, 0.035);
  back.position.set(0, 1.25, -0.035);
  back.rotation.y = Math.PI;
  group.add(board, back);
  group.position.set(plot.x, 0.05, plot.z);
  group.rotation.y = -plot.angle + Math.PI / 2;
  group.userData = { pickable: true, kind: "vacant", plotId: plot.id };
  return group;
}
