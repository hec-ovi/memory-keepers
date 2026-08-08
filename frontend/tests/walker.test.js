import { describe, it, expect } from "vitest";
import { createWalker, separationPush, obstaclePush, passingAdjust } from "../src/sim/walker.js";
import { clampToSector } from "../src/sim/world.js";

const finite = (p) => Number.isFinite(p.x) && Number.isFinite(p.z);

describe("sim/walker", () => {
  it("goto reaches the target and emits one arrival with goal=true", () => {
    const w = createWalker({ position: { x: 0, z: 0 }, speed: 2, arriveRadius: 0.1 });
    w.goto({ x: 5, z: 0 });
    expect(w.walking).toBe(true);

    const arrivals = [];
    for (let i = 0; i < 200 && arrivals.length === 0; i++) {
      for (const ev of w.update(0.05)) if (ev.type === "arrive") arrivals.push(ev);
    }
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0].goal).toBe(true);
    expect(arrivals[0].target).toEqual({ x: 5, z: 0 });
    expect(w.position.x).toBeCloseTo(5, 5);
    expect(w.position.z).toBeCloseTo(0, 5);
    expect(w.walking).toBe(false);
  });

  it("moves at the configured speed", () => {
    const w = createWalker({ position: { x: 0, z: 0 }, speed: 1.5, arriveRadius: 0.01 });
    w.goto({ x: 100, z: 0 });
    w.update(1);
    expect(w.position.x).toBeCloseTo(1.5, 6);
  });

  it("never NaNs under zero-length steering (goto the current position)", () => {
    const w = createWalker({ position: { x: 2, z: 3 }, speed: 1, arriveRadius: 0.3 });
    w.goto({ x: 2, z: 3 });
    const events = w.update(0.016);
    expect(events.some((e) => e.type === "arrive")).toBe(true);
    expect(finite(w.position)).toBe(true);
    expect(finite(w.heading)).toBe(true);
    // Keep updating after arrival; still finite.
    for (let i = 0; i < 50; i++) w.update(0.016);
    expect(finite(w.position)).toBe(true);
  });

  it("never NaNs when the target is microscopically close", () => {
    const w = createWalker({ position: { x: 0, z: 0 }, speed: 1, arriveRadius: 0 });
    w.goto({ x: 1e-12, z: 0 });
    w.update(0.016);
    expect(finite(w.position)).toBe(true);
    expect(finite(w.heading)).toBe(true);
  });

  it("wanders: pauses, departs to a sampled target, arrives", () => {
    let calls = 0;
    const w = createWalker({
      position: { x: 0, z: 0 },
      speed: 4,
      arriveRadius: 0.1,
      pauseRange: [1, 1],
      sampleTarget: () => {
        calls++;
        return { x: 3, z: 4 };
      },
      random: () => 0.5,
    });
    expect(w.update(0.5)).toEqual([]); // still pausing
    const evs = w.update(0.6); // pause elapsed -> depart
    expect(evs.map((e) => e.type)).toContain("depart");
    expect(calls).toBe(1);

    let arrived = false;
    for (let i = 0; i < 100 && !arrived; i++) {
      arrived = w.update(0.05).some((e) => e.type === "arrive" && e.goal === false);
    }
    expect(arrived).toBe(true);
    expect(w.position.x).toBeCloseTo(3, 5);
    expect(w.position.z).toBeCloseTo(4, 5);
  });

  it("goto preempts wandering", () => {
    const w = createWalker({
      position: { x: 0, z: 0 },
      speed: 1,
      pauseRange: [0, 0],
      sampleTarget: () => ({ x: 10, z: 10 }),
      random: () => 0.5,
    });
    w.update(0.1); // starts wandering
    w.goto({ x: -1, z: 0 });
    expect(w.target).toEqual({ x: -1, z: 0 });
  });

  it("ignores invalid dt and invalid targets", () => {
    const w = createWalker({ position: { x: 1, z: 1 } });
    expect(w.update(NaN)).toEqual([]);
    expect(w.update(-1)).toEqual([]);
    w.goto({ x: NaN, z: 0 });
    expect(w.walking).toBe(false);
    expect(finite(w.position)).toBe(true);
  });
});

describe("sim/walker separation steering", () => {
  it("separationPush is zero outside the radius and smooth inside", () => {
    const pos = { x: 0, z: 0 };
    expect(separationPush(pos, [{ x: 2, z: 0 }], { radius: 0.9 })).toEqual({ x: 0, z: 0 });
    const near = separationPush(pos, [{ x: 0.3, z: 0 }], { radius: 0.9 });
    const nearer = separationPush(pos, [{ x: 0.1, z: 0 }], { radius: 0.9 });
    expect(near.x).toBeLessThan(0); // pushed away from the neighbor
    expect(Math.abs(nearer.x)).toBeGreaterThan(Math.abs(near.x)); // stronger when closer
    // just inside the radius: force is tiny (no jitter at the boundary)
    const edge = separationPush(pos, [{ x: 0.89, z: 0 }], { radius: 0.9 });
    expect(Math.hypot(edge.x, edge.z)).toBeLessThan(0.01);
  });

  it("coincident bodies split along the deterministic bias angle", () => {
    const a = separationPush({ x: 1, z: 1 }, [{ x: 1, z: 1 }], { radius: 0.9, bias: 0 });
    const b = separationPush({ x: 1, z: 1 }, [{ x: 1, z: 1 }], { radius: 0.9, bias: Math.PI });
    expect(a.x).toBeGreaterThan(0);
    expect(b.x).toBeLessThan(0);
    expect(finite(a)).toBe(true);
    expect(finite(b)).toBe(true);
  });

  function runPairToSamePoint() {
    let wA = null;
    let wB = null;
    wA = createWalker({
      position: { x: -3, z: -0.001 },
      speed: 2,
      arriveRadius: 0.2,
      neighbors: () => [wB.position],
      separationBias: 0,
    });
    wB = createWalker({
      position: { x: 3, z: 0.001 },
      speed: 2,
      arriveRadius: 0.2,
      neighbors: () => [wA.position],
      separationBias: Math.PI,
    });
    wA.goto({ x: 0, z: 0 });
    wB.goto({ x: 0, z: 0 });
    for (let i = 0; i < 900; i++) {
      wA.update(1 / 60);
      wB.update(1 / 60);
    }
    return [wA, wB];
  }

  it("two keepers walking to the same point end up non-overlapping, no NaN", () => {
    const [wA, wB] = runPairToSamePoint();
    expect(finite(wA.position)).toBe(true);
    expect(finite(wB.position)).toBe(true);
    const d = Math.hypot(wA.position.x - wB.position.x, wA.position.z - wB.position.z);
    expect(d).toBeGreaterThan(0.6); // clearly apart (default radius 0.9)
    // both still ended up near the shared destination
    expect(Math.hypot(wA.position.x, wA.position.z)).toBeLessThan(1.5);
    expect(Math.hypot(wB.position.x, wB.position.z)).toBeLessThan(1.5);
  });

  it("is deterministic given positions (same run twice, same outcome)", () => {
    const [a1, b1] = runPairToSamePoint();
    const [a2, b2] = runPairToSamePoint();
    expect(a1.position).toEqual(a2.position);
    expect(b1.position).toEqual(b2.position);
  });

  it("separation also applies during goto (goal) walks, not just wander", () => {
    // A stationary bystander just off the route: the goto walker must get
    // pushed aside while passing, then still reach the goal.
    const blocker = { x: 2, z: 0.08 };
    const w = createWalker({
      position: { x: 0, z: 0 },
      speed: 2,
      arriveRadius: 0.15,
      neighbors: () => [blocker],
    });
    w.goto({ x: 4, z: 0 });
    let maxOff = 0;
    for (let i = 0; i < 400; i++) {
      w.update(1 / 60);
      maxOff = Math.max(maxOff, Math.abs(w.position.z));
    }
    expect(maxOff).toBeGreaterThan(0.05); // it swerved
    expect(Math.hypot(w.position.x - 4, w.position.z)).toBeLessThan(1); // and still got there
  });
});

describe("sim/walker obstacle avoidance", () => {
  it("obstaclePush moves a point out of a circle and is zero outside", () => {
    expect(obstaclePush({ x: 5, z: 0 }, [{ x: 0, z: 0, r: 1 }])).toEqual({ x: 0, z: 0 });
    const inside = obstaclePush({ x: 0.4, z: 0 }, [{ x: 0, z: 0, r: 1 }]);
    expect(0.4 + inside.x).toBeCloseTo(1, 6); // lands on the rim
    expect(finite(obstaclePush({ x: 0, z: 0 }, [{ x: 0, z: 0, r: 1 }]))).toBe(true); // dead center
  });

  it("a walker standing inside scenery drifts out of it", () => {
    const w = createWalker({
      position: { x: 0.05, z: 0 },
      obstacles: [{ x: 0, z: 0, r: 1 }],
      random: () => 0.5,
    });
    for (let i = 0; i < 300; i++) w.update(1 / 60);
    expect(finite(w.position)).toBe(true);
    expect(Math.hypot(w.position.x, w.position.z)).toBeGreaterThan(0.95);
  });

  it("a goto walk slides around an obstacle instead of stalling on it", () => {
    const w = createWalker({
      position: { x: -4, z: 0.05 },
      speed: 2,
      arriveRadius: 0.2,
      obstacles: [{ x: 0, z: 0, r: 1.2 }],
    });
    w.goto({ x: 4, z: 0 });
    let arrived = false;
    for (let i = 0; i < 1200 && !arrived; i++) {
      arrived = w.update(1 / 60).some((e) => e.type === "arrive");
      expect(finite(w.position)).toBe(true);
    }
    expect(arrived).toBe(true);
    expect(w.position.x).toBeCloseTo(4, 5);
  });
});

describe("sim/walker sector clamping (NPCs never cross districts)", () => {
  const sector = { center: { x: 10, z: -5 }, radius: 6 };
  const clamp = (p) => clampToSector(sector, p, 1);
  const inSector = (p) => Math.hypot(p.x - sector.center.x, p.z - sector.center.z) <= sector.radius - 0.99;

  it("goto targets outside the sector are clamped to it", () => {
    const w = createWalker({ position: { x: 10, z: -5 }, speed: 3, clamp });
    w.goto({ x: -30, z: 40 }); // deep inside the other district
    expect(inSector(w.target)).toBe(true);
    for (let i = 0; i < 600; i++) {
      w.update(1 / 60);
      expect(inSector(w.position)).toBe(true);
    }
  });

  it("wander samples outside the sector are clamped too", () => {
    const w = createWalker({
      position: { x: 10, z: -5 },
      speed: 3,
      pauseRange: [0, 0],
      sampleTarget: () => ({ x: 100, z: 100 }), // hostile sampler
      random: () => 0.5,
      clamp,
    });
    for (let i = 0; i < 600; i++) {
      w.update(1 / 60);
      expect(inSector(w.position)).toBe(true);
    }
  });

  it("even steering pushes cannot shove a walker across the boundary", () => {
    // A neighbor sits right at the rim and pushes outward every frame.
    const w = createWalker({
      position: { x: 10 + 4.9, z: -5 },
      neighbors: () => [{ x: 10 + 4.5, z: -5 }],
      separationBias: 0,
      clamp,
    });
    for (let i = 0; i < 300; i++) w.update(1 / 60);
    expect(inSector(w.position)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Route following (NPCs walk only on paths)
// ---------------------------------------------------------------------------

describe("sim/walker followRoute (path following)", () => {
  // An L-shaped street polyline.
  const LINE = (() => {
    const pts = [];
    for (let i = 0; i <= 10; i++) pts.push({ x: i, z: 0 });
    for (let i = 1; i <= 8; i++) pts.push({ x: 10, z: i });
    return pts;
  })();

  function distToPolyline(p, line = LINE) {
    let best = Infinity;
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const b = line[i];
      const abx = b.x - a.x;
      const abz = b.z - a.z;
      const q = abx * abx + abz * abz;
      let t = ((p.x - a.x) * abx + (p.z - a.z) * abz) / q;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(p.x - (a.x + abx * t), p.z - (a.z + abz * t)));
    }
    return best;
  }

  function seededRandom(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  it("walks the whole polyline and fires ONE arrive at the end (goal)", () => {
    const w = createWalker({ position: { x: 0, z: 0 }, speed: 3, arriveRadius: 0.2, random: seededRandom(7) });
    expect(w.followRoute(LINE, { goal: true })).toBe(true);
    expect(w.walking).toBe(true);
    const arrivals = [];
    for (let i = 0; i < 3000 && !arrivals.length; i++) {
      for (const ev of w.update(1 / 60)) if (ev.type === "arrive") arrivals.push(ev);
    }
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0].goal).toBe(true);
    expect(arrivals[0].target).toEqual({ x: 10, z: 8 });
    expect(w.position.x).toBeCloseTo(10, 5);
    expect(w.position.z).toBeCloseTo(8, 5);
  });

  it("stays within the lateral wobble of its polyline for the whole route", () => {
    const w = createWalker({ position: { x: 0, z: 0 }, speed: 3, arriveRadius: 0.2, random: seededRandom(11) });
    w.followRoute(LINE);
    let arrived = false;
    let maxOff = 0;
    for (let i = 0; i < 3000 && !arrived; i++) {
      arrived = w.update(1 / 60).some((e) => e.type === "arrive");
      maxOff = Math.max(maxOff, distToPolyline(w.position));
    }
    expect(arrived).toBe(true);
    expect(maxOff).toBeLessThanOrEqual(0.75); // ~0.6 wobble + arrive slack
  });

  it("separation slows/passes but can never push the walker off the path", () => {
    // A stationary bystander parked right on the lane.
    const blocker = { x: 5, z: 0.05 };
    const w = createWalker({
      position: { x: 0, z: 0 },
      speed: 3,
      arriveRadius: 0.2,
      random: seededRandom(3),
      neighbors: () => [blocker],
    });
    w.followRoute(LINE);
    let arrived = false;
    let maxOff = 0;
    for (let i = 0; i < 4000 && !arrived; i++) {
      arrived = w.update(1 / 60).some((e) => e.type === "arrive");
      maxOff = Math.max(maxOff, distToPolyline(w.position));
    }
    expect(arrived).toBe(true); // it passed the blocker
    expect(maxOff).toBeLessThanOrEqual(0.75); // on the shoulder, not the meadow
  });

  it("wanders by route when sampleRoute is provided (goal=false arrivals)", () => {
    let calls = 0;
    const w = createWalker({
      position: { x: 0, z: 0 },
      speed: 4,
      arriveRadius: 0.2,
      pauseRange: [0.1, 0.1],
      sampleRoute: (random, pos) => {
        calls++;
        expect(Number.isFinite(pos.x)).toBe(true);
        return [
          { x: 2, z: 0 },
          { x: 4, z: 0 },
          { x: 4, z: 3 },
        ];
      },
      random: seededRandom(5),
    });
    let arrivals = 0;
    let departs = 0;
    for (let i = 0; i < 2000; i++) {
      for (const ev of w.update(1 / 60)) {
        if (ev.type === "arrive") {
          arrivals++;
          expect(ev.goal).toBe(false);
          expect(ev.target).toEqual({ x: 4, z: 3 });
        }
        if (ev.type === "depart") {
          departs++;
          expect(ev.target).toEqual({ x: 4, z: 3 }); // the destination, not hop 1
        }
      }
    }
    expect(calls).toBeGreaterThan(0);
    expect(arrivals).toBeGreaterThan(0);
    expect(departs).toBeGreaterThan(0);
  });

  it("route waypoints are clamped to the sector (never cross districts)", () => {
    const sector = { center: { x: 0, z: 0 }, radius: 6 };
    const w = createWalker({
      position: { x: 0, z: 0 },
      speed: 4,
      arriveRadius: 0.2,
      random: seededRandom(9),
      clamp: (p) => clampToSector(sector, p, 1),
    });
    // hostile route leaving the sector
    w.followRoute([
      { x: 3, z: 0 },
      { x: 30, z: 0 },
      { x: 30, z: 30 },
    ]);
    for (let i = 0; i < 2000; i++) {
      w.update(1 / 60);
      expect(Math.hypot(w.position.x, w.position.z)).toBeLessThanOrEqual(5.01);
    }
  });

  it("goto and stop preempt an active route", () => {
    const w = createWalker({ position: { x: 0, z: 0 }, speed: 3, random: seededRandom(1) });
    w.followRoute(LINE);
    expect(w.route.length).toBeGreaterThan(2);
    w.goto({ x: -2, z: 0 });
    expect(w.route).toBeNull();
    expect(w.target).toEqual({ x: -2, z: 0 });
    w.followRoute(LINE);
    w.stop();
    expect(w.route).toBeNull();
    expect(w.walking).toBe(false);
  });

  it("rejects empty or invalid routes", () => {
    const w = createWalker({ position: { x: 0, z: 0 } });
    expect(w.followRoute([])).toBe(false);
    expect(w.followRoute([{ x: NaN, z: 0 }])).toBe(false);
    expect(w.walking).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Lane passing (two walkers meeting on the same street)
// ---------------------------------------------------------------------------

describe("sim/walker passingAdjust (pure)", () => {
  const heading = { x: 1, z: 0 }; // walking +x; own right is -z

  it("is zero with nobody ahead (beside, behind, or out of range)", () => {
    expect(passingAdjust({ x: 0, z: 0 }, heading, [])).toEqual({ x: 0, z: 0, slow: 1 });
    const behind = passingAdjust({ x: 0, z: 0 }, heading, [{ x: -1, z: 0 }]);
    expect(behind).toEqual({ x: 0, z: 0, slow: 1 });
    const beside = passingAdjust({ x: 0, z: 0 }, heading, [{ x: 0, z: 0.8 }], { radius: 1.6 });
    expect(beside).toEqual({ x: 0, z: 0, slow: 1 });
    const far = passingAdjust({ x: 0, z: 0 }, heading, [{ x: 5, z: 0 }], { radius: 1.6 });
    expect(far).toEqual({ x: 0, z: 0, slow: 1 });
  });

  it("someone ahead biases to the walker's own right and slows it", () => {
    const p = passingAdjust({ x: 0, z: 0 }, heading, [{ x: 1, z: 0 }], { radius: 1.6 });
    expect(p.z).toBeLessThan(0); // right of +x is -z
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.slow).toBeLessThan(1);
    expect(p.slow).toBeGreaterThanOrEqual(0.3); // slows, never stops dead
    // the opposite walker drifts to ITS right (the other world side)
    const q = passingAdjust({ x: 1, z: 0 }, { x: -1, z: 0 }, [{ x: 0, z: 0 }], { radius: 1.6 });
    expect(q.z).toBeGreaterThan(0);
  });

  it("closer encounters push and slow harder; garbage neighbors are ignored", () => {
    const near = passingAdjust({ x: 0, z: 0 }, heading, [{ x: 0.4, z: 0 }], { radius: 1.6 });
    const far = passingAdjust({ x: 0, z: 0 }, heading, [{ x: 1.4, z: 0 }], { radius: 1.6 });
    expect(Math.abs(near.z)).toBeGreaterThan(Math.abs(far.z));
    expect(near.slow).toBeLessThan(far.slow);
    const junk = passingAdjust({ x: 0, z: 0 }, heading, [null, { x: NaN, z: 0 }]);
    expect(junk).toEqual({ x: 0, z: 0, slow: 1 });
  });
});

describe("sim/walker head-on lane pass (no jitter, no overlap, on the lane)", () => {
  it("two walkers sharing a lane slow, pass laterally, and both arrive", () => {
    let wA = null;
    let wB = null;
    wA = createWalker({
      position: { x: -6, z: 0 },
      speed: 1.6,
      arriveRadius: 0.2,
      neighbors: () => [wB.position],
      random: () => 0.5,
    });
    wB = createWalker({
      position: { x: 6, z: 0 },
      speed: 1.6,
      arriveRadius: 0.2,
      neighbors: () => [wA.position],
      random: () => 0.5,
    });
    wA.followRoute([{ x: 6, z: 0 }]);
    wB.followRoute([{ x: -6, z: 0 }]);

    let arrivedA = false;
    let arrivedB = false;
    let minGap = Infinity;
    let maxOffLane = 0;
    for (let i = 0; i < 1800 && !(arrivedA && arrivedB); i++) {
      arrivedA = arrivedA || wA.update(1 / 60).some((e) => e.type === "arrive");
      arrivedB = arrivedB || wB.update(1 / 60).some((e) => e.type === "arrive");
      minGap = Math.min(
        minGap,
        Math.hypot(wA.position.x - wB.position.x, wA.position.z - wB.position.z),
      );
      maxOffLane = Math.max(maxOffLane, Math.abs(wA.position.z), Math.abs(wB.position.z));
    }
    expect(arrivedA).toBe(true); // neither got stuck pushing the other
    expect(arrivedB).toBe(true);
    expect(minGap).toBeGreaterThan(0.3); // no standing overlap mid-pass
    expect(maxOffLane).toBeLessThanOrEqual(0.75); // the pass stays inside the lane
  });

  it("the pass is deterministic (same run twice, same trace)", () => {
    const runOnce = () => {
      let wA = null;
      let wB = null;
      wA = createWalker({
        position: { x: -6, z: 0 },
        speed: 1.6,
        arriveRadius: 0.2,
        neighbors: () => [wB.position],
        random: () => 0.5,
      });
      wB = createWalker({
        position: { x: 6, z: 0 },
        speed: 1.6,
        arriveRadius: 0.2,
        neighbors: () => [wA.position],
        random: () => 0.5,
      });
      wA.followRoute([{ x: 6, z: 0 }]);
      wB.followRoute([{ x: -6, z: 0 }]);
      for (let i = 0; i < 900; i++) {
        wA.update(1 / 60);
        wB.update(1 / 60);
      }
      return [{ ...wA.position }, { ...wB.position }];
    };
    expect(runOnce()).toEqual(runOnce());
  });
});

// ---------------------------------------------------------------------------
// Stall watchdog (wedged walkers re-route instead of freezing)
// ---------------------------------------------------------------------------

describe("sim/walker stall watchdog", () => {
  it("a wander walk wedged against a hard obstacle stalls out and re-plans", () => {
    let samples = 0;
    const w = createWalker({
      position: { x: 0, z: 0.05 },
      speed: 2,
      arriveRadius: 0.2,
      pauseRange: [0.1, 0.1],
      stallSeconds: 1.5,
      obstacles: [{ x: 4, z: 0, r: 1.2 }],
      sampleRoute: () => {
        samples++;
        // hostile planner: the destination sits INSIDE the obstacle
        return [{ x: 4, z: 0 }];
      },
      random: () => 0.5,
    });
    const stalls = [];
    let departsAfterStall = 0;
    for (let i = 0; i < 1200; i++) {
      for (const ev of w.update(1 / 60)) {
        if (ev.type === "stall") stalls.push(ev);
        if (ev.type === "depart" && stalls.length) departsAfterStall++;
      }
      expect(Number.isFinite(w.position.x)).toBe(true);
    }
    expect(stalls.length).toBeGreaterThan(0); // it noticed the wedge
    expect(stalls[0].target).toEqual({ x: 4, z: 0 });
    expect(departsAfterStall).toBeGreaterThan(0); // and re-routed afterwards
    expect(samples).toBeGreaterThan(1);
  });

  it("an unreachable INTERMEDIATE waypoint is skipped, the route still completes", () => {
    const w = createWalker({
      position: { x: 0, z: 0.05 },
      speed: 2,
      arriveRadius: 0.2,
      stallSeconds: 1.2,
      obstacles: [{ x: 4, z: 0, r: 1.0 }],
      random: () => 0.5,
    });
    // the middle waypoint sits inside the obstacle; the end is clear
    w.followRoute([
      { x: 4, z: 0 },
      { x: 9, z: 0 },
    ]);
    let arrived = false;
    for (let i = 0; i < 3000 && !arrived; i++) {
      arrived = w.update(1 / 60).some((e) => e.type === "arrive" && e.goal);
    }
    expect(arrived).toBe(true);
    expect(w.position.x).toBeCloseTo(9, 5);
  });

  it("goal walks are never abandoned by the watchdog", () => {
    const w = createWalker({
      position: { x: 0, z: 0.05 },
      speed: 2,
      arriveRadius: 0.2,
      stallSeconds: 1.0,
      obstacles: [{ x: 4, z: 0, r: 1.2 }],
    });
    w.goto({ x: 4, z: 0 }); // unreachable goal (a door would never be)
    const events = [];
    for (let i = 0; i < 600; i++) events.push(...w.update(1 / 60));
    expect(events.some((e) => e.type === "stall")).toBe(false);
    expect(w.walking).toBe(true); // still trying, still finite
    expect(Number.isFinite(w.position.x)).toBe(true);
  });
});
