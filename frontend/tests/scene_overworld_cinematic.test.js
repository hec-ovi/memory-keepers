// The join-cinematic state machine as a pure timeline (no WebGL, no DOM):
// started -> walking -> arrived (pause + push) -> fade -> enter, the mini
// variant (keeper already at home), and skip from every state.
import { describe, it, expect } from "vitest";
import { createCinematicTimeline, CINEMATIC_TIMING } from "../src/render/scene_overworld.js";

// Run the timeline forward, collecting events, until `seconds` elapse.
function run(timeline, seconds, dt = 0.1) {
  const events = [];
  for (let t = 0; t < seconds; t += dt) events.push(...timeline.update(dt));
  return events;
}

describe("createCinematicTimeline (pure)", () => {
  it("plays the full flow: started -> walking -> arrived -> push -> fade -> enter", () => {
    const tl = createCinematicTimeline();
    expect(tl.phase).toBe("idle");
    expect(tl.active).toBe(false);

    expect(tl.start()).toEqual(["started", "walk"]);
    expect(tl.phase).toBe("walking");
    expect(tl.active).toBe(true);
    expect(run(tl, 10)).toEqual([]); // walking has no clock; the walker drives it

    expect(tl.arrive()).toEqual(["arrived"]);
    expect(tl.phase).toBe("arrived");

    const { pauseS, pushS, fadeS } = CINEMATIC_TIMING;
    const events = run(tl, pauseS + pushS + fadeS + 0.5);
    expect(events).toEqual(["push", "fade", "enter"]);
    expect(tl.phase).toBe("idle"); // ready for the next join
  });

  it("holds the pause beat before the push", () => {
    const tl = createCinematicTimeline({ pauseS: 1, pushS: 1, fadeS: 1 });
    tl.start();
    tl.arrive();
    expect(run(tl, 0.9)).toEqual([]); // still the quiet beat at the door
    expect(run(tl, 0.3)).toEqual(["push"]);
    expect(run(tl, 0.9)).toEqual(["fade"]);
    expect(tl.phase).toBe("fade");
    expect(run(tl, 1.1)).toEqual(["enter"]);
  });

  it("plays the mini version for an keeper already at home: pan -> fade -> enter", () => {
    const tl = createCinematicTimeline({ panS: 1, fadeS: 0.5 });
    expect(tl.start({ mini: true })).toEqual(["started", "pan"]);
    expect(tl.phase).toBe("pan");
    const events = run(tl, 2);
    expect(events).toEqual(["fade", "enter"]);
    expect(tl.phase).toBe("idle");
  });

  it("ignores a second start while a cinematic is playing", () => {
    const tl = createCinematicTimeline();
    tl.start();
    expect(tl.start()).toBe(null);
    expect(tl.start({ mini: true })).toBe(null);
    expect(tl.phase).toBe("walking");

    tl.arrive();
    expect(tl.start()).toBe(null);
    expect(tl.phase).toBe("arrived");
  });

  it("skip jumps straight to the fade from any active state", () => {
    for (const setup of [
      (tl) => tl.start(), // walking
      (tl) => {
        tl.start();
        tl.arrive();
      }, // arrived
      (tl) => tl.start({ mini: true }), // pan
    ]) {
      const tl = createCinematicTimeline();
      setup(tl);
      expect(tl.skip()).toEqual(["fade"]);
      expect(tl.phase).toBe("fade");
      expect(run(tl, CINEMATIC_TIMING.fadeS + 0.2)).toEqual(["enter"]); // same fade, same enter
    }
  });

  it("skip is inert while already fading, when idle, and after enter", () => {
    const tl = createCinematicTimeline();
    expect(tl.skip()).toEqual([]); // idle

    tl.start({ mini: true });
    tl.skip();
    expect(tl.skip()).toEqual([]); // already fading: no restart
    expect(tl.phase).toBe("fade");

    run(tl, CINEMATIC_TIMING.fadeS + 0.2); // enter fired
    expect(tl.skip()).toEqual([]); // idle again
  });

  it("arrive only means something while walking", () => {
    const tl = createCinematicTimeline();
    expect(tl.arrive()).toEqual([]); // idle
    tl.start({ mini: true });
    expect(tl.arrive()).toEqual([]); // pan
    tl.skip();
    expect(tl.arrive()).toEqual([]); // fade
    expect(tl.phase).toBe("fade");
  });

  it("cancel aborts without firing enter, and the timeline is reusable", () => {
    const tl = createCinematicTimeline();
    tl.start();
    tl.cancel();
    expect(tl.phase).toBe("idle");
    expect(run(tl, 5)).toEqual([]); // nothing ever fires

    expect(tl.start()).toEqual(["started", "walk"]); // fresh run works
    tl.arrive();
    const events = run(tl, 10);
    expect(events).toEqual(["push", "fade", "enter"]);
  });
});
