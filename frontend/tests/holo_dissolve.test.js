// Disintegration shell tests (no WebGL: sampling and budget math only).
// The shell must sample only what is visible, hold its point budget, and
// come off the hologram cleanly on dispose, or a monument rebuild leaks
// geometry every time the population changes.
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createHoloDissolve, sampleSurfacePoints } from "../src/render/holo_dissolve.js";

function holoLikeGroup() {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12));
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.1, 0.1));
  visor.visible = false;
  group.add(body, visor);
  return { group, body, visor };
}

describe("createHoloDissolve", () => {
  it("fills the whole budget from visible surfaces, none from hidden ones", () => {
    const { group, visor } = holoLikeGroup();
    // far more points than the geometry has vertices: surface sampling fills it
    const shell = createHoloDissolve({ source: group, maxPoints: 5000 });
    expect(shell.object.isPoints).toBe(true);
    expect(shell.object.parent).toBe(group);
    expect(shell.count).toBe(5000);
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

describe("sampleSurfacePoints", () => {
  it("spreads the budget by area and lands points on the surface", () => {
    // two squares, one 100x the area of the other: it gets ~all the points
    const big = new THREE.Mesh(new THREE.PlaneGeometry(10, 10));
    const small = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
    small.position.set(30, 0, 0);
    const group = new THREE.Group();
    group.add(big, small);
    const points = sampleSurfacePoints(group, 800);
    expect(points).toHaveLength(800);
    const onSmall = points.filter((p) => p.position.x > 20).length;
    expect(onSmall).toBeGreaterThan(0);
    expect(onSmall).toBeLessThan(80);
    // every point lies on one of the two planes (both at z = 0)
    expect(points.every((p) => Math.abs(p.position.z) < 1e-6)).toBe(true);
  });

  it("tints glowing surfaces near-white and grades the rest dark", () => {
    const body = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ color: 0xffffff }));
    const eye = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ color: 0x3fe0ff }));
    eye.material.emissive = new THREE.Color(0x3fe0ff);
    eye.material.emissiveIntensity = 0.85;
    eye.position.set(10, 0, 0);
    const group = new THREE.Group();
    group.add(body, eye);
    const grade = new THREE.Color(0.2, 0.4, 0.6);
    const points = sampleSurfacePoints(group, 400, grade);
    const luma = (t) => t.r + t.g + t.b;
    const bodyTint = points.find((p) => p.position.x < 5).tint;
    const eyeTint = points.find((p) => p.position.x > 5).tint;
    expect(luma(eyeTint)).toBeGreaterThan(luma(bodyTint) + 0.5);
    expect(bodyTint.r).toBeCloseTo(0.2);
  });

  it("is deterministic and empty for an empty group", () => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6));
    const g1 = new THREE.Group();
    g1.add(mesh);
    const first = sampleSurfacePoints(g1, 50);
    const second = sampleSurfacePoints(g1, 50);
    expect(first.map((p) => p.position.toArray()))
      .toEqual(second.map((p) => p.position.toArray()));
    expect(sampleSurfacePoints(new THREE.Group(), 50)).toEqual([]);
  });
});
