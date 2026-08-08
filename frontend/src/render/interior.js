// Inside a keeper's house: warm room, the keeper on her chair, and the
// 24-slot bookcase where the 3D books ARE the interface. The shelf view
// pans in 2D so every spine stays reachable on small screens.
import * as THREE from "three";
import { hashSeed, mulberry32 } from "../sim/rng.js";
import { KeeperAvatar } from "./keeper.js";

const SLOTS_PER_SHELF = 6;
const SHELVES = 4;
const TIER_HEIGHT = { small: 0.52, medium: 0.62, big: 0.72, large: 0.8 };
const TIER_WIDTH = { small: 0.14, medium: 0.18, big: 0.24, large: 0.3 };

export class InteriorScene {
  constructor(keeper) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(keeper.side === "dark" ? 0x120d24 : 0x2a2018);
    this.camera = new THREE.PerspectiveCamera(46, innerWidth / innerHeight, 0.05, 60);
    this.view = "room";
    this.panOffset = { x: 0, y: 0 };

    const warm = keeper.side === "dark" ? 0x8a7cd8 : 0xffc98a;
    const lamp = new THREE.PointLight(warm, 2.4, 22);
    lamp.position.set(0, 3.4, 1.5);
    this.scene.add(lamp, new THREE.AmbientLight(warm, 0.4));

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 8),
      new THREE.MeshStandardMaterial({ color: 0x6e5238, roughness: 1 }));
    floor.rotateX(-Math.PI / 2);
    const wallMat = new THREE.MeshStandardMaterial({
      color: keeper.side === "dark" ? 0x241b45 : 0xcbb794, roughness: 1 });
    for (const [w, h, x, y, z, ry] of [
      [10, 4.4, 0, 2.2, -4, 0], [8, 4.4, -5, 2.2, 0, Math.PI / 2],
      [8, 4.4, 5, 2.2, 0, -Math.PI / 2]]) {
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat);
      wall.position.set(x, y, z);
      wall.rotation.y = ry;
      this.scene.add(wall);
    }
    this.scene.add(floor);

    // Bookcase against the back wall.
    this.case = new THREE.Group();
    this.scene.add(this.case);

    // keeper on her chair
    const chair = new THREE.Mesh(new THREE.BoxGeometry(1, 0.5, 1),
      new THREE.MeshStandardMaterial({ color: 0x7a5c38 }));
    chair.position.set(2.4, 0.25, 0.5);
    this.scene.add(chair);
    this.avatar = new KeeperAvatar(keeper);
    this.avatar.group.position.set(2.4, 0.5, 0.5);
    this.avatar.group.rotation.y = -0.6;
    this.scene.add(this.avatar.group);
    this.setView("room");
  }

  setBooks(books) {
    this.case.clear();
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 0.9 });
    const back = new THREE.Mesh(new THREE.BoxGeometry(4.6, 3.5, 0.12), frameMat);
    back.position.set(0, 1.95, -3.9);
    this.case.add(back);
    for (let s = 0; s <= SHELVES; s++) {
      const plank = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.07, 0.5), frameMat);
      plank.position.set(0, 0.5 + s * 0.86, -3.7);
      this.case.add(plank);
    }
    books.slice(0, SLOTS_PER_SHELF * SHELVES).forEach((book, i) => {
      const shelf = Math.floor(i / SLOTS_PER_SHELF);
      const slot = i % SLOTS_PER_SHELF;
      const rng = mulberry32(hashSeed(book.slug));
      const height = TIER_HEIGHT[book.tier] || 0.6;
      const width = TIER_WIDTH[book.tier] || 0.18;
      const spine = new THREE.Mesh(new THREE.BoxGeometry(width, height, 0.42),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color().setHSL(rng(), 0.45, book.source === "dream" ? 0.28 : 0.5),
          roughness: 0.7 }));
      spine.position.set(-2 + slot * 0.75 + rng() * 0.12,
        0.54 + shelf * 0.86 + height / 2, -3.68);
      spine.userData = { pickable: true, kind: "book", slug: book.slug, title: book.title };
      this.case.add(spine);
    });
  }

  setView(view) {
    this.view = view;
    this.panOffset = { x: 0, y: 0 };
    this._applyCamera();
  }

  pan(dx, dy) {
    if (this.view !== "shelf") return;
    this.panOffset.x = THREE.MathUtils.clamp(this.panOffset.x - dx * 0.004, -1.6, 1.6);
    this.panOffset.y = THREE.MathUtils.clamp(this.panOffset.y + dy * 0.004, -1, 1.2);
    this._applyCamera();
  }

  _applyCamera() {
    if (this.view === "shelf") {
      this.camera.position.set(this.panOffset.x, 1.9 + this.panOffset.y, -1.6);
      this.camera.lookAt(this.panOffset.x, 1.9 + this.panOffset.y, -3.9);
    } else {
      this.camera.position.set(0, 2.6, 3.6);
      this.camera.lookAt(0.6, 1.2, -2.5);
    }
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }

  tick(t) {
    this.avatar.bob(t, false);
  }
}
