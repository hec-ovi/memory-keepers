// Overworld behavior helpers (pure, no WebGL): the selection ring's render
// layering over street ribbons (BACKLOG 5), the global chatter gate while
// someone walks home (BACKLOG 4), and raycast pick resolution for the
// house-click-selects-owner behavior (BACKLOG 13).
import { describe, it, expect } from "vitest";
import {
  SELECTION_RING,
  chatterPausedFor,
  resolvePickTarget,
  clickOutcome,
  SLEEP_TIMING,
} from "../src/render/scene_overworld.js";
import { buildStreetRibbon } from "../src/render/props.js";

describe("SELECTION_RING (always ON the path, never under it)", () => {
  const ribbon = buildStreetRibbon({
    points: [
      { x: 0, z: 0 },
      { x: 3, z: 0 },
      { x: 6, z: 0 },
    ],
    world: { heightAt: () => 0, nightMaskAt: () => 0 },
  });

  it("renders AFTER the street ribbons (higher renderOrder)", () => {
    expect(SELECTION_RING.renderOrder).toBeGreaterThan(ribbon.renderOrder);
  });

  it("biases deeper than the ribbons so it never z-fights them", () => {
    expect(ribbon.material.polygonOffset).toBe(true);
    expect(SELECTION_RING.polygonOffsetFactor).toBeLessThan(ribbon.material.polygonOffsetFactor);
    expect(SELECTION_RING.polygonOffsetUnits).toBeLessThan(ribbon.material.polygonOffsetUnits);
  });

  it("sits above the street lift so the depth test also favors it", () => {
    // ribbons drape at heightAt + 0.05; the ring rides higher
    expect(SELECTION_RING.lift).toBeGreaterThan(0.05);
    expect(SELECTION_RING.inner).toBeLessThan(SELECTION_RING.outer);
  });
});

describe("chatterPausedFor (no bubbles while anyone walks home)", () => {
  it("pauses for the whole join cinematic", () => {
    expect(chatterPausedFor({ cinematicActive: true })).toBe(true);
    expect(chatterPausedFor({ cinematicActive: true, sleepPhases: [] })).toBe(true);
  });

  it("pauses while any sleep walk is under way, resumes after arrival", () => {
    expect(chatterPausedFor({ sleepPhases: ["walking"] })).toBe(true);
    expect(chatterPausedFor({ sleepPhases: ["idle", "walking", "dreaming"] })).toBe(true);
    // arrived: entering / dreaming / waking no longer gate the bubbles
    expect(chatterPausedFor({ sleepPhases: ["entering"] })).toBe(false);
    expect(chatterPausedFor({ sleepPhases: ["dreaming", "waking"] })).toBe(false);
  });

  it("is quiet-by-default-free: nothing running means chatter flows", () => {
    expect(chatterPausedFor()).toBe(false);
    expect(chatterPausedFor({})).toBe(false);
    expect(chatterPausedFor({ cinematicActive: false, sleepPhases: [] })).toBe(false);
  });
});

describe("resolvePickTarget (house click selects the owner)", () => {
  // Minimal object-graph stand-ins for three.js nodes.
  const node = (userData = {}, parent = null, visible = true) => ({
    userData,
    parent,
    visible,
  });

  it("a door mesh resolves to its own door pick", () => {
    const house = node({ pick: "house", keeperId: "dreams" });
    const door = node({ pick: "door", keeperId: "dreams" }, house);
    expect(resolvePickTarget(door)).toEqual({ pick: "door", keeperId: "dreams" });
  });

  it("any other cottage part bubbles up to the house pick (select the owner)", () => {
    const house = node({ pick: "house", keeperId: "dreams" });
    const roof = node({}, house);
    const flag = node({}, roof); // nested parts bubble too
    expect(resolvePickTarget(roof)).toEqual({ pick: "house", keeperId: "dreams" });
    expect(resolvePickTarget(flag)).toEqual({ pick: "house", keeperId: "dreams" });
  });

  it("keeper body meshes resolve to the keeper pick", () => {
    const group = node({});
    const body = node({ pick: "keeper", keeperId: "music" }, group);
    expect(resolvePickTarget(body)).toEqual({ pick: "keeper", keeperId: "music" });
  });

  it("hidden targets and pickless chains resolve to null", () => {
    const house = node({ pick: "house", keeperId: "dreams" }, null, false);
    const wall = node({}, house);
    expect(resolvePickTarget(wall)).toBeNull(); // hidden ancestor
    const hiddenLeaf = node({ pick: "door", keeperId: "x" }, node({}), false);
    expect(resolvePickTarget(hiddenLeaf)).toBeNull();
    expect(resolvePickTarget(node({}))).toBeNull(); // nothing pickable
    expect(resolvePickTarget(null)).toBeNull();
  });

  it("missing keeperId reads as null, never undefined", () => {
    const thing = node({ pick: "house" });
    expect(resolvePickTarget(thing).keeperId).toBeNull();
  });
});

describe("clickOutcome (what a click means for selection)", () => {
  it("her body or her cottage selects; the door enters", () => {
    expect(clickOutcome({ pick: "keeper", keeperId: "dreams" })).toEqual({
      type: "select",
      keeperId: "dreams",
    });
    expect(clickOutcome({ pick: "house", keeperId: "dreams" }, "music")).toEqual({
      type: "select",
      keeperId: "dreams",
    });
    expect(clickOutcome({ pick: "door", keeperId: "dreams" }, "dreams")).toEqual({
      type: "enter",
      keeperId: "dreams",
    });
  });

  it("clicking elsewhere deselects the selected keeper", () => {
    expect(clickOutcome(null, "dreams")).toEqual({ type: "deselect", keeperId: "dreams" });
  });

  it("clicking elsewhere with nobody selected does nothing", () => {
    expect(clickOutcome(null, null)).toBeNull();
    expect(clickOutcome(null)).toBeNull();
  });

  it("an unknown pick kind changes nothing, even while selected", () => {
    expect(clickOutcome({ pick: "mystery", keeperId: "x" }, "dreams")).toBeNull();
  });
});

describe("SLEEP_TIMING dream dwell", () => {
  it("keeps the dream visible for 2 to 3 seconds even on an instant backend", () => {
    expect(SLEEP_TIMING.minDreamS).toBeGreaterThanOrEqual(2);
    expect(SLEEP_TIMING.minDreamS).toBeLessThanOrEqual(3);
  });
});
