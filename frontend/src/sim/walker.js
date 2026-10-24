// Wander + goto steering on the ground plane (x, z), plus local avoidance
// and street-route following. Pure vector math, no three.js. The scene owns
// the y coordinate (ground height / hop offset).
//
// createWalker returns a little state machine:
//   idle --(pause elapsed)--> walking(route or wander target) --> idle
// goto(target) preempts anything and walks straight there; the arrival event
// carries {goal: true} so the scene can react (e.g. keeper reached a shelf).
// followRoute(points, {goal}) walks a street polyline waypoint by waypoint:
// intermediate hops are silent, one "arrive" fires at the final point. Each
// intermediate waypoint gets a small seeded lateral wobble (routeWobble) so
// walkers do not bead up on the centerline, and the live position is
// clamped to within routeClamp of the current segment: separation and
// obstacle pushes can slow a walker down or make it pass on the shoulder,
// but never shove it off the path. Wandering uses `sampleRoute(random, pos)`
// (a street-graph planner).
// update(dt) returns an array of events: {type: "arrive", target, goal}
// and {type: "depart", target}.
//
// Avoidance (all deterministic given positions, and all optional):
//  - separation: neighbors inside `separationRadius` push the walker away
//    with a smooth quadratic falloff (zero force at the radius, so there is
//    no jitter at the boundary). Applies while wandering, on goto walks and
//    while standing, so two keepers sent to the same point end up side by side.
//    `separationBias` is a per-walker angle used only when two bodies are
//    exactly coincident (deterministic tiebreak).
//  - obstacles: static circles ({x, z, r}, e.g. houses/props from the world
//    layout) that the walker is pushed out of; while walking it also slides
//    along the tangent so it flows around scenery instead of stalling.
//  - clamp: (point) -> {x, z} applied to every target AND to the live
//    position, so a walker can never leave its own district.
//  - passing: neighbors AHEAD of a walking walker bias it to its own right
//    and slow it down (passingAdjust), so two walkers meeting on a lane
//    drift to opposite shoulders and glide past each other instead of
//    pushing chest-to-chest; the route clamp keeps the pass inside the lane.
//  - stall watchdog: a walker that stops making progress toward its target
//    (wedged against scenery or another walker) re-routes: intermediate
//    route waypoints are skipped, and a stuck non-goal walk is abandoned
//    with a {type: "stall"} event so the next wander plans a fresh route.
//    Goal walks (goto / followRoute goal) are never abandoned.

// Summed push away from close neighbors. Magnitude is (1 - d/radius)^2 per
// neighbor: continuous, zero at the radius, strongest when overlapping.
export function separationPush(pos, neighbors = [], { radius = 0.9, bias = 0 } = {}) {
  let fx = 0;
  let fz = 0;
  for (const nb of neighbors) {
    if (!nb || !Number.isFinite(nb.x) || !Number.isFinite(nb.z)) continue;
    const dx = pos.x - nb.x;
    const dz = pos.z - nb.z;
    const d = Math.hypot(dx, dz);
    if (d >= radius) continue;
    if (d < 1e-6) {
      // Exactly coincident: deterministic tiebreak direction.
      fx += Math.cos(bias);
      fz += Math.sin(bias);
      continue;
    }
    const w = 1 - d / radius;
    const s = (w * w) / d;
    fx += dx * s;
    fz += dz * s;
  }
  return { x: fx, z: fz };
}

// Displacement that would move pos onto the rim of every circle it is
// inside (summed). Zero outside all circles.
export function obstaclePush(pos, obstacles = []) {
  let ox = 0;
  let oz = 0;
  for (const ob of obstacles) {
    const dx = pos.x - ob.x;
    const dz = pos.z - ob.z;
    const d = Math.hypot(dx, dz);
    if (d >= ob.r) continue;
    if (d < 1e-6) {
      ox += ob.r; // dead center: push +x, deterministically
      continue;
    }
    const need = (ob.r - d) / d;
    ox += dx * need;
    oz += dz * need;
  }
  return { x: ox, z: oz };
}

// Lane-passing adjustment: neighbors within `radius` and roughly AHEAD
// (along the walker's unit-ish heading) produce a deterministic lateral bias
// to the walker's own right plus a slowdown factor. Two walkers meeting
// head-on each drift to their own right (opposite world sides), so they pass
// cleanly; a walker catching up to a slower one eases off instead of shoving.
// Zero for neighbors beside or behind (plain separation handles those).
export function passingAdjust(pos, heading, neighbors = [], { radius = 1.6 } = {}) {
  let lateral = 0;
  let slow = 1;
  const hx = heading?.x ?? 0;
  const hz = heading?.z ?? 0;
  for (const nb of neighbors) {
    if (!nb || !Number.isFinite(nb.x) || !Number.isFinite(nb.z)) continue;
    const dx = nb.x - pos.x;
    const dz = nb.z - pos.z;
    const d = Math.hypot(dx, dz);
    if (d >= radius || d < 1e-6) continue;
    const ahead = (dx * hx + dz * hz) / d; // cos of the bearing to the neighbor
    if (ahead <= 0.2) continue; // beside/behind: not a lane encounter
    const w = (1 - d / radius) * ahead; // smooth: 0 at the radius, strongest head-on
    lateral += w;
    slow = Math.min(slow, 1 - 0.65 * w);
  }
  // Right of the heading = (hz, -hx). The +0 normalizes -0 away.
  return { x: hz * lateral + 0, z: -hx * lateral + 0, slow: Math.max(0.3, slow) };
}

export function createWalker({
  position = { x: 0, z: 0 },
  speed = 1.4,
  arriveRadius = 0.3,
  pauseRange = [1.5, 5],
  sampleRoute = null, // (random, pos) -> [{x,z}, ...]; graph-route wandering
  random = Math.random,
  neighbors = null, // () -> [{x, z}] positions of the other bodies
  obstacles = [], // [{x, z, r}] static circles to stay out of
  separationRadius = 0.9,
  separationSpeed = 1.6, // how hard neighbors push (world units / s at full overlap)
  separationBias = 0, // tiebreak angle for exactly coincident bodies
  clamp = null, // (point) -> {x, z}; sector clamp for targets and position
  routeWobble = 0.45, // max lateral offset applied to intermediate waypoints
  routeClamp = 0.65, // max lateral drift off the current route segment
  stallSeconds = 2.5, // no progress for this long -> the watchdog re-routes
} = {}) {
  const pos = { x: position.x, z: position.z };
  let target = null;
  let goalFlag = false; // current walk was an explicit goto()
  let route = null; // { pts, targets, i, goal, from } while following a polyline
  let pauseLeft = pausePick();
  const heading = { x: 0, z: 1 }; // last movement direction, unit-ish
  let bestDist = Infinity; // closest we ever got to the current target
  let stallT = 0; // seconds without progress toward the current target

  function resetWatchdog() {
    bestDist = Infinity;
    stallT = 0;
  }

  function pausePick() {
    const [lo, hi] = pauseRange;
    return lo + (hi - lo) * random();
  }

  function clamped(t) {
    if (typeof clamp !== "function") return { x: t.x, z: t.z };
    const c = clamp(t);
    return c && Number.isFinite(c.x) && Number.isFinite(c.z) ? { x: c.x, z: c.z } : { x: t.x, z: t.z };
  }

  // Queue a polyline. Intermediate waypoints get a seeded lateral wobble
  // (bounded by routeWobble); the first and last points stay exact.
  function beginRoute(points, goal) {
    const pts = [];
    for (const p of points ?? []) {
      if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) pts.push(clamped(p));
    }
    if (!pts.length) return false;
    const targets = pts.map((p, i) => {
      if (i === 0 || i === pts.length - 1) return { x: p.x, z: p.z };
      const prev = pts[i - 1];
      const next = pts[i + 1];
      const dx = next.x - prev.x;
      const dz = next.z - prev.z;
      const len = Math.hypot(dx, dz) || 1e-9;
      const off = (random() * 2 - 1) * routeWobble;
      return clamped({ x: p.x - (dz / len) * off, z: p.z + (dx / len) * off });
    });
    route = { pts, targets, i: 0, goal, from: { x: pos.x, z: pos.z } };
    target = { ...targets[0] };
    goalFlag = goal;
    resetWatchdog();
    return true;
  }

  function clearWalk() {
    target = null;
    route = null;
    goalFlag = false;
    resetWatchdog();
  }

  function startWander() {
    if (typeof sampleRoute !== "function") return false;
    const pts = sampleRoute(random, { x: pos.x, z: pos.z });
    return Array.isArray(pts) && pts.length ? beginRoute(pts, false) : false;
  }

  // Separation + obstacle + sector-clamp pushes; applied every update, even
  // while idle, so bodies drift apart instead of standing overlapped.
  function applyPushes(dt) {
    const nbs = typeof neighbors === "function" ? neighbors() : null;
    if (nbs && nbs.length) {
      const f = separationPush(pos, nbs, { radius: separationRadius, bias: separationBias });
      let mx = f.x * separationSpeed * dt;
      let mz = f.z * separationSpeed * dt;
      const m = Math.hypot(mx, mz);
      const cap = separationRadius * 0.5; // never teleport, even on a dt spike
      if (m > cap) {
        mx *= cap / m;
        mz *= cap / m;
      }
      pos.x += mx;
      pos.z += mz;
    }
    if (obstacles.length) {
      const o = obstaclePush(pos, obstacles);
      if (o.x !== 0 || o.z !== 0) {
        const k = Math.min(1, dt * 6); // ease out, do not pop
        pos.x += o.x * k;
        pos.z += o.z * k;
        if (target !== null) {
          // Walking into scenery: slide along the tangent so the walker
          // flows around the circle instead of stalling on the rim.
          const om = Math.hypot(o.x, o.z) || 1;
          let tx = -o.z / om;
          let tz = o.x / om;
          if (tx * heading.x + tz * heading.z < 0) {
            tx = -tx;
            tz = -tz;
          }
          pos.x += tx * speed * dt * 0.7;
          pos.z += tz * speed * dt * 0.7;
        }
      }
    }
    if (route && target !== null) {
      // Path adherence: pushes may slow the walker or slide it to the
      // shoulder, but never off the street. Clamp the lateral drift around
      // the current segment (slightly extended past its ends so corners do
      // not snap).
      const a = route.i === 0 ? route.from : route.pts[route.i - 1];
      const b = route.pts[route.i];
      const abx = b.x - a.x;
      const abz = b.z - a.z;
      const q = abx * abx + abz * abz;
      if (q > 1e-9) {
        let t = ((pos.x - a.x) * abx + (pos.z - a.z) * abz) / q;
        t = t < -0.25 ? -0.25 : t > 1.25 ? 1.25 : t;
        const cx = a.x + abx * t;
        const cz = a.z + abz * t;
        const dx = pos.x - cx;
        const dz = pos.z - cz;
        const d = Math.hypot(dx, dz);
        if (d > routeClamp) {
          const s = routeClamp / d;
          pos.x = cx + dx * s;
          pos.z = cz + dz * s;
        }
      }
    }
    if (typeof clamp === "function") {
      const c = clamped(pos);
      pos.x = c.x;
      pos.z = c.z;
    }
  }

  return {
    get position() {
      return pos;
    },
    get heading() {
      return heading;
    },
    get target() {
      return target;
    },
    get walking() {
      return target !== null;
    },
    get route() {
      return route ? route.pts.slice(route.i) : null;
    },

    goto(t) {
      if (!t || !Number.isFinite(t.x) || !Number.isFinite(t.z)) return;
      route = null;
      target = clamped(t);
      goalFlag = true;
      resetWatchdog();
    },

    // Walk a street polyline waypoint by waypoint; one "arrive" fires at the
    // final point (goal defaults true: the join cinematic listens for it).
    followRoute(points, { goal = true } = {}) {
      return beginRoute(points, goal);
    },

    stop() {
      clearWalk();
      pauseLeft = pausePick();
    },

    update(dt) {
      const events = [];
      if (!Number.isFinite(dt) || dt <= 0) return events;

      if (target === null) {
        pauseLeft -= dt;
        if (pauseLeft <= 0 && startWander()) {
          const dest = route ? route.pts[route.pts.length - 1] : target;
          events.push({ type: "depart", target: { ...dest } });
        }
        applyPushes(dt);
        return events;
      }

      // Intermediate route waypoints are passed loosely (no stopping); the
      // final point uses the exact arrive radius.
      const lastHop = !route || route.i >= route.pts.length - 1;
      const hitRadius = lastHop ? arriveRadius : Math.max(arriveRadius, 0.5);

      const arriveNow = () => {
        if (!lastHop) {
          route.i += 1;
          target = { ...route.targets[route.i] };
          resetWatchdog();
          return null;
        }
        pos.x = target.x;
        pos.z = target.z;
        const arrived = { type: "arrive", target: { ...target }, goal: goalFlag };
        clearWalk();
        pauseLeft = pausePick();
        return arrived;
      };

      const dx = target.x - pos.x;
      const dz = target.z - pos.z;
      const dist = Math.hypot(dx, dz);

      // Zero-length steering guard: treat "already there" as arrival, never
      // divide by ~0.
      if (dist <= hitRadius || dist < 1e-9) {
        const arrived = arriveNow();
        if (arrived) events.push(arrived);
        applyPushes(dt);
        return events;
      }

      // Stall watchdog: no progress toward the target for stallSeconds means
      // the walker is wedged (scenery, a hard obstacle, a standing crowd).
      // Intermediate route waypoints are skipped; a stuck non-goal walk is
      // abandoned with a "stall" event so the next wander re-routes. Goal
      // walks (join/sleep choreography) keep trying: their targets always
      // have a clear approach.
      if (dist < bestDist - 1e-3) {
        bestDist = dist;
        stallT = 0;
      } else {
        stallT += dt;
        if (stallT >= stallSeconds) {
          if (!lastHop) {
            route.i += 1;
            target = { ...route.targets[route.i] };
            resetWatchdog();
            applyPushes(dt);
            return events;
          }
          if (!goalFlag) {
            events.push({ type: "stall", target: { ...target } });
            clearWalk();
            pauseLeft = 0.5; // re-route promptly, not after a full pause
            applyPushes(dt);
            return events;
          }
          resetWatchdog(); // goal walk: keep pushing, re-arm the watchdog
        }
      }

      const inv = 1 / dist;
      heading.x = dx * inv;
      heading.z = dz * inv;

      // Lane passing: someone ahead slows this walker and biases it to its
      // own right; the route clamp keeps the pass on the shoulder.
      let speedK = 1;
      const nbs = typeof neighbors === "function" ? neighbors() : null;
      if (nbs && nbs.length) {
        const pass = passingAdjust(pos, heading, nbs, { radius: separationRadius * 1.7 });
        speedK = pass.slow;
        pos.x += pass.x * speed * dt * 0.8;
        pos.z += pass.z * speed * dt * 0.8;
      }

      const step = Math.min(speed * speedK * dt, dist);
      pos.x += heading.x * step;
      pos.z += heading.z * step;

      // Arrived this frame?
      if (dist - step <= hitRadius) {
        const arrived = arriveNow();
        if (arrived) events.push(arrived);
      }
      applyPushes(dt);
      return events;
    },
  };
}
