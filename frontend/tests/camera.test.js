// Camera rig: drag-mode state machine (pure), the cinematic chase solver
// (pure), plus rig behavior that needs no WebGL (OrbitControls +
// PerspectiveCamera are pure math over a DOM element).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as THREE from "three";
import {
  dragModeForPointer,
  createDragTracker,
  createCameraRig,
  createChaseSolver,
  chaseShot,
  CHASE_DEFAULTS,
  frameLerp,
  frameOffset,
  FOLLOW_FRAMING,
} from "../src/render/camera.js";
import { config } from "../src/config.js";

describe("dragModeForPointer", () => {
  it("left drag pans", () => {
    expect(dragModeForPointer({ button: 0 })).toBe("pan");
  });


  it("right drag orbits; middle pans like left", () => {
    expect(dragModeForPointer({ button: 1 })).toBe("pan");
    expect(dragModeForPointer({ button: 2 })).toBe("orbit");
  });

  it("a modifier key flips pan <-> orbit", () => {
    expect(dragModeForPointer({ button: 0, shiftKey: true })).toBe("orbit");
    expect(dragModeForPointer({ button: 2, ctrlKey: true })).toBe("pan");
    expect(dragModeForPointer({ button: 1, metaKey: true })).toBe("orbit");
  });

  it("defaults to a left-button pan", () => {
    expect(dragModeForPointer()).toBe("pan");
    expect(dragModeForPointer({})).toBe("pan");
  });
});

describe("createDragTracker (click vs drag)", () => {
  it("small movement + quick release = click", () => {
    const t = createDragTracker({ clickMoveMax: 6, clickHoldMaxMs: 450 });
    t.down({ x: 100, y: 100, time: 0, button: 0 });
    t.move({ x: 103, y: 102 });
    const up = t.up({ time: 120 });
    expect(up.click).toBe(true);
    expect(up.mode).toBe(null);
  });

  it("movement past the threshold = drag in the button's mode", () => {
    const t = createDragTracker({ clickMoveMax: 6 });
    expect(t.down({ x: 0, y: 0, time: 0, button: 0 })).toBe("pan");
    expect(t.move({ x: 3, y: 0 })).toBe(null); // still below threshold
    expect(t.move({ x: 10, y: 0 })).toBe("pan");
    expect(t.dragging).toBe(true);
    const up = t.up({ time: 100 });
    expect(up.click).toBe(false);
    expect(up.mode).toBe("pan");
  });

  it("right-button drags report orbit", () => {
    const t = createDragTracker();
    t.down({ x: 0, y: 0, time: 0, button: 2 });
    expect(t.move({ x: 20, y: 20 })).toBe("orbit");
    expect(t.up({ time: 80 }).mode).toBe("orbit");
  });

  it("holding too long is not a click even without movement", () => {
    const t = createDragTracker({ clickHoldMaxMs: 450 });
    t.down({ x: 5, y: 5, time: 0 });
    const up = t.up({ time: 900 });
    expect(up.click).toBe(false);
  });

  it("a drag stays a drag even if the pointer returns to the start", () => {
    const t = createDragTracker({ clickMoveMax: 6 });
    t.down({ x: 0, y: 0, time: 0 });
    t.move({ x: 30, y: 0 });
    t.move({ x: 0, y: 0 }); // back where it started
    const up = t.up({ time: 50 });
    expect(up.click).toBe(false);
    expect(up.moved).toBeGreaterThan(6);
  });

  it("cancel resets; up without down is inert", () => {
    const t = createDragTracker();
    t.down({ x: 0, y: 0, time: 0 });
    t.cancel();
    expect(t.mode).toBe(null);
    expect(t.up({ time: 10 })).toEqual({ click: false, mode: null, moved: 0 });
  });
});

describe("frameOffset (select-to-follow standard framing, pure)", () => {
  it("retargets the offset to the preset distance and pitch, azimuth preserved", () => {
    const off = frameOffset({ x: 3, y: 9, z: 4 }, { distance: 6, pitch: 0.5 });
    const d = Math.hypot(off.x, off.y, off.z);
    expect(d).toBeCloseTo(6, 6);
    expect(Math.asin(off.y / d)).toBeCloseTo(0.5, 6); // preset pitch
    expect(Math.atan2(off.x, off.z)).toBeCloseTo(Math.atan2(3, 4), 6); // same azimuth
  });

  it("ignores the current height when reading the azimuth", () => {
    const low = frameOffset({ x: 1, y: 0.2, z: 1 }, FOLLOW_FRAMING);
    const high = frameOffset({ x: 1, y: 40, z: 1 }, FOLLOW_FRAMING);
    expect(low).toEqual(high);
  });

  it("survives degenerate (vertical or garbage) offsets", () => {
    const top = frameOffset({ x: 0, y: 5, z: 0 }, { distance: 6, pitch: 0.5 });
    expect(Number.isFinite(top.x)).toBe(true);
    expect(Math.hypot(top.x, top.y, top.z)).toBeCloseTo(6, 6);
    const junk = frameOffset({}, { distance: 6, pitch: 0.5 });
    expect(Math.hypot(junk.x, junk.y, junk.z)).toBeCloseTo(6, 6);
  });

  it("FOLLOW_FRAMING is close enough to see her face, not super close", () => {
    expect(FOLLOW_FRAMING.distance).toBeGreaterThanOrEqual(5); // never macro
    expect(FOLLOW_FRAMING.distance).toBeLessThanOrEqual(12); // still close
    expect(FOLLOW_FRAMING.pitch).toBeGreaterThan(0.2); // above the horizon
    expect(FOLLOW_FRAMING.pitch).toBeLessThan(Math.PI / 4); // never top-down
  });
});

describe("chaseShot (pure cinematic frame)", () => {
  it("puts the camera behind-and-above the target relative to its heading", () => {
    const { position } = chaseShot({ x: 0, y: 1, z: 0 }, { x: 0, z: 1 });
    expect(position.z).toBeCloseTo(-CHASE_DEFAULTS.distance, 5); // behind = opposite the heading
    expect(position.x).toBeCloseTo(0, 5);
    expect(position.y).toBeCloseTo(1 + CHASE_DEFAULTS.height, 5); // above
  });

  it("is a low over-the-shoulder angle, not top-down", () => {
    const { position, lookAt } = chaseShot({ x: 0, y: 0, z: 0 }, { x: 1, z: 0 });
    const horizontal = Math.hypot(lookAt.x - position.x, lookAt.z - position.z);
    const vertical = position.y - lookAt.y;
    const elevation = Math.atan2(vertical, horizontal);
    expect(elevation).toBeGreaterThan(0.05); // looking down a little...
    expect(elevation).toBeLessThan(Math.PI / 4); // ...but nowhere near top-down
  });

  it("aims ahead of the target along the heading", () => {
    const { lookAt } = chaseShot({ x: 2, y: 0, z: 3 }, { x: 1, z: 0 });
    expect(lookAt.x).toBeCloseTo(2 + CHASE_DEFAULTS.lookAhead, 5);
    expect(lookAt.z).toBeCloseTo(3, 5);
  });

  it("normalizes a non-unit heading and survives a zero heading", () => {
    const long = chaseShot({ x: 0, y: 0, z: 0 }, { x: 0, z: 10 });
    expect(long.position.z).toBeCloseTo(-CHASE_DEFAULTS.distance, 5);
    const zero = chaseShot({ x: 0, y: 0, z: 0 }, { x: 0, z: 0 });
    expect(Number.isFinite(zero.position.x)).toBe(true);
    expect(Number.isFinite(zero.position.z)).toBe(true);
  });
});

describe("createChaseSolver (damped chase, pure)", () => {
  const step = (solver, frame, n = 1) => {
    let out = null;
    for (let i = 0; i < n; i++) out = solver.update({ ...frame, dt: 1 / 60 });
    return out;
  };

  it("snaps to the shot on the first update, then damps toward a moving goal", () => {
    const solver = createChaseSolver();
    const first = step(solver, { target: { x: 0, y: 0, z: 0 }, heading: { x: 0, z: 1 } });
    expect(first.position.z).toBeCloseTo(-CHASE_DEFAULTS.distance, 5); // snap, no easing from origin

    // Target teleports forward: the camera moves toward it a bit each frame,
    // never jumping.
    const before = first.position.z;
    const one = step(solver, { target: { x: 0, y: 0, z: 6 }, heading: { x: 0, z: 1 } });
    expect(one.position.z).toBeGreaterThan(before);
    expect(one.position.z).toBeLessThan(6 - CHASE_DEFAULTS.distance);
    const settled = step(solver, { target: { x: 0, y: 0, z: 6 }, heading: { x: 0, z: 1 } }, 900);
    expect(settled.position.z).toBeCloseTo(6 - CHASE_DEFAULTS.distance, 1);
    expect(settled.lookAt.z).toBeCloseTo(6 + CHASE_DEFAULTS.lookAhead, 1);
  });

  it("handles a 90-degree path turn gracefully (smoothed heading, bounded per-frame motion)", () => {
    const solver = createChaseSolver();
    step(solver, { target: { x: 0, y: 0, z: 0 }, heading: { x: 0, z: 1 } }, 60);
    // Hard turn: heading flips to +x. The camera must swing around smoothly.
    let prev = step(solver, { target: { x: 0, y: 0, z: 0 }, heading: { x: 1, z: 0 } });
    let maxStep = 0;
    for (let i = 0; i < 600; i++) {
      const cur = step(solver, { target: { x: 0, y: 0, z: 0 }, heading: { x: 1, z: 0 } });
      maxStep = Math.max(maxStep, Math.hypot(cur.position.x - prev.position.x, cur.position.z - prev.position.z));
      prev = cur;
    }
    expect(maxStep).toBeLessThan(0.25); // no teleporting mid-turn
    expect(prev.position.x).toBeCloseTo(-CHASE_DEFAULTS.distance, 1); // ends behind the new heading
    expect(Math.abs(prev.position.z)).toBeLessThan(0.4);
  });

  it("clamps the camera above the terrain via heightAt", () => {
    const solver = createChaseSolver();
    const out = step(
      solver,
      { target: { x: 0, y: 0, z: 0 }, heading: { x: 0, z: 1 }, heightAt: () => 9 },
      120,
    );
    expect(out.position.y).toBeGreaterThanOrEqual(9 + CHASE_DEFAULTS.clearance - 1e-9);
  });

  it("setParams retargets the shot live (the door push-in)", () => {
    const solver = createChaseSolver();
    const frame = { target: { x: 0, y: 0, z: 0 }, heading: { x: 0, z: 1 } };
    step(solver, frame, 60);
    solver.setParams({ distance: 2.0, height: 1.2 });
    const pushed = step(solver, frame, 900);
    expect(Math.abs(pushed.position.z)).toBeCloseTo(2.0, 1);
    expect(pushed.position.y).toBeCloseTo(1.2, 1);
  });
});

describe("createCameraRig", () => {
  let dom, rig;

  beforeEach(() => {
    dom = document.createElement("div");
    document.body.appendChild(dom);
    rig = createCameraRig({ domElement: dom, config: config.camera, aspect: 1.5 });
  });

  afterEach(() => {
    rig.dispose();
    dom.remove();
  });

  const settle = (steps = 600) => {
    for (let i = 0; i < steps; i++) rig.update(1 / 60);
  };

  it("binds left/right to pan, middle to orbit, and keeps limits from config", () => {
    expect(rig.controls.mouseButtons.LEFT).toBe(THREE.MOUSE.PAN);
    expect(rig.controls.mouseButtons.RIGHT).toBe(THREE.MOUSE.PAN);
    expect(rig.controls.mouseButtons.MIDDLE).toBe(THREE.MOUSE.ROTATE);
    expect(rig.controls.touches.ONE).toBe(THREE.TOUCH.PAN);
    expect(rig.controls.minDistance).toBe(config.camera.minDistance);
    expect(rig.controls.maxDistance).toBe(config.camera.maxDistance);
    expect(rig.controls.minPolarAngle).toBe(config.camera.minPolarAngle);
    expect(rig.controls.maxPolarAngle).toBe(config.camera.maxPolarAngle);
  });

  it("focus(point) tweens the pivot there, preserves the offset, then ends", () => {
    const offsetBefore = rig.camera.position.clone().sub(rig.controls.target);
    rig.focus({ x: 5, z: 3 });
    expect(rig.focusing).toBe(true);
    settle();
    expect(rig.controls.target.x).toBeCloseTo(5, 1);
    expect(rig.controls.target.z).toBeCloseTo(3, 1);
    expect(rig.focusing).toBe(false); // tween completes on arrival
    const offsetAfter = rig.camera.position.clone().sub(rig.controls.target);
    expect(offsetAfter.distanceTo(offsetBefore)).toBeLessThan(0.05);
  });

  it("follow(object) keeps tracking a moving target at the current offset", () => {
    const obj = new THREE.Object3D();
    obj.position.set(2, 0, 2);
    const offsetBefore = rig.camera.position.clone().sub(rig.controls.target);

    rig.follow(obj);
    expect(rig.following).toBe(true);
    settle();
    expect(rig.controls.target.x).toBeCloseTo(2, 1);
    expect(rig.controls.target.z).toBeCloseTo(2, 1);
    expect(rig.following).toBe(true); // unlike focus, it never self-ends

    obj.position.set(6, 0, -4); // the target moved; the camera stays with it
    settle();
    expect(rig.controls.target.x).toBeCloseTo(6, 1);
    expect(rig.controls.target.z).toBeCloseTo(-4, 1);
    const offsetAfter = rig.camera.position.clone().sub(rig.controls.target);
    expect(offsetAfter.distanceTo(offsetBefore)).toBeLessThan(0.05);
  });

  it("follow with a framing eases to the standard shot (select-to-follow)", () => {
    const obj = new THREE.Object3D();
    obj.position.set(2, 0, 2);
    const azBefore = (() => {
      const off = rig.camera.position.clone().sub(rig.controls.target);
      return Math.atan2(off.x, off.z);
    })();

    rig.follow(obj, { framing: { distance: 6, pitch: 0.5, lerp: 0.3 } });
    expect(rig.following).toBe(true);
    settle(1200);

    expect(rig.controls.target.x).toBeCloseTo(2, 1); // tracking her
    expect(rig.controls.target.z).toBeCloseTo(2, 1);
    const off = rig.camera.position.clone().sub(rig.controls.target);
    const d = off.length();
    expect(d).toBeCloseTo(6, 1); // the preset distance...
    expect(Math.asin(off.y / d)).toBeCloseTo(0.5, 1); // ...and pitch
    expect(Math.atan2(off.x, off.z)).toBeCloseTo(azBefore, 1); // azimuth kept

    obj.position.set(6, 0, -3); // she walks on; the framing holds
    settle(1200);
    const off2 = rig.camera.position.clone().sub(rig.controls.target);
    expect(off2.length()).toBeCloseTo(6, 1);
    expect(rig.controls.target.x).toBeCloseTo(6, 1);
  });

  it("user camera input cancels a framed follow too", () => {
    const obj = new THREE.Object3D();
    rig.follow(obj, { framing: FOLLOW_FRAMING });
    rig.controls.dispatchEvent({ type: "start" });
    expect(rig.following).toBe(false);
    // and a later plain follow does not inherit the old framing
    const offBefore = rig.camera.position.clone().sub(rig.controls.target);
    rig.follow(obj);
    for (let i = 0; i < 600; i++) rig.update(1 / 60);
    const offAfter = rig.camera.position.clone().sub(rig.controls.target);
    expect(offAfter.distanceTo(offBefore)).toBeLessThan(0.05); // offset preserved
  });

  it("any user camera input cancels follow and focus", () => {
    const obj = new THREE.Object3D();
    rig.follow(obj);
    // OrbitControls fires "start" for every user gesture (drag or wheel).
    rig.controls.dispatchEvent({ type: "start" });
    expect(rig.following).toBe(false);

    rig.focus({ x: 1, z: 1 });
    expect(rig.focusing).toBe(true);
    rig.controls.dispatchEvent({ type: "start" });
    expect(rig.focusing).toBe(false);
  });

  it("stopFollow stops tracking; focus and follow cancel each other", () => {
    const obj = new THREE.Object3D();
    rig.follow(obj);
    rig.stopFollow();
    expect(rig.following).toBe(false);

    rig.follow(obj);
    rig.focus({ x: 0, z: 0 });
    expect(rig.following).toBe(false);
    expect(rig.focusing).toBe(true);

    rig.follow(obj);
    expect(rig.focusing).toBe(false);
    expect(rig.following).toBe(true);

    rig.focus(null); // explicit cancel clears everything
    expect(rig.focusing).toBe(false);
  });

  it("frameLerp compounds per elapsed 60fps frames", () => {
    expect(frameLerp(0.12, 1 / 60)).toBeCloseTo(0.12, 6);
    expect(frameLerp(0.12, 2 / 60)).toBeCloseTo(1 - Math.pow(0.88, 2), 6);
    expect(frameLerp(0.12, -1)).toBe(0);
  });

  it("startChase tracks behind the target's heading and aims ahead of it", () => {
    const obj = new THREE.Object3D();
    obj.position.set(10, 0.5, 5);
    rig.startChase(obj, { heading: () => ({ x: 0, z: 1 }), heightAt: () => 0 });
    expect(rig.chasing).toBe(true);
    settle();
    expect(rig.camera.position.x).toBeCloseTo(10, 1);
    expect(rig.camera.position.z).toBeCloseTo(5 - 4.8, 0); // behind (heading is +z)
    expect(rig.camera.position.y).toBeGreaterThan(0.5); // above, over the shoulder
    expect(rig.controls.target.z).toBeGreaterThan(5); // aim point leads the walk
  });

  it("chase mode ignores user camera input (follow's cancel is bypassed)", () => {
    const obj = new THREE.Object3D();
    rig.startChase(obj, { heading: () => ({ x: 0, z: 1 }) });
    rig.controls.dispatchEvent({ type: "start" }); // a user gesture
    expect(rig.chasing).toBe(true); // still chasing: cinematic input lock
    rig.stopChase();
    expect(rig.chasing).toBe(false);

    rig.follow(obj); // plain follow still cancels on input, as before
    rig.controls.dispatchEvent({ type: "start" });
    expect(rig.following).toBe(false);
  });

  it("chase never dips below the terrain clamp", () => {
    const obj = new THREE.Object3D();
    obj.position.set(0, 0.5, 0);
    rig.startChase(obj, { heading: () => ({ x: 0, z: 1 }), heightAt: () => 12 });
    settle();
    expect(rig.camera.position.y).toBeGreaterThanOrEqual(12);
  });

  it("startChase preempts follow/focus; setControlsEnabled locks the controls", () => {
    const obj = new THREE.Object3D();
    rig.follow(obj);
    rig.startChase(obj, { heading: () => ({ x: 0, z: 1 }) });
    expect(rig.following).toBe(false);
    expect(rig.chasing).toBe(true);
    rig.setControlsEnabled(false);
    expect(rig.controls.enabled).toBe(false);
    rig.setControlsEnabled(true);
    expect(rig.controls.enabled).toBe(true);
  });
});
