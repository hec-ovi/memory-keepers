// Game camera: orbit + pan + zoom around a ground target, optional follow,
// and pointer picking. Following stops the moment the player takes over.
import * as THREE from "three";

export class GameCamera {
  constructor(canvas) {
    this.camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 500);
    this.target = new THREE.Vector3(0, 0, 14);
    this.distance = 34;
    this.yaw = -Math.PI / 2;
    this.pitch = 0.86;
    this.followed = null;
    this._ray = new THREE.Raycaster();
    this._bindings(canvas);
    this.update(0);
  }

  follow(object3d) { this.followed = object3d; }
  release() { this.followed = null; }

  _bindings(canvas) {
    let dragging = null, lastX = 0, lastY = 0;
    canvas.addEventListener("pointerdown", (e) => {
      dragging = e.button === 2 || e.shiftKey ? "orbit" : "pan";
      lastX = e.clientX; lastY = e.clientY;
    });
    addEventListener("pointerup", () => (dragging = null));
    addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      if (dragging === "orbit") {
        this.yaw -= dx * 0.005;
        this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.004, 0.25, 1.35);
      } else {
        this.release();
        const s = this.distance * 0.0016;
        const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
        this.target.x -= (dx * -sin + dy * cos) * s * -1;
        this.target.z -= (dx * cos + dy * sin) * s;
      }
    });
    canvas.addEventListener("wheel", (e) => {
      this.distance = THREE.MathUtils.clamp(this.distance * (1 + e.deltaY * 0.001), 10, 90);
    }, { passive: true });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  update(dt) {
    if (this.followed) {
      this.target.lerp(new THREE.Vector3(
        this.followed.position.x, 0, this.followed.position.z), Math.min(1, dt * 4));
    }
    const y = Math.sin(this.pitch) * this.distance;
    const r = Math.cos(this.pitch) * this.distance;
    this.camera.position.set(
      this.target.x + Math.cos(this.yaw) * r, y, this.target.z + Math.sin(this.yaw) * r);
    this.camera.lookAt(this.target.x, 1.5, this.target.z);
  }

  pick(event, objects, camera = this.camera) {
    const ndc = new THREE.Vector2(
      (event.clientX / innerWidth) * 2 - 1, -(event.clientY / innerHeight) * 2 + 1);
    this._ray.setFromCamera(ndc, camera);
    const hits = this._ray.intersectObjects(objects, true);
    for (const hit of hits) {
      let node = hit.object;
      while (node) {
        if (node.userData.pickable) return node.userData;
        node = node.parent;
      }
    }
    return null;
  }

  project(x, y, z) {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    return { x: (v.x + 1) / 2 * innerWidth, y: (1 - v.y) / 2 * innerHeight, behind: v.z > 1 };
  }
}
