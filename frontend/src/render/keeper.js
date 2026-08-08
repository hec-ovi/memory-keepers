// The keeper avatar: a soft blob with eyes, her palette as the skin,
// a night variant for dark keepers, and a squash-and-stretch walk bob.
import * as THREE from "three";

export class KeeperAvatar {
  constructor(keeper) {
    this.keeper = keeper;
    this.group = new THREE.Group();
    const primary = new THREE.Color(keeper.palette?.primary || "#7c6cf0");
    const accent = new THREE.Color(keeper.palette?.accent || "#2e2560");
    const dark = keeper.side === "dark";

    const bodyGeo = new THREE.SphereGeometry(0.62, 24, 20);
    bodyGeo.scale(1, 1.18, 1);
    this.body = new THREE.Mesh(bodyGeo, new THREE.MeshStandardMaterial({
      color: dark ? primary.clone().multiplyScalar(0.55) : primary,
      roughness: 0.55,
      emissive: dark ? accent : 0x000000,
      emissiveIntensity: dark ? 0.55 : 0,
    }));
    this.body.position.y = 0.72;
    this.body.castShadow = true;

    const eyeWhite = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
    const pupilMat = new THREE.MeshStandardMaterial({
      color: dark ? 0x57e6ff : 0x241a10, roughness: 0.2,
      emissive: dark ? 0x57e6ff : 0x000000, emissiveIntensity: dark ? 0.8 : 0 });
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), eyeWhite);
      eye.position.set(side * 0.2, 0.95, 0.5);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), pupilMat);
      pupil.position.set(side * 0.2, 0.95, 0.59);
      this.group.add(eye, pupil);
    }
    const brim = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.07, 8, 18),
      new THREE.MeshStandardMaterial({ color: accent, roughness: 0.6 }));
    brim.rotation.x = Math.PI / 2;
    brim.position.y = 1.28;
    this.group.add(this.body, brim);
    this.group.userData = { pickable: true, kind: "keeper", keeperId: keeper.id };
  }

  place(x, z, heading = 0) {
    this.group.position.set(x, 0, z);
    this.group.rotation.y = -heading + Math.PI / 2;
  }

  bob(t, moving) {
    const s = moving ? 1 + Math.sin(t * 9) * 0.06 : 1 + Math.sin(t * 2.2) * 0.02;
    this.body.scale.set(1 / Math.sqrt(s), s, 1 / Math.sqrt(s));
  }
}
