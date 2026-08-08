// Camera rig built on OrbitControls, "grab the ground" style:
//   hold LEFT drag   = pan (drag the ground under the cursor)
//   hold RIGHT drag  = pan (identical feel)
//   hold MIDDLE drag = orbit / rotate
//   wheel / two-finger scroll = zoom
//   click (below the drag threshold) = select, handled by scene picking
// A modifier key (shift/ctrl/meta) flips pan <-> orbit, which OrbitControls
// gives us for free. Sane distance/pitch limits come from config.camera.
//
// focus(target) tweens the orbit pivot onto a point/object and stops on
// arrival. follow(target, {framing}) keeps tracking a moving target until
// stopFollow() or any user camera input; with a framing preset the camera
// also eases to a standard distance + pitch (keeping its azimuth), which is
// the select-to-follow shot: close enough to see an keeper's face, not macro.
//
// startChase(target, opts) enters a cinematic third-person chase: the camera
// sits behind-and-above the target relative to its heading (a low
// over-the-shoulder angle, not top-down), with damped position, smoothed
// heading (graceful on path turns), a look-ahead aim point, and a terrain
// clamp via an opts.heightAt callback so it never clips into the ground.
// Unlike follow(), chase mode is NOT cancelled by user camera input; the
// scene locks the controls (setControlsEnabled) and drives it during the
// join cinematic. setChaseParams({distance,...}) retargets the shot live
// (the solver damps toward the new frame, e.g. the door push-in).
//
// The pure drag-mode state machine (dragModeForPointer, createDragTracker)
// and the pure chase solver (createChaseSolver) are unit-tested without
// WebGL.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// ---------------------------------------------------------------------------
// Pure helpers (no three.js state) -- tested in tests/camera.test.js
// ---------------------------------------------------------------------------

// Frame-rate independent lerp factor: `perFrame` is tuned for 60fps.
export function frameLerp(perFrame, dt) {
  return 1 - Math.pow(1 - perFrame, Math.max(0, dt) * 60);
}

// Which camera drag mode a pointer-down maps to. Buttons follow the
// PointerEvent convention: 0 = left, 1 = middle, 2 = right.
export function dragModeForPointer({ button = 0, ctrlKey = false, metaKey = false, shiftKey = false } = {}) {
  const base = button === 1 || button === 2 ? "orbit" : "pan"; // left pans; right or middle orbits
  if (ctrlKey || metaKey || shiftKey) return base === "pan" ? "orbit" : "pan";
  return base;
}

// Click-vs-drag state machine. down/move/up mirror pointer events; up()
// reports whether the gesture was a click (select) or a drag (camera move),
// and which camera mode the drag was in.
export function createDragTracker({ clickMoveMax = 6, clickHoldMaxMs = 450 } = {}) {
  let active = null;
  return {
    down({ x = 0, y = 0, time = 0, button = 0, ctrlKey, metaKey, shiftKey } = {}) {
      active = {
        x0: x,
        y0: y,
        time,
        mode: dragModeForPointer({ button, ctrlKey, metaKey, shiftKey }),
        moved: 0,
        dragging: false,
      };
      return active.mode;
    },
    move({ x = 0, y = 0 } = {}) {
      if (!active) return null;
      active.moved = Math.max(active.moved, Math.hypot(x - active.x0, y - active.y0));
      if (active.moved > clickMoveMax) active.dragging = true;
      return active.dragging ? active.mode : null;
    },
    up({ time = 0 } = {}) {
      if (!active) return { click: false, mode: null, moved: 0 };
      const held = time - active.time;
      const out = {
        click: !active.dragging && held <= clickHoldMaxMs,
        mode: active.dragging ? active.mode : null,
        moved: active.moved,
      };
      active = null;
      return out;
    },
    cancel() {
      active = null;
    },
    get dragging() {
      return active?.dragging ?? false;
    },
    get mode() {
      return active?.mode ?? null;
    },
  };
}

// --- select-to-follow framing (pure {x,y,z} math, no three.js) --------------

// The standard shot follow() tweens into when given a framing: a preset
// distance and pitch (radians above the horizon), azimuth preserved.
export const FOLLOW_FRAMING = {
  distance: 7, // close enough to read her face, never macro
  pitch: 0.5, // ~29 degrees above the horizon
  lerp: 0.08, // per-60fps-frame damping toward the framing
};

// Retarget a camera offset (camera minus pivot) to a framing preset while
// preserving its azimuth, so selecting an keeper dollies/tilts the camera but
// never spins it. Degenerate (vertical) offsets fall back to azimuth 0.
export function frameOffset(offset = {}, framing = FOLLOW_FRAMING) {
  const f = { ...FOLLOW_FRAMING, ...framing };
  const hx = Number.isFinite(offset.x) ? offset.x : 0;
  const hz = Number.isFinite(offset.z) ? offset.z : 0;
  const az = Math.hypot(hx, hz) > 1e-6 ? Math.atan2(hx, hz) : 0;
  const flat = Math.cos(f.pitch) * f.distance;
  return {
    x: Math.sin(az) * flat,
    y: Math.sin(f.pitch) * f.distance,
    z: Math.cos(az) * flat,
  };
}

// --- cinematic chase solver (pure {x,y,z} math, no three.js) ---------------

export const CHASE_DEFAULTS = {
  distance: 4.8, // how far behind the target the camera sits
  height: 2.1, // how far above the target (low over-the-shoulder, NOT top-down)
  lookAhead: 2.6, // aim point this far ahead of the target along its heading
  lookHeight: 0.55, // aim slightly above the ground so the horizon reads
  posLerp: 0.07, // per-60fps-frame damping toward the goal position
  lookLerp: 0.12, // per-frame damping of the aim point
  headingLerp: 0.055, // per-frame smoothing of the heading (graceful turns)
  clearance: 0.6, // camera never dips below terrain + clearance
};

function normalizeXZ(v, fallback = { x: 0, z: 1 }) {
  const len = Math.hypot(v?.x ?? 0, v?.z ?? 0);
  if (!(len > 1e-6)) return { x: fallback.x, z: fallback.z };
  return { x: v.x / len, z: v.z / len };
}

// One instant chase frame (no smoothing): where the camera and its aim point
// belong for a target + unit heading. Behind = opposite the heading.
export function chaseShot(target, heading, params = CHASE_DEFAULTS) {
  const p = { ...CHASE_DEFAULTS, ...params };
  const h = normalizeXZ(heading);
  return {
    position: {
      x: target.x - h.x * p.distance,
      y: (target.y ?? 0) + p.height,
      z: target.z - h.z * p.distance,
    },
    lookAt: {
      x: target.x + h.x * p.lookAhead,
      y: (target.y ?? 0) + p.lookHeight,
      z: target.z + h.z * p.lookAhead,
    },
  };
}

// Stateful damped chase: feed it the target/heading each frame, get a camera
// position + aim point back. heightAt(x, z) (optional) clamps the camera
// above the terrain. Pure JS objects throughout; tested without WebGL.
export function createChaseSolver(params = {}) {
  const p = { ...CHASE_DEFAULTS, ...params };
  let pos = null; // {x,y,z} smoothed camera position
  let look = null; // {x,y,z} smoothed aim point
  let heading = null; // {x,z} smoothed unit heading

  function update({ target, heading: rawHeading, dt = 1 / 60, heightAt = null } = {}) {
    const goalHeading = normalizeXZ(rawHeading, heading ?? { x: 0, z: 1 });
    if (!heading) {
      heading = { ...goalHeading };
    } else {
      const hk = frameLerp(p.headingLerp, dt);
      heading = normalizeXZ(
        { x: heading.x + (goalHeading.x - heading.x) * hk, z: heading.z + (goalHeading.z - heading.z) * hk },
        goalHeading,
      );
    }
    const goal = chaseShot(target, heading, p);
    if (!pos) {
      pos = { ...goal.position };
      look = { ...goal.lookAt };
    } else {
      const pk = frameLerp(p.posLerp, dt);
      pos.x += (goal.position.x - pos.x) * pk;
      pos.y += (goal.position.y - pos.y) * pk;
      pos.z += (goal.position.z - pos.z) * pk;
      const lk = frameLerp(p.lookLerp, dt);
      look.x += (goal.lookAt.x - look.x) * lk;
      look.y += (goal.lookAt.y - look.y) * lk;
      look.z += (goal.lookAt.z - look.z) * lk;
    }
    if (typeof heightAt === "function") {
      const ground = heightAt(pos.x, pos.z);
      if (Number.isFinite(ground) && pos.y < ground + p.clearance) pos.y = ground + p.clearance;
    }
    return { position: { ...pos }, lookAt: { ...look } };
  }

  return {
    update,
    setParams(partial = {}) {
      Object.assign(p, partial);
    },
    get params() {
      return { ...p };
    },
    reset() {
      pos = null;
      look = null;
      heading = null;
    },
  };
}

function targetPoint(target, out) {
  if (!target) return null;
  if (target.isObject3D) {
    target.getWorldPosition(out);
    return out;
  }
  if (Number.isFinite(target.x) && Number.isFinite(target.z)) {
    out.set(target.x, target.y ?? 0, target.z);
    return out;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The rig
// ---------------------------------------------------------------------------

export function createCameraRig({ domElement, config: cam = {}, aspect = 1 } = {}) {
  const camera = new THREE.PerspectiveCamera(cam.fov ?? 50, aspect, 0.1, 600);
  camera.position.set(13, 11, 16);

  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.zoomSpeed = cam.zoomSpeed ?? 1.0;
  controls.panSpeed = cam.panSpeed ?? 0.9;
  controls.rotateSpeed = cam.rotateSpeed ?? 0.8;
  controls.minDistance = cam.minDistance ?? 4;
  controls.maxDistance = cam.maxDistance ?? 60;
  controls.minPolarAngle = cam.minPolarAngle ?? 0.15;
  controls.maxPolarAngle = cam.maxPolarAngle ?? Math.PI / 2 - 0.08;
  controls.screenSpacePanning = false; // pan slides along the ground plane
  // Mouse bindings: left grab-drag pan, right or middle orbit, wheel zoom
  // (modifier keys flip pan <-> orbit inside OrbitControls). Touch: one
  // finger pans, two fingers pinch-zoom and twist-rotate.
  controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
  controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
  controls.target.set(0, 0.5, 0);
  controls.update();

  const focusGoal = new THREE.Vector3();
  let focusing = false;
  let focusObject = null; // when focusing a moving Object3D, tween onto it
  let followTarget = null; // Object3D or point tracked until cancelled
  let followFraming = null; // framing preset the follow eases into (or null)
  let chase = null; // { solver, target, heading, heightAt } cinematic chase
  const tmp = new THREE.Vector3();
  const followPos = new THREE.Vector3();
  const chasePos = new THREE.Vector3();

  function cancelOnUserInput() {
    // Chase mode is cinematic: user camera input is ignored, never a cancel
    // (the scene locks the controls anyway; this covers stray events).
    if (chase) return;
    focusing = false;
    focusObject = null;
    followTarget = null;
    followFraming = null;
  }
  // OrbitControls fires "start" for every user gesture (drag or wheel).
  controls.addEventListener("start", cancelOnUserInput);

  return {
    camera,
    controls,

    // Smoothly move the orbit pivot to a Vector3-like, an Object3D, or null
    // (cancel). The camera keeps its orbit offset, so it glides over. The
    // tween ends on arrival; use follow() to keep tracking a mover.
    focus(target) {
      followTarget = null;
      followFraming = null;
      if (target === null || target === undefined) {
        focusing = false;
        focusObject = null;
        return;
      }
      focusObject = target.isObject3D ? target : null;
      if (targetPoint(target, focusGoal)) focusing = true;
    },

    // Track a moving Object3D (or point-like) until stopFollow() or any user
    // camera input. Without a framing the current camera offset is kept;
    // with one ({distance, pitch, lerp}, see FOLLOW_FRAMING) the camera also
    // eases to that standard shot, azimuth preserved (select-to-follow).
    follow(target, { framing = null } = {}) {
      focusing = false;
      focusObject = null;
      followTarget = target ?? null;
      followFraming = followTarget && framing ? { ...FOLLOW_FRAMING, ...framing } : null;
    },

    stopFollow() {
      followTarget = null;
      followFraming = null;
    },

    // Cinematic third-person chase: behind-and-above `target` relative to
    // its heading. opts: { heading: () -> {x,z} | {x,z}, heightAt(x,z),
    // ...CHASE_DEFAULTS overrides }. Not cancelled by user input; ends only
    // via stopChase().
    startChase(target, opts = {}) {
      if (!target) return;
      focusing = false;
      focusObject = null;
      followTarget = null;
      followFraming = null;
      const { heading = null, heightAt = null, ...params } = opts;
      chase = { solver: createChaseSolver(params), target, heading, heightAt };
    },

    // Retarget the shot live (the solver damps to the new frame), e.g. the
    // gentle push toward the door on arrival.
    setChaseParams(partial = {}) {
      chase?.solver.setParams(partial);
    },

    stopChase() {
      chase = null;
    },

    get focusing() {
      return focusing;
    },

    get following() {
      return followTarget !== null;
    },

    get chasing() {
      return chase !== null;
    },

    // Hard input lock for cinematics: OrbitControls stops listening entirely
    // (no orbit/pan/zoom) until re-enabled.
    setControlsEnabled(enabled) {
      controls.enabled = !!enabled;
    },

    update(dt) {
      if (chase) {
        if (targetPoint(chase.target, chasePos)) {
          const rawHeading = typeof chase.heading === "function" ? chase.heading() : chase.heading;
          const { position, lookAt } = chase.solver.update({
            target: { x: chasePos.x, y: chasePos.y, z: chasePos.z },
            heading: rawHeading,
            dt,
            heightAt: chase.heightAt,
          });
          camera.position.set(position.x, position.y, position.z);
          controls.target.set(lookAt.x, lookAt.y, lookAt.z);
        }
        controls.update(); // aims the camera at controls.target
        return;
      }
      if (followTarget) {
        if (targetPoint(followTarget, followPos)) {
          const k = frameLerp(cam.followLerp ?? 0.25, dt);
          tmp.copy(followPos).sub(controls.target).multiplyScalar(k);
          controls.target.add(tmp);
          camera.position.add(tmp); // preserve the orbit offset while tracking
          if (followFraming) {
            // Ease the offset toward the standard shot (azimuth preserved).
            tmp.copy(camera.position).sub(controls.target);
            const goal = frameOffset(tmp, followFraming);
            const fk = frameLerp(followFraming.lerp ?? FOLLOW_FRAMING.lerp, dt);
            tmp.x += (goal.x - tmp.x) * fk;
            tmp.y += (goal.y - tmp.y) * fk;
            tmp.z += (goal.z - tmp.z) * fk;
            camera.position.copy(controls.target).add(tmp);
          }
        }
      } else if (focusing) {
        if (focusObject) targetPoint(focusObject, focusGoal);
        const k = frameLerp(cam.focusLerp ?? 0.12, dt);
        tmp.copy(focusGoal).sub(controls.target).multiplyScalar(k);
        controls.target.add(tmp);
        camera.position.add(tmp); // preserve the orbit offset while gliding
        if (controls.target.distanceTo(focusGoal) < 0.02) {
          focusing = false;
          focusObject = null;
        }
      }
      controls.update();
    },

    onResize(width, height) {
      camera.aspect = width / Math.max(1, height);
      camera.updateProjectionMatrix();
    },

    dispose() {
      controls.removeEventListener("start", cancelOnUserInput);
      controls.dispose();
    },
  };
}
