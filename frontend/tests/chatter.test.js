import { describe, it, expect } from "vitest";
import { createChatter } from "../src/sim/chatter.js";

// random=()=>0 makes jitter deterministic (always the low bound) and the pick
// always the first candidate.
const mk = (over = {}) =>
  createChatter({
    cooldownS: 20,
    globalGapS: 6,
    bubbleS: 4.5,
    jitterS: [1, 1],
    random: () => 0,
    ...over,
  });

describe("sim/chatter", () => {
  it("waits out the jitter, then picks a visible keeper", () => {
    const c = mk();
    expect(c.update(0.5, ["a"])).toBeNull();
    expect(c.update(0.5, ["a"])).toEqual({ keeperId: "a" });
  });

  it("returns null with nobody on screen and tolerates invalid dt", () => {
    const c = mk();
    expect(c.update(NaN, ["a"])).toBeNull(); // invalid dt advances nothing
    expect(c.update(5, [])).toBeNull(); // jitter elapsed but empty screen
    expect(c.update(5, ["a"])).toEqual({ keeperId: "a" });
  });

  it("no overlap: silent while a bubble is up, then a global gap", () => {
    const c = mk();
    c.update(1, ["a", "b"]); // "a" speaks (first candidate)
    expect(c.speaking).toBe("a");
    // Bubble up (4.5s) + global gap (6s) = 10.5s of enforced silence.
    expect(c.update(4, ["b"])).toBeNull(); // bubble still up
    expect(c.speaking).toBe("a");
    expect(c.update(4, ["b"])).toBeNull(); // gap running
    expect(c.speaking).toBeNull();
    expect(c.update(2.5, ["b"])).toEqual({ keeperId: "b" }); // 10.5s total
  });

  it("per-keeper cooldown: a lone keeper cannot speak again early", () => {
    const c = mk();
    c.update(1, ["a"]);
    expect(c.update(10.5, ["a"])).toBeNull(); // gap over, but cooldown (20s) not
    expect(c.update(8, ["a"])).toBeNull(); // 18.5s since speak, still cooling
    expect(c.update(2, ["a"])).toEqual({ keeperId: "a" }); // 20.5s: eligible again
  });

  it("never repeats the same keeper when someone else is eligible", () => {
    const c = mk();
    expect(c.update(1, ["a", "b"])).toEqual({ keeperId: "a" });
    expect(c.update(11, ["a", "b"])).toEqual({ keeperId: "b" });
    // Both cool down; when both eligible again, last speaker (b) is excluded.
    expect(c.update(30, ["a", "b"])).toEqual({ keeperId: "a" });
  });

  it("re-jitters after a blocked opportunity instead of hammering", () => {
    const c = mk({ jitterS: [2, 2] });
    c.update(2, ["a"]); // speaks
    c.update(20.5, ["a"]); // wait+gap+cooldown elapsed? cooldown had 20-20.5<0 -> eligible...
    // The call above may speak; force a blocked opportunity:
    const c2 = mk({ jitterS: [2, 2], cooldownS: 100 });
    expect(c2.update(2, ["a"])).toEqual({ keeperId: "a" });
    expect(c2.update(50, ["a"])).toBeNull(); // blocked by cooldown, re-jitters
    // Immediately after, still waiting on the fresh jitter:
    expect(c2.update(1, ["a"])).toBeNull();
  });

  it("extendBubble stretches the no-overlap window", () => {
    const c = mk();
    c.update(1, ["a", "b"]);
    c.extendBubble(10); // scene learned the real bubble length
    expect(c.speaking).toBe("a");
    expect(c.update(9, ["b"])).toBeNull(); // would have been free at 4.5+6
    expect(c.speaking).toBe("a"); // still up under the extended window
    expect(c.update(8, ["b"])).toEqual({ keeperId: "b" }); // 10 + 6 + 1 elapsed
  });

  it("reset clears cooldowns and the active bubble", () => {
    const c = mk();
    c.update(1, ["a"]);
    c.reset();
    expect(c.speaking).toBeNull();
    expect(c.update(1, ["a"])).toEqual({ keeperId: "a" });
  });
});
