// Renderer, lights and the spatial day/night blend: the village is always day,
// the dark side always night, and lighting follows the camera across.
import * as THREE from "three";

const DAY = { sky: 0x8ec9e8, fog: 0xa8d4e8, hemi: 0xfff2d8, ground: 0x6a7f5a, sun: 1.15 };
const NIGHT = { sky: 0x0b0820, fog: 0x181233, hemi: 0x4a3f7a, ground: 0x201a38, sun: 0.25 };

export class WorldScene {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(DAY.fog, 60, 190);

    this.hemi = new THREE.HemisphereLight(DAY.hemi, DAY.ground, 0.9);
    this.sun = new THREE.DirectionalLight(0xfff1cf, DAY.sun);
    this.sun.position.set(35, 60, 25);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70 });
    this.moon = new THREE.PointLight(0x7c6cf0, 0, 90);
    this.moon.position.set(0, 24, -30);
    this.scene.add(this.hemi, this.sun, this.moon);

    this._skyA = new THREE.Color(); this._skyB = new THREE.Color();
    addEventListener("resize", () => this.resize());
    this.resize();
  }

  resize() {
    this.renderer.setSize(innerWidth, innerHeight);
    if (this.camera) {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
    }
  }

  blendZones(focusZ) {
    // t: 0 deep in the village, 1 deep in the dark side
    const t = THREE.MathUtils.clamp((6 - focusZ) / 24, 0, 1);
    this.scene.background = this._skyA.set(DAY.sky).lerp(this._skyB.set(NIGHT.sky), t);
    this.scene.fog.color.set(DAY.fog).lerp(this._skyB.set(NIGHT.fog), t);
    this.hemi.color.set(DAY.hemi).lerp(this._skyB.set(NIGHT.hemi), t);
    this.hemi.groundColor.set(DAY.ground).lerp(this._skyB.set(NIGHT.ground), t);
    this.sun.intensity = DAY.sun + (NIGHT.sun - DAY.sun) * t;
    this.moon.intensity = 2.2 * t;
  }

  render(camera) {
    this.camera = camera;
    this.renderer.render(this.scene, camera);
  }
}
