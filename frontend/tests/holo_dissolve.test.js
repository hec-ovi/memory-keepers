// Disintegration shell tests (no WebGL: sampling and budget math only).
// The shell must sample only what is visible, hold its point budget, and
// come off the hologram cleanly on dispose, or a monument rebuild leaks
// geometry every time the population changes.
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createHoloDissolve, thinToUniformDensity } from "../src/render/holo_dissolve.js";

function holoLikeGroup() {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12));
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.1, 0.1));
  visor.visible = false;
  group.add(body, visor);
  return { group, body, visor };
}

describe("createHoloDissolve", () => {
  it("samples visible meshes into a points child, within the budget", () => {
    const { group, visor } = holoLikeGroup();
    const shell = createHoloDissolve({ source: group, maxPoints: 50 });
    expect(shell.object.isPoints).toBe(true);
    expect(shell.object.parent).toBe(group);
    expect(shell.count).toBeLessThanOrEqual(50);
    // the hidden visor contributes nothing
    const visorOnly = new THREE.Group();
    visorOnly.add(visor);
    expect(createHoloDissolve({ source: visorOnly })).toBeNull();
  });

  it("update advances time; dispose removes the shell from the hologram", () => {
    const { group } = holoLikeGroup();
    const shell = createHoloDissolve({ source: group, maxPoints: 20 });
    shell.update(0.5);
    expect(shell.object.material.uniforms.uTime.value).toBeCloseTo(0.5);
    shell.dispose();
    expect(shell.object.parent).toBeNull();
  });
});

describe("thinToUniformDensity", () => {
  it("keeps everything under budget, spreads a dense cluster over it", () => {
    const few = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1)];
    expect(thinToUniformDensity(few, 10)).toHaveLength(2);

    // 100 points in one corner cluster + 8 spread out: the spread survive.
    const points = [];
    for (let i = 0; i < 100; i += 1) {
      points.push(new THREE.Vector3(Math.random() * 0.01, 0, 0));
    }
    for (const x of [0, 1]) {
      for (const y of [0, 1]) {
        for (const z of [0, 1]) points.push(new THREE.Vector3(x * 9, y * 9, z * 9));
      }
    }
    const kept = thinToUniformDensity(points, 16);
    expect(kept).toHaveLength(16);
    const far = kept.filter((p) => p.length() > 5);
    expect(far.length).toBeGreaterThanOrEqual(7);
  });
});
