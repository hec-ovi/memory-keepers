// The sleep-choreography state machine as a pure timeline (no WebGL, no
// DOM): walk home -> inside (entering) -> dreaming -> rested -> wake -> done,
// the at-door variant, rested-before-inside pending, cancel, plus the
// sleepGlow / dreamWisp effect math.
import { describe, it, expect } from "vitest";
import {
  createSleepTimeline,
  SLEEP_TIMING,
  sleepGlow,
  dreamWisp,
} from "../src/render/scene_overworld.js";

// Run the timeline forward, collecting events, until `seconds` elapse.
function run(timeline, seconds, dt = 0.1) {
  const events = [];
  for (let t = 0; t < seconds; t += dt) events.push(...timeline.update(dt));
  return events;
}

describe("createSleepTimeline (pure)", () => {
  it("plays the full flow: walk -> inside -> dreaming -> rested -> wake -> done", () => {
    const tl = createSleepTimeline();
    expect(tl.phase).toBe("idle");
    expect(tl.active).toBe(false);

    expect(tl.start()).toEqual(["started", "walk"]);
    expect(tl.phase).toBe("walking");
    expect(run(tl, 10)).toEqual([]); // walking has no clock; the walker drives it

    expect(tl.arrive()).toEqual(["enter"]);
    expect(tl.phase).toBe("entering");
    expect(run(tl, SLEEP_TIMING.enterS + 0.2)).toEqual(["dream"]);
    expect(tl.phase).toBe("dreaming");
    expect(run(tl, 30)).toEqual([]); // she dreams until the job finishes

    expect(tl.rested()).toEqual(["wake"]);
    expect(tl.phase).toBe("waking");
    expect(run(tl, SLEEP_TIMING.wakeS + 0.2)).toEqual(["done"]);
    expect(tl.phase).toBe("idle"); // reusable for the next nap
  });

  it("a walk home that never arrives enters where she stands once walkS is spent", () => {
    const tl = createSleepTimeline({ walkS: 3, enterS: 0.5, minDreamS: 1 });
    expect(tl.start()).toEqual(["started", "walk"]);
    expect(tl.update(2.9)).toEqual([]);
    expect(tl.phase).toBe("walking");
    expect(tl.update(0.2)).toEqual(["enter"]);
    expect(tl.phase).toBe("entering");
    expect(tl.arrive()).toEqual([]); // the late arrival means nothing now
    expect(tl.update(0.6)).toEqual(["dream"]);
  });

  it("at-door variant skips the walk", () => {
    const tl = createSleepTimeline({ enterS: 0.5 });
    expect(tl.start({ atDoor: true })).toEqual(["started", "enter"]);
    expect(tl.phase).toBe("entering");
    expect(run(tl, 0.7)).toEqual(["dream"]);
    expect(tl.phase).toBe("dreaming");
  });

  it("rested while still walking home is remembered: wake fires after the dream dwell", () => {
    const tl = createSleepTimeline({ enterS: 0.4 });
    tl.start();
    expect(tl.rested()).toEqual([]); // still walking: nothing to wake yet
    expect(tl.phase).toBe("walking");

    tl.arrive();
    expect(run(tl, 0.6)).toEqual(["dream"]); // inside; the dream must dwell
    expect(tl.phase).toBe("dreaming");
    expect(run(tl, SLEEP_TIMING.minDreamS + 0.2)).toEqual(["wake"]);
    expect(tl.phase).toBe("waking");
    expect(run(tl, SLEEP_TIMING.wakeS + 0.2)).toEqual(["done"]);
  });

  it("rested while entering is remembered too (wake still waits out the dwell)", () => {
    const tl = createSleepTimeline({ enterS: 0.4 });
    tl.start({ atDoor: true });
    run(tl, 0.2); // mid door-fade
    expect(tl.rested()).toEqual([]);
    expect(run(tl, 0.4)).toEqual(["dream"]);
    expect(run(tl, SLEEP_TIMING.minDreamS + 0.2)).toEqual(["wake"]);
  });

  it("always dreams visibly for minDreamS, even when the job is instant", () => {
    const tl = createSleepTimeline({ enterS: 0.2, minDreamS: 2 });
    tl.start({ atDoor: true });
    expect(run(tl, 0.4)).toEqual(["dream"]);
    expect(tl.rested()).toEqual([]); // too soon: the dwell is not served yet
    expect(tl.phase).toBe("dreaming");
    expect(run(tl, 1.2)).toEqual([]); // still dreaming (about 1.5s in)
    expect(run(tl, 0.8)).toEqual(["wake"]); // dwell served: now she wakes
    expect(tl.phase).toBe("waking");
  });

  it("rested after the dwell wakes immediately", () => {
    const tl = createSleepTimeline({ enterS: 0.2, minDreamS: 1 });
    tl.start({ atDoor: true });
    run(tl, 0.4); // dream
    run(tl, 1.2); // dwell served, job still running
    expect(tl.rested()).toEqual(["wake"]);
  });

  it("ignores a second start while running, and rested when idle/waking", () => {
    const tl = createSleepTimeline();
    expect(tl.rested()).toEqual([]); // idle: nothing happens
    tl.start();
    expect(tl.start()).toBe(null);
    expect(tl.start({ atDoor: true })).toBe(null);
    tl.arrive();
    run(tl, SLEEP_TIMING.enterS + SLEEP_TIMING.minDreamS + 0.4);
    tl.rested();
    expect(tl.phase).toBe("waking");
    expect(tl.rested()).toEqual([]); // already waking: no double wake
  });

  it("arrive only means something while walking", () => {
    const tl = createSleepTimeline();
    expect(tl.arrive()).toEqual([]); // idle
    tl.start({ atDoor: true });
    expect(tl.arrive()).toEqual([]); // entering
    run(tl, SLEEP_TIMING.enterS + 0.2);
    expect(tl.arrive()).toEqual([]); // dreaming
  });

  it("cancel aborts without firing wake/done, and the timeline is reusable", () => {
    const tl = createSleepTimeline();
    tl.start();
    tl.arrive();
    tl.cancel();
    expect(tl.phase).toBe("idle");
    expect(run(tl, 5)).toEqual([]); // nothing ever fires

    expect(tl.start({ atDoor: true })).toEqual(["started", "enter"]); // fresh run
    run(tl, SLEEP_TIMING.enterS + SLEEP_TIMING.minDreamS + 0.4);
    tl.rested();
    expect(run(tl, SLEEP_TIMING.wakeS + 0.2)).toEqual(["done"]);
  });

  it("cancel drops a pending rested", () => {
    const tl = createSleepTimeline();
    tl.start();
    tl.rested(); // pending
    tl.cancel();
    tl.start({ atDoor: true });
    // no stale wake, not even after the dream dwell would have been served
    expect(run(tl, SLEEP_TIMING.enterS + SLEEP_TIMING.minDreamS + 0.4)).toEqual(["dream"]);
  });
});

describe("sleepGlow (dream-effect intensity)", () => {
  const timing = { enterS: 1, wakeS: 2 };

  it("ramps in while entering, holds while dreaming, fades while waking", () => {
    expect(sleepGlow("entering", 0, timing)).toBe(0);
    expect(sleepGlow("entering", 0.5, timing)).toBeCloseTo(0.5);
    expect(sleepGlow("entering", 5, timing)).toBe(1); // clamped
    expect(sleepGlow("dreaming", 123, timing)).toBe(1);
    expect(sleepGlow("waking", 0, timing)).toBe(1);
    expect(sleepGlow("waking", 1, timing)).toBeCloseTo(0.5);
    expect(sleepGlow("waking", 9, timing)).toBe(0); // clamped
  });

  it("is 0 in idle and walking", () => {
    expect(sleepGlow("idle", 3, timing)).toBe(0);
    expect(sleepGlow("walking", 3, timing)).toBe(0);
  });
});

describe("dreamWisp", () => {
  it("rises over the loop and never pops: opacity ~0 at both ends", () => {
    expect(dreamWisp(0).y).toBe(0);
    expect(dreamWisp(0).opacity).toBeCloseTo(0, 5);
    expect(dreamWisp(0.9999).opacity).toBeCloseTo(0, 3);
    expect(dreamWisp(0.5).opacity).toBeGreaterThan(0.4);
    expect(dreamWisp(0.5).y).toBeCloseTo(0.65);
    expect(dreamWisp(0.5, { rise: 2 }).y).toBeCloseTo(1);
  });

  it("wraps u and grows monotonically in scale across the loop", () => {
    expect(dreamWisp(1.25)).toEqual(dreamWisp(0.25));
    expect(dreamWisp(-0.75)).toEqual(dreamWisp(0.25));
    let prev = -Infinity;
    for (let i = 0; i < 10; i++) {
      const s = dreamWisp(i / 10).scale;
      expect(s).toBeGreaterThan(prev);
      prev = s;
    }
  });
});
