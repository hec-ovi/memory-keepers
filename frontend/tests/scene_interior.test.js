// Pure-helper tests for the interior scene (no DOM/WebGL: the three.js scene
// itself is exempt per the frontend spec, its math is not), plus a headless
// end-to-end run of the sit/fetch choreography (the scene runs without a
// renderer, so the whole book-fetch flow is drivable under jsdom).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBus } from "../src/bus.js";
import {
  createInteriorScene,
  spineColorFromTags,
  BOOK_TIERS,
  bookTier,
  tierSizing,
  shelfSlot,
  shelfCapacity,
  LIBRARY_CAP,
  SHELF_LAYOUT,
  CHAIR_POS,
  CHAIR_ANGLE,
  SECOND_CHAIR,
  CHAIRS_POSE,
  contrastInk,
  spineLabelSpec,
  scaleSpineSpec,
  SIT_FETCH,
  nextKeeperState,
  runKeeperTimeline,
  hopArc,
  labelPlacement,
  INTERIOR_VIEWS,
  VIEW_TWEEN_SECONDS,
  createViewMachine,
  viewRequest,
  viewStep,
  viewIsTweening,
  pickAction,
  projectedSizePx,
  shelfFontRatio,
  shelfLabelSizing,
  shelfViewFraming,
  DOZE,
  nextDozeState,
  runDozeTimeline,
} from "../src/render/scene_interior.js";
import * as THREE from "three";
import { dreamsKeeper, flyingBook, tideBook } from "./ui_fixtures.js";

describe("spineColorFromTags", () => {
  it("returns a #rrggbb hex string", () => {
    expect(spineColorFromTags(["flying", "ocean"])).toMatch(/^#[0-9a-f]{6}$/);
    expect(spineColorFromTags([])).toMatch(/^#[0-9a-f]{6}$/);
    expect(spineColorFromTags()).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("is deterministic and tag-order-insensitive", () => {
    const a = spineColorFromTags(["flying", "ocean"]);
    expect(spineColorFromTags(["flying", "ocean"])).toBe(a);
    expect(spineColorFromTags(["ocean", "flying"])).toBe(a);
    expect(spineColorFromTags([" Ocean ", "FLYING"])).toBe(a); // normalized
  });

  it("gives different tag sets different colors", () => {
    expect(spineColorFromTags(["flying", "ocean"])).not.toBe(spineColorFromTags(["meetings"]));
    expect(spineColorFromTags(["dreams"])).not.toBe(spineColorFromTags(["films"]));
  });
});

describe("book size tiers (bookTier + tierSizing)", () => {
  it("trusts the engine's tier field when present", () => {
    for (const tier of BOOK_TIERS) {
      expect(bookTier({ tier, one_liner: "x".repeat(200) })).toBe(tier);
    }
  });

  it("falls back to the one_liner length for payloads without a tier", () => {
    expect(bookTier({})).toBe("small");
    expect(bookTier({ one_liner: "a dream" })).toBe("small");
    expect(bookTier({ one_liner: "a dream about gliding over a black ocean" })).toBe("medium");
    expect(bookTier({ one_liner: "x".repeat(80) })).toBe("big");
    expect(bookTier({ one_liner: "x".repeat(140) })).toBe("large");
    expect(bookTier({ tier: "gigantic", one_liner: "" })).toBe("small"); // junk tier -> fallback
  });

  it("each tier is strictly thicker and taller than the one below", () => {
    const sizes = BOOK_TIERS.map((t) => tierSizing(t));
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i].thickness).toBeGreaterThan(sizes[i - 1].thickness);
      expect(sizes[i].height).toBeGreaterThan(sizes[i - 1].height);
    }
  });

  it("unknown tiers size as medium", () => {
    expect(tierSizing("nonsense")).toEqual(tierSizing("medium"));
  });
});

describe("shelfSlot", () => {
  const capacity = shelfCapacity();

  it("assigns every index below capacity a unique (wall, shelf, slot)", () => {
    const seen = new Set();
    for (let i = 0; i < capacity; i++) {
      const { wall, shelf, slot } = shelfSlot(i);
      seen.add(`${wall}/${shelf}/${slot}`);
      expect(wall).toBeGreaterThanOrEqual(0);
      expect(wall).toBeLessThan(SHELF_LAYOUT.walls);
      expect(shelf).toBeGreaterThanOrEqual(0);
      expect(shelf).toBeLessThan(SHELF_LAYOUT.shelvesPerWall);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(SHELF_LAYOUT.slotsPerShelf);
    }
    expect(seen.size).toBe(capacity);
  });

  it("keeps books inside the shelf run and evenly spaced", () => {
    const step = SHELF_LAYOUT.shelfWidth / SHELF_LAYOUT.slotsPerShelf;
    for (let i = 0; i < SHELF_LAYOUT.slotsPerShelf; i++) {
      const { along } = shelfSlot(i);
      expect(along).toBeGreaterThan(-SHELF_LAYOUT.shelfWidth / 2);
      expect(along).toBeLessThan(SHELF_LAYOUT.shelfWidth / 2);
      if (i > 0) {
        expect(shelfSlot(i).along - shelfSlot(i - 1).along).toBeCloseTo(step);
      }
    }
  });

  it("fills a shelf before moving up, and wraps at the single case's capacity", () => {
    const perShelf = SHELF_LAYOUT.slotsPerShelf;
    const capacity = perShelf * SHELF_LAYOUT.shelvesPerWall * SHELF_LAYOUT.walls;
    expect(shelfSlot(0)).toMatchObject({ wall: 0, shelf: 0, slot: 0 });
    expect(shelfSlot(perShelf - 1)).toMatchObject({ wall: 0, shelf: 0, slot: perShelf - 1 });
    expect(shelfSlot(perShelf)).toMatchObject({ wall: 0, shelf: 1, slot: 0 });
    expect(shelfSlot(capacity)).toMatchObject({ wall: 0, shelf: 0, slot: 0 });
  });

  it("raises the shelf height with each shelf row", () => {
    const first = shelfSlot(0);
    const second = shelfSlot(SHELF_LAYOUT.slotsPerShelf);
    expect(second.y - first.y).toBeCloseTo(SHELF_LAYOUT.shelfGapY);
    expect(first.y).toBeCloseTo(SHELF_LAYOUT.firstShelfY);
  });

  it("wraps deterministically past capacity", () => {
    expect(shelfSlot(capacity)).toEqual(shelfSlot(0));
    expect(shelfSlot(capacity + 7)).toEqual(shelfSlot(7));
    expect(shelfSlot(3)).toEqual(shelfSlot(3));
  });

  it("supports custom layouts", () => {
    const layout = { walls: 1, shelvesPerWall: 2, slotsPerShelf: 4, shelfWidth: 2, shelfGapY: 1, firstShelfY: 0.5 };
    expect(shelfCapacity(layout)).toBe(8);
    expect(shelfSlot(5, layout)).toMatchObject({ wall: 0, shelf: 1, slot: 1 });
    expect(shelfSlot(0, layout).along).toBeCloseTo(-0.75);
  });

  it("slots a real library (fixture books) without collisions", () => {
    const shelfBooks = [flyingBook(), tideBook()];
    const slots = shelfBooks.map((_, i) => shelfSlot(i));
    const keys = new Set(slots.map((s) => `${s.wall}/${s.shelf}/${s.slot}`));
    expect(keys.size).toBe(shelfBooks.length);
    // every book's spine fits inside its slot, whatever its tier
    for (const [i, book] of shelfBooks.entries()) {
      const { thickness } = tierSizing(bookTier(book));
      expect(thickness).toBeLessThanOrEqual(slots[i].step);
    }
  });
});

describe("library capacity (LIBRARY_CAP, BACKLOG 22)", () => {
  const step = SHELF_LAYOUT.shelfWidth / SHELF_LAYOUT.slotsPerShelf;

  it("the bookcases hold exactly 24 slots: shelfCapacity IS the library cap", () => {
    expect(LIBRARY_CAP).toBe(24);
    expect(shelfCapacity()).toBe(LIBRARY_CAP);
  });

  it("a full library stays inside the cases: every slot plus its book fits the run", () => {
    for (let i = 0; i < LIBRARY_CAP; i++) {
      const slot = shelfSlot(i);
      // slot center never overhangs the shelf run
      expect(Math.abs(slot.along) + slot.step / 2).toBeLessThanOrEqual(
        SHELF_LAYOUT.shelfWidth / 2 + 1e-9,
      );
      // even the fattest tome leaves air inside its slot
      expect(tierSizing("large").thickness).toBeLessThan(slot.step);
    }
  });

  it("tier thicknesses scale into the slot: thinner than the old fat band, large still fills most of it", () => {
    expect(tierSizing("small").thickness).toBeCloseTo(step * 0.2);
    expect(tierSizing("large").thickness).toBeCloseTo(step * 0.58);
    // the old band was 0.5..0.8 of the step; every tier now sits under its top
    for (const tier of BOOK_TIERS) {
      expect(tierSizing(tier).thickness).toBeLessThan(step * 0.8);
    }
  });
});

describe("facing chairs geometry (BACKLOG 10)", () => {
  const forward = (angle) => ({ x: Math.sin(angle), z: Math.cos(angle) });
  const norm = (v) => {
    const len = Math.hypot(v.x, v.z);
    return { x: v.x / len, z: v.z / len };
  };
  const dot = (a, b) => a.x * b.x + a.z * b.z;

  it("the two armchairs are angled toward one another", () => {
    const herToGuest = norm({ x: SECOND_CHAIR.x - CHAIR_POS.x, z: SECOND_CHAIR.z - CHAIR_POS.z });
    const guestToHer = norm({ x: CHAIR_POS.x - SECOND_CHAIR.x, z: CHAIR_POS.z - SECOND_CHAIR.z });
    // each chair faces the other within a cozy few degrees (never away)
    expect(dot(forward(CHAIR_ANGLE), herToGuest)).toBeGreaterThan(0.95);
    expect(dot(forward(SECOND_CHAIR.angle), guestToHer)).toBeGreaterThan(0.95);
  });

  it("the chairs camera sits in the guest chair and looks AT her", () => {
    // the camera seat is on the guest chair
    const seatDist = Math.hypot(CHAIRS_POSE.pos.x - SECOND_CHAIR.x, CHAIRS_POSE.pos.z - SECOND_CHAIR.z);
    expect(seatDist).toBeLessThan(0.6);
    // and its look target is her chair
    expect(CHAIRS_POSE.look.x).toBeCloseTo(CHAIR_POS.x, 1);
    expect(CHAIRS_POSE.look.z).toBeCloseTo(CHAIR_POS.z, 1);
  });

  it("she faces the camera from her chair", () => {
    const herToCamera = norm({
      x: CHAIRS_POSE.pos.x - CHAIR_POS.x,
      z: CHAIRS_POSE.pos.z - CHAIR_POS.z,
    });
    expect(dot(forward(CHAIR_ANGLE), herToCamera)).toBeGreaterThan(0.95);
  });
});

describe("contrastInk", () => {
  it("uses dark ink on light spines and paper ink on dark spines", () => {
    expect(contrastInk("#f2e9c8")).toBe("#2a1a33");
    expect(contrastInk("#ffffff")).toBe("#2a1a33");
    expect(contrastInk("#20182c")).toBe("#f6ecdf");
    expect(contrastInk("#000000")).toBe("#f6ecdf");
  });

  it("accepts numeric hex too", () => {
    expect(contrastInk(0xffffff)).toBe("#2a1a33");
    expect(contrastInk(0x111111)).toBe("#f6ecdf");
  });
});

describe("spineLabelSpec", () => {
  it("builds a deterministic spec from a real book", () => {
    const spec = spineLabelSpec(flyingBook(), { thickness: 0.12 });
    expect(spec).toEqual(spineLabelSpec(flyingBook(), { thickness: 0.12 }));
    expect(spec.text).toBe("Flying over water");
    expect(spec.bg).toBe(spineColorFromTags(flyingBook().tags));
    expect(spec.ink).toBe(contrastInk(spec.bg));
    expect(spec.w).toBeGreaterThan(0);
    expect(spec.h).toBeGreaterThan(spec.w); // spines are tall, not wide
    expect(spec.fontPx).toBeGreaterThanOrEqual(15);
  });

  it("scales the canvas width with spine thickness", () => {
    const thin = spineLabelSpec(tideBook(), { thickness: 0.05 });
    const thick = spineLabelSpec(tideBook(), { thickness: 0.16 });
    expect(thick.w).toBeGreaterThan(thin.w);
  });

  it("trims long titles with an ellipsis, keeps short ones whole", () => {
    const long = spineLabelSpec({ title: "a very long meandering memory ".repeat(6), tags: [] });
    expect(long.text.endsWith("…")).toBe(true);
    expect(long.text.length).toBeLessThan(60);
    const short = spineLabelSpec({ title: "Tea", tags: [] });
    expect(short.text).toBe("Tea");
  });

  it("falls back to the slug, then to 'untitled'", () => {
    expect(spineLabelSpec({ slug: "2026-07-01-x", tags: [] }).text).toBe("2026-07-01-x");
    expect(spineLabelSpec({ title: "  ", tags: [] }).text).toBe("untitled");
    expect(spineLabelSpec({}).text).toBe("untitled");
  });
});

describe("sit/fetch state machine", () => {
  it("plays a full fetch as a timeline: chair -> shelf -> float -> back to chair", () => {
    expect(runKeeperTimeline(["pick", "done", "arrived", "opened", "readerClosed", "arrived", "done"])).toEqual([
      "sitting",
      "hopOff",
      "walkToShelf",
      "grabbing",
      "waiting",
      "walkToChair",
      "hopOn",
      "sitting",
    ]);
  });

  it("starts sitting and ignores events that do not apply", () => {
    expect(SIT_FETCH.initial).toBe("sitting");
    expect(nextKeeperState("sitting", "readerClosed")).toBe("sitting");
    expect(nextKeeperState("sitting", "arrived")).toBe("sitting");
    expect(nextKeeperState("hopOn", "pick")).toBe("hopOn"); // finish the hop first
    expect(nextKeeperState("waiting", "nonsense")).toBe("waiting");
  });

  it("a pick while she is already out retargets the shelf walk", () => {
    expect(nextKeeperState("walkToShelf", "pick")).toBe("walkToShelf");
    expect(nextKeeperState("grabbing", "pick")).toBe("walkToShelf");
    expect(nextKeeperState("waiting", "pick")).toBe("walkToShelf");
    expect(nextKeeperState("walkToChair", "pick")).toBe("walkToShelf");
  });

  it("abort (book destroyed mid-fetch) sends her home", () => {
    expect(nextKeeperState("grabbing", "abort")).toBe("walkToChair");
    expect(nextKeeperState("waiting", "abort")).toBe("walkToChair");
    expect(runKeeperTimeline(["pick", "done", "arrived", "abort", "arrived", "done"]).at(-1)).toBe(
      "sitting",
    );
  });
});

describe("doze machine (interior sleep variant)", () => {
  it("plays the full nap as a timeline: awake -> settling -> dozing -> awake", () => {
    expect(runDozeTimeline(["sleep", "seated", "rested"])).toEqual([
      "awake",
      "settling",
      "dozing",
      "awake",
    ]);
  });

  it("rested while still settling wakes her without ever dozing", () => {
    expect(runDozeTimeline(["sleep", "rested"])).toEqual(["awake", "settling", "awake"]);
  });

  it("ignores events that do not apply", () => {
    expect(nextDozeState("awake", "seated")).toBe("awake");
    expect(nextDozeState("awake", "rested")).toBe("awake");
    expect(nextDozeState("dozing", "sleep")).toBe("dozing");
    expect(nextDozeState("dozing", "seated")).toBe("dozing");
    expect(nextDozeState("settling", "sleep")).toBe("settling");
    expect(nextDozeState("nonsense", "sleep")).toBe("nonsense");
    expect(DOZE.initial).toBe("awake");
  });
});

describe("hopArc", () => {
  const from = { x: 0.6, y: 0.86, z: -0.85 };
  const to = { x: 0.75, y: 0.52, z: 0 };

  it("hits both endpoints exactly", () => {
    expect(hopArc(from, to, 0)).toEqual(from);
    const end = hopArc(from, to, 1);
    expect(end.x).toBeCloseTo(to.x);
    expect(end.y).toBeCloseTo(to.y);
    expect(end.z).toBeCloseTo(to.z);
  });

  it("arcs above the straight line at the midpoint and clamps u", () => {
    const mid = hopArc(from, to, 0.5, 0.4);
    expect(mid.y).toBeCloseTo((from.y + to.y) / 2 + 0.4);
    expect(hopArc(from, to, -3)).toEqual(from);
    expect(hopArc(from, to, 9).y).toBeCloseTo(to.y);
  });
});

describe("labelPlacement", () => {
  const vp = { width: 800, height: 600 };

  it("maps NDC to pixels: center is center, corners clamp to the margin", () => {
    expect(labelPlacement({ x: 0, y: 0, z: 0.5 }, vp)).toEqual({ visible: true, left: 400, top: 300 });
    const corner = labelPlacement({ x: 1, y: 1, z: 0.5 }, { ...vp, margin: 12 });
    expect(corner).toEqual({ visible: true, left: 788, top: 12 });
  });

  it("hides points behind the camera or far outside the viewport", () => {
    expect(labelPlacement({ x: 0, y: 0, z: 1.2 }, vp).visible).toBe(false);
    expect(labelPlacement({ x: -4, y: 0, z: 0.5 }, vp).visible).toBe(false);
    expect(labelPlacement({ x: 0, y: 0, z: 0.5 }, { width: 0, height: 0 }).visible).toBe(false);
  });
});

describe("view machine (main | chairs | shelf)", () => {
  it("starts on main and accepts a request to another view", () => {
    const m = createViewMachine();
    expect(m.current).toBe("main");
    expect(viewIsTweening(m)).toBe(false);
    expect(viewRequest(m, "chairs")).toBe(true);
    expect(m.target).toBe("chairs");
    expect(viewIsTweening(m)).toBe(true);
  });

  it("rejects the current view, unknown views, and any request mid-tween", () => {
    const m = createViewMachine();
    expect(viewRequest(m, "main")).toBe(false);
    expect(viewRequest(m, "attic")).toBe(false);
    expect(viewRequest(m, "chairs")).toBe(true);
    // input ignored mid-tween
    expect(viewRequest(m, "shelf")).toBe(false);
    expect(viewRequest(m, "chairs")).toBe(false);
    expect(m.target).toBe("chairs");
  });

  it("steps with eased monotonic progress and settles after the duration", () => {
    const m = createViewMachine({ seconds: 0.8 });
    viewRequest(m, "shelf");
    const a = viewStep(m, 0.2);
    const b = viewStep(m, 0.2);
    expect(a.settled).toBe(false);
    expect(a.k).toBeGreaterThan(0);
    expect(b.k).toBeGreaterThan(a.k);
    expect(b.k).toBeCloseTo(0.5); // smoothstep midpoint
    const c = viewStep(m, 0.4);
    expect(c.settled).toBe(true);
    expect(c.k).toBe(1);
    expect(m.current).toBe("shelf");
    expect(m.target).toBeNull();
    // idle steps are inert
    expect(viewStep(m, 1).settled).toBe(false);
    expect(m.current).toBe("shelf");
  });

  it("force retargets mid-tween (programmatic reader jumps) but never to the same target", () => {
    const m = createViewMachine();
    viewRequest(m, "chairs");
    viewStep(m, 0.2);
    expect(viewRequest(m, "chairs", { force: true })).toBe(false);
    expect(viewRequest(m, "main", { force: true })).toBe(true);
    expect(m.target).toBe("main");
    viewStep(m, VIEW_TWEEN_SECONDS);
    expect(m.current).toBe("main");
  });

  it("walks a full journey across all three views", () => {
    const m = createViewMachine();
    const visited = [m.current];
    for (const view of ["chairs", "shelf", "main"]) {
      expect(viewRequest(m, view)).toBe(true);
      viewStep(m, VIEW_TWEEN_SECONDS);
      visited.push(m.current);
    }
    expect(visited).toEqual(["main", "chairs", "shelf", "main"]);
    expect(INTERIOR_VIEWS).toEqual(["main", "chairs", "shelf"]);
  });
});

describe("pickAction", () => {
  it("ignores everything mid-tween and empty hits", () => {
    expect(pickAction(null)).toBeNull();
    expect(pickAction({ slug: "x" }, { tweening: true })).toBeNull();
    expect(pickAction({ hotspot: "chair" }, { tweening: true })).toBeNull();
    expect(pickAction({ keeper: true }, { tweening: true })).toBeNull();
  });

  it("the keeper herself is clickable in every view (opens the talk panel)", () => {
    expect(pickAction({ keeper: true }, { view: "main" })).toEqual({ type: "keeper" });
    expect(pickAction({ keeper: true }, { view: "chairs" })).toEqual({ type: "keeper" });
    expect(pickAction({ keeper: true }, { view: "shelf" })).toEqual({ type: "keeper" });
  });

  it("books and the hint book win over hotspots in any view", () => {
    expect(pickAction({ slug: "2026-07-01-the-tide" }, { view: "shelf" })).toEqual({
      type: "pick",
      slug: "2026-07-01-the-tide",
    });
    expect(pickAction({ hint: true }, { view: "chairs" })).toEqual({ type: "hint" });
  });

  it("hotspots enter their view, except from that view itself", () => {
    expect(pickAction({ hotspot: "chair" }, { view: "main" })).toEqual({
      type: "view",
      view: "chairs",
    });
    expect(pickAction({ hotspot: "chair" }, { view: "chairs" })).toBeNull();
    expect(pickAction({ hotspot: "shelf", wall: 1 }, { view: "main" })).toEqual({
      type: "view",
      view: "shelf",
      wall: 1,
    });
    expect(pickAction({ hotspot: "shelf" }, { view: "chairs" })).toEqual({
      type: "view",
      view: "shelf",
      wall: 0,
    });
    expect(pickAction({ hotspot: "shelf", wall: 0 }, { view: "shelf" })).toBeNull();
  });
});

describe("shelf-view framing and label sizing", () => {
  it("projectedSizePx follows the pinhole model and guards degenerate input", () => {
    const px = projectedSizePx({ world: 0.46, distance: 2, fovDeg: 50, viewportH: 800 });
    expect(px).toBeCloseTo((800 * 0.46) / (2 * 2 * Math.tan((25 * Math.PI) / 180)), 5);
    // half the distance -> twice the pixels
    expect(projectedSizePx({ world: 0.46, distance: 1, fovDeg: 50, viewportH: 800 })).toBeCloseTo(
      px * 2,
      5,
    );
    expect(projectedSizePx({ distance: 0 })).toBe(0);
    expect(projectedSizePx({ viewportH: 0 })).toBe(0);
  });

  it("shelfFontRatio takes the median spec ratio and falls back when empty", () => {
    expect(shelfFontRatio()).toBeCloseTo(0.09);
    expect(shelfFontRatio([{ fontPx: 20, h: 200 }])).toBeCloseTo(0.1);
    expect(
      shelfFontRatio([
        { fontPx: 10, h: 200 }, // 0.05
        { fontPx: 20, h: 200 }, // 0.10
        { fontPx: 60, h: 200 }, // 0.30
      ]),
    ).toBeCloseTo(0.1);
    expect(shelfFontRatio([{ fontPx: 15, h: 0 }, null])).toBeCloseTo(0.09);
  });

  it("shelfLabelSizing reports on-screen font px and the canvas upscale", () => {
    const spec = { fontPx: 24, h: 258 };
    const near = shelfLabelSizing(spec, { spineHeightPx: 516 });
    expect(near.screenFontPx).toBeCloseTo(48);
    expect(near.scale).toBe(2);
    expect(near.legible).toBe(true);
    const far = shelfLabelSizing(spec, { spineHeightPx: 100 });
    expect(far.screenFontPx).toBeCloseTo(9.3, 1);
    expect(far.scale).toBe(1);
    expect(far.legible).toBe(false);
    // the upscale is capped
    expect(shelfLabelSizing(spec, { spineHeightPx: 5000 }).scale).toBe(3);
    expect(shelfLabelSizing(spec, { spineHeightPx: 5000, maxScale: 5 }).scale).toBe(5);
  });

  it("scaleSpineSpec scales canvas + font, keeping colors and text", () => {
    const spec = spineLabelSpec(flyingBook(), { thickness: 0.12 });
    const same = scaleSpineSpec(spec, 1);
    expect(same.w).toBe(spec.w);
    expect(same.scale).toBe(1);
    const doubled = scaleSpineSpec(spec, 2);
    expect(doubled.w).toBe(spec.w * 2);
    expect(doubled.h).toBe(spec.h * 2);
    expect(doubled.fontPx).toBe(spec.fontPx * 2);
    expect(doubled.scale).toBe(2);
    expect(doubled.text).toBe(spec.text);
    expect(doubled.bg).toBe(spec.bg);
    expect(doubled.ink).toBe(spec.ink);
  });

  it("fills the view with the whole case when titles are already legible", () => {
    // an enormous viewport makes the legible distance huge; fit wins
    const f = shelfViewFraming({ viewportH: 20000, aspect: 16 / 9 });
    expect(f.distance).toBeCloseTo(f.fitDistance);
    expect(f.fitDistance).toBeGreaterThan(2);
  });

  it("dollies closer than the fit distance when titles would land under 14 px", () => {
    const f = shelfViewFraming({ viewportH: 800, aspect: 16 / 9, fontRatio: 0.09 });
    expect(f.legibleDistance).toBeLessThan(f.fitDistance);
    expect(f.distance).toBeCloseTo(f.legibleDistance);
    // at the chosen distance the typical title sits right at the target size
    expect(f.screenFontPx).toBeCloseTo(14, 5);
    // and never inside the books
    expect(shelfViewFraming({ viewportH: 50 }).distance).toBeCloseTo(1.05);
  });

  it("frames the requested wall, centered on the shelf rows", () => {
    const left = shelfViewFraming({ wall: 0 });
    const right = shelfViewFraming({ wall: 1 });
    expect(left.lookAt.x).toBeCloseTo(-3.73);
    expect(right.lookAt.x).toBeCloseTo(3.73);
    expect(left.position.x).toBeGreaterThan(left.lookAt.x); // camera inside the room
    expect(right.position.x).toBeLessThan(right.lookAt.x);
    const y0 = SHELF_LAYOUT.firstShelfY;
    const y1 = y0 + (SHELF_LAYOUT.shelvesPerWall - 1) * SHELF_LAYOUT.shelfGapY + 0.46;
    expect(left.position.y).toBeCloseTo((y0 + y1) / 2);
    expect(left.lookAt.y).toBeCloseTo(left.position.y);
    expect(left.position.z).toBeCloseTo(0);
    // deterministic
    expect(shelfViewFraming({ wall: 0 })).toEqual(left);
  });
});

describe("createInteriorScene (headless, no WebGL)", () => {
  beforeEach(() => {
    // jsdom has no canvas backend; the texture painters tolerate a null ctx.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });
  afterEach(() => vi.restoreAllMocks());

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const advance = (scene, seconds, dt = 0.05) => {
    for (let t = 0; t < seconds; t += dt) scene.update(dt);
  };
  const spineMeshes = (scene) => {
    const out = [];
    scene.scene.traverse((o) => {
      if (o.userData?.slug) out.push(o);
    });
    return out;
  };
  const hintMeshes = (scene) => {
    const out = [];
    scene.scene.traverse((o) => {
      if (o.userData?.hint) out.push(o);
    });
    return out;
  };

  function makeScene(books = [flyingBook(), tideBook()], keepers = [dreamsKeeper()]) {
    const bus = createBus();
    const api = { listBooks: vi.fn(async () => books) };
    const state = { keepers, selectedKeeperId: "dreams" };
    const scene = createInteriorScene({ state, bus, api, keeperId: "dreams", container: null });
    return { scene, bus, api, state };
  }

  const findNamed = (scene, name) => {
    let out = null;
    scene.scene.traverse((o) => {
      if (!out && o.name === name) out = o;
    });
    return out;
  };

  // Steps until cond() holds (fails the test if it never does).
  const advanceUntil = (scene, cond, maxS = 20, dt = 0.05) => {
    for (let t = 0; t < maxS; t += dt) {
      if (cond()) return;
      scene.update(dt);
    }
    expect(cond()).toBe(true);
  };

  it("builds one spine mesh per book and starts the keeper sitting", async () => {
    const { scene, api } = makeScene();
    await flush();
    expect(api.listBooks).toHaveBeenCalledWith("dreams");
    expect(spineMeshes(scene).map((m) => m.userData.slug).sort()).toEqual(
      [flyingBook().slug, tideBook().slug].sort(),
    );
    expect(hintMeshes(scene)).toHaveLength(0);
    expect(scene.keeperState()).toBe("sitting");
    scene.dispose();
  });

  it("runs the full fetch loop: pick -> book:open while she waits, reader:closed -> back to sitting", async () => {
    const { scene, bus } = makeScene();
    await flush();
    const opened = vi.fn();
    bus.on("book:open", opened);
    const slug = flyingBook().slug;
    const mesh = spineMeshes(scene).find((m) => m.userData.slug === slug);
    const base = mesh.position.clone();

    scene.pick(slug);
    expect(scene.keeperState()).toBe("hopOff");

    advance(scene, 8); // hop + walk + grab comfortably fits
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledWith({ keeperId: "dreams", slug });
    expect(scene.keeperState()).toBe("waiting");
    expect(mesh.position.distanceTo(base)).toBeGreaterThan(0.5); // floated out

    bus.emit("reader:closed");
    expect(scene.keeperState()).toBe("walkToChair");
    advance(scene, 8); // book flies home, she walks back and hops on
    expect(scene.keeperState()).toBe("sitting");
    expect(mesh.position.distanceTo(base)).toBeLessThan(0.01);
    expect(mesh.scale.x).toBeCloseTo(1);
    scene.dispose();
  });

  it("empty library shows the glowing hint book; it yields to real books and returns", async () => {
    const { scene, bus } = makeScene([]);
    await flush();
    expect(spineMeshes(scene)).toHaveLength(0);
    expect(hintMeshes(scene)).toHaveLength(1);

    bus.emit("book:created", { keeperId: "dreams", book: tideBook() });
    expect(hintMeshes(scene)).toHaveLength(0);
    expect(spineMeshes(scene)).toHaveLength(1);

    bus.emit("book:destroyed", { keeperId: "dreams", slug: tideBook().slug });
    expect(spineMeshes(scene)).toHaveLength(0);
    expect(hintMeshes(scene)).toHaveLength(1);
    scene.dispose();
  });

  it("destroying the fetched book aborts the fetch and sends her home", async () => {
    const { scene, bus } = makeScene();
    await flush();
    const slug = flyingBook().slug;
    scene.pick(slug);
    advance(scene, 8);
    expect(scene.keeperState()).toBe("waiting");

    bus.emit("book:destroyed", { keeperId: "dreams", slug });
    advance(scene, 8);
    expect(scene.keeperState()).toBe("sitting");
    expect(spineMeshes(scene).some((m) => m.userData.slug === slug)).toBe(false);
    scene.dispose();
  });

  const pressEscape = () =>
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

  it("builds the guest armchair and the bookcase as pickable hotspots", async () => {
    const { scene } = makeScene();
    await flush();
    const hotspots = { chair: 0, shelfWalls: new Set() };
    scene.scene.traverse((o) => {
      if (o.userData?.hotspot === "chair") hotspots.chair++;
      if (o.userData?.hotspot === "shelf") hotspots.shelfWalls.add(o.userData.wall);
    });
    expect(hotspots.chair).toBeGreaterThan(0);
    expect([...hotspots.shelfWalls]).toEqual([0]); // one bookcase
    scene.dispose();
  });

  it("setView tweens the camera between views and locks input mid-tween", async () => {
    const { scene } = makeScene();
    await flush();
    expect(scene.view()).toBe("main");
    const start = scene.camera.position.clone();

    expect(scene.setView("chairs")).toBe(true);
    expect(scene.viewTarget()).toBe("chairs");
    expect(scene.setView("shelf")).toBe(false); // input ignored mid-tween
    expect(scene.viewTarget()).toBe("chairs");

    advance(scene, 0.4);
    expect(scene.view()).toBe("main"); // still tweening
    expect(scene.camera.position.distanceTo(start)).toBeGreaterThan(0.5);

    advance(scene, 1);
    expect(scene.view()).toBe("chairs");
    expect(scene.viewTarget()).toBeNull();
    // seated IN the guest chair, low, with only a gentle sway
    expect(scene.camera.position.x).toBeCloseTo(CHAIRS_POSE.pos.x, 1);
    expect(scene.camera.position.z).toBeCloseTo(CHAIRS_POSE.pos.z, 1);
    expect(scene.camera.position.y).toBeLessThan(1.4);
    // and looking at her chair
    const dir = new THREE.Vector3();
    scene.camera.getWorldDirection(dir);
    const toHer = new THREE.Vector3(
      CHAIR_POS.x - scene.camera.position.x,
      CHAIRS_POSE.look.y - scene.camera.position.y,
      CHAIR_POS.z - scene.camera.position.z,
    ).normalize();
    expect(dir.dot(toHer)).toBeGreaterThan(0.98);

    expect(scene.setView("shelf")).toBe(true);
    advance(scene, 1);
    expect(scene.view()).toBe("shelf");
    // facing the left bookcase wall from inside the room
    expect(scene.camera.position.x).toBeGreaterThan(-3.4);
    expect(scene.camera.position.x).toBeLessThan(0.5);
    expect(scene.camera.position.y).toBeCloseTo(2.03, 1);

    expect(scene.setView("main")).toBe(true);
    advance(scene, 1);
    expect(scene.view()).toBe("main");
    expect(scene.camera.position.distanceTo(start)).toBeLessThan(0.01);
    scene.dispose();
  });

  it("switches views on the interior:view bus event (holo buttons)", async () => {
    const { scene, bus } = makeScene();
    await flush();
    bus.emit("interior:view", { view: "attic" }); // unknown: ignored
    expect(scene.viewTarget()).toBeNull();
    bus.emit("interior:view", { view: "chairs" });
    expect(scene.viewTarget()).toBe("chairs");
    bus.emit("interior:view", { view: "shelf" }); // mid-tween: ignored
    expect(scene.viewTarget()).toBe("chairs");
    advance(scene, 1);
    expect(scene.view()).toBe("chairs");
    scene.dispose();
  });

  it("Sit beside her opens the conversation: chairs view emits keeper:selected", async () => {
    const { scene, bus } = makeScene();
    await flush();
    const selected = vi.fn();
    bus.on("keeper:selected", selected);
    bus.emit("interior:view", { view: "chairs" });
    expect(selected).toHaveBeenCalledWith({ keeperId: "dreams" });
    expect(scene.viewTarget()).toBe("chairs");
    scene.dispose();
  });

  it("Back to Keeper in the settled main view gently re-frames on her (no view change)", async () => {
    const { scene, bus } = makeScene();
    await flush();
    expect(scene.view()).toBe("main");
    const posBefore = scene.camera.position.clone();
    const dirBefore = new THREE.Vector3();
    scene.camera.getWorldDirection(dirBefore);

    bus.emit("interior:view", { view: "main" });
    expect(scene.reframing()).toBe(true);
    expect(scene.viewTarget()).toBeNull(); // never a tween: the view stays main

    advance(scene, 1.2);
    expect(scene.reframing()).toBe(false);
    expect(scene.view()).toBe("main");
    // the camera stayed put and turned toward her chair
    expect(scene.camera.position.distanceTo(posBefore)).toBeLessThan(0.01);
    const dir = new THREE.Vector3();
    scene.camera.getWorldDirection(dir);
    expect(dir.equals(dirBefore)).toBe(false);
    const toHer = new THREE.Vector3(
      CHAIR_POS.x - scene.camera.position.x,
      1.16 - scene.camera.position.y,
      CHAIR_POS.z - scene.camera.position.z,
    ).normalize();
    expect(dir.dot(toHer)).toBeGreaterThan(0.999);
    scene.dispose();
  });

  it("Back to Keeper from another view is a normal tween home, not a re-frame", async () => {
    const { scene, bus } = makeScene();
    await flush();
    scene.setView("chairs");
    advance(scene, 1);
    expect(scene.view()).toBe("chairs");

    bus.emit("interior:view", { view: "main" });
    expect(scene.reframing()).toBe(false);
    expect(scene.viewTarget()).toBe("main");
    // and a re-frame request mid-tween is ignored
    bus.emit("interior:view", { view: "main" });
    expect(scene.reframing()).toBe(false);
    advance(scene, 1);
    expect(scene.view()).toBe("main");
    scene.dispose();
  });

  it("a view change cancels a running re-frame", async () => {
    const { scene, bus } = makeScene();
    await flush();
    bus.emit("interior:view", { view: "main" });
    expect(scene.reframing()).toBe(true);
    scene.setView("shelf");
    expect(scene.reframing()).toBe(false);
    advance(scene, 1);
    expect(scene.view()).toBe("shelf");
    scene.dispose();
  });

  it("shelves a full library of 24 books (digests included) inside the case", async () => {
    const manyBooks = Array.from({ length: LIBRARY_CAP }, (_, i) => ({
      slug: `2026-06-${String(i + 1).padStart(2, "0")}-memory-${i}`,
      title: `Memory ${i}`,
      date: "2026-06-01",
      tags: [`thread-${i % 5}`],
      source: i % 6 === 0 ? "sleep" : "told", // digests are normal books
      one_liner: "a line ".repeat(i % 20),
    }));
    const { scene } = makeScene(manyBooks);
    await flush();
    const meshes = spineMeshes(scene);
    expect(meshes).toHaveLength(LIBRARY_CAP);

    const walls = new Set();
    for (const mesh of meshes) {
      const thickness = mesh.geometry.parameters.depth; // runs along z
      // spine (plus its own thickness) never overhangs the shelf run
      expect(Math.abs(mesh.position.z) + thickness / 2).toBeLessThanOrEqual(
        SHELF_LAYOUT.shelfWidth / 2 + 1e-9,
      );
      walls.add(mesh.position.x < 0 ? 0 : 1);
    }
    expect([...walls]).toEqual([0]); // the single case holds the full library

    // a digest book got a plain spine like everyone else
    const digest = meshes.find((m) => m.userData.slug === manyBooks[0].slug);
    expect(digest).toBeTruthy();
    expect(Array.isArray(digest.material)).toBe(true);
    expect(digest.material).toHaveLength(6);
    scene.dispose();
  });

  it("Esc returns to main from a view (no exit); exits only from main", async () => {
    const { scene, bus } = makeScene();
    await flush();
    const exit = vi.fn();
    bus.on("interior:exit", exit);

    scene.setView("chairs");
    advance(scene, 1);
    pressEscape();
    expect(exit).not.toHaveBeenCalled();
    expect(scene.viewTarget()).toBe("main");
    advance(scene, 1);
    expect(scene.view()).toBe("main");

    pressEscape();
    expect(exit).toHaveBeenCalledTimes(1);

    scene.dispose();
    pressEscape(); // listeners removed
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("Esc mid-tween is swallowed (input lock)", async () => {
    const { scene, bus } = makeScene();
    await flush();
    const exit = vi.fn();
    bus.on("interior:exit", exit);
    scene.setView("shelf");
    pressEscape();
    expect(exit).not.toHaveBeenCalled();
    expect(scene.viewTarget()).toBe("shelf");
    advance(scene, 1);
    expect(scene.view()).toBe("shelf");
    scene.dispose();
  });

  it("picking a book jumps to main for the fetch and restores the previous view on reader close", async () => {
    const { scene, bus } = makeScene();
    await flush();
    const opened = vi.fn();
    bus.on("book:open", opened);

    scene.setView("shelf");
    advance(scene, 1);
    expect(scene.view()).toBe("shelf");

    scene.pick(flyingBook().slug);
    expect(scene.viewTarget()).toBe("main"); // forced jump for the fetch
    advance(scene, 8);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(scene.view()).toBe("main");
    expect(scene.keeperState()).toBe("waiting");

    bus.emit("reader:closed");
    expect(scene.viewTarget()).toBe("shelf"); // previous view restored
    advance(scene, 1);
    expect(scene.view()).toBe("shelf");
    advance(scene, 8);
    expect(scene.keeperState()).toBe("sitting");
    scene.dispose();
  });

  it("a book picked from main stays in main after the reader closes", async () => {
    const { scene, bus } = makeScene();
    await flush();
    scene.pick(tideBook().slug);
    expect(scene.viewTarget()).toBeNull(); // already main: no tween
    advance(scene, 8);
    bus.emit("reader:closed");
    expect(scene.viewTarget()).toBeNull();
    expect(scene.view()).toBe("main");
    scene.dispose();
  });

  it("entering the shelf view re-renders framed spine canvases at a higher resolution", async () => {
    // A big viewport makes the projected spines taller than their base
    // canvases, so the close-up needs denser textures.
    const dims = Object.getOwnPropertyDescriptor(window, "innerWidth");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 3600 });
    const dimsH = Object.getOwnPropertyDescriptor(window, "innerHeight");
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 2000 });
    try {
      const { scene } = makeScene();
      await flush();
      const mesh = spineMeshes(scene).find((m) => m.userData.slug === flyingBook().slug);
      const spineMat = mesh.material.find((m) => m.map); // the spine face
      const before = spineMat.map;
      scene.setView("shelf");
      expect(spineMat.map).not.toBe(before); // re-rendered for the close-up
      scene.dispose();
    } finally {
      if (dims) Object.defineProperty(window, "innerWidth", dims);
      if (dimsH) Object.defineProperty(window, "innerHeight", dimsH);
    }
  });

  it("keeper:sleep makes her doze on the chair until keeper:rested (eyes shut, Zzz)", async () => {
    const { scene, bus } = makeScene();
    await flush();
    const eyes = findNamed(scene, "eyes");
    const zzz = findNamed(scene, "zzz");
    expect(eyes).toBeTruthy();
    expect(scene.dozeState()).toBe("awake");

    bus.emit("keeper:sleep", { keeperId: "dreams" });
    expect(scene.dozeState()).toBe("settling");
    advance(scene, 1.5); // settles on the chair she already sits on, then dozes
    expect(scene.dozeState()).toBe("dozing");
    expect(scene.keeperState()).toBe("sitting");
    expect(eyes.scale.y).toBeLessThan(0.15); // eyes shut
    expect(zzz.visible).toBe(true);

    bus.emit("keeper:rested", { keeperId: "dreams" });
    expect(scene.dozeState()).toBe("awake");
    advance(scene, 1.5);
    expect(eyes.scale.y).toBeGreaterThan(0.8); // reopened, rested
    expect(zzz.visible).toBe(false);
    scene.dispose();
  });

  it("a pick while she dozes opens the reader without waking her", async () => {
    const { scene, bus } = makeScene();
    await flush();
    const opened = vi.fn();
    bus.on("book:open", opened);
    bus.emit("keeper:sleep", { keeperId: "dreams" });
    advanceUntil(scene, () => scene.dozeState() === "dozing");

    scene.pick(flyingBook().slug);
    expect(opened).toHaveBeenCalledWith({ keeperId: "dreams", slug: flyingBook().slug });
    expect(scene.keeperState()).toBe("sitting"); // she sleeps through it
    expect(scene.dozeState()).toBe("dozing");

    bus.emit("reader:closed");
    advance(scene, 1);
    expect(scene.dozeState()).toBe("dozing"); // still napping
    scene.dispose();
  });

  it("applies her session tired level and follows state:loaded refreshes", async () => {
    const tiredKeeper = {
      ...dreamsKeeper(),
      level: 3,
      session: { tokens_used: 900, budget: 1000, status: "needs_sleep" },
    };
    const { scene, bus, state } = makeScene([flyingBook()], [tiredKeeper]);
    await flush();
    advance(scene, 1);
    const eyes = findNamed(scene, "eyes");
    const zzz = findNamed(scene, "zzz");
    expect(eyes.scale.y).toBeLessThan(0.62); // droopy: needs_sleep
    expect(zzz.visible).toBe(true);

    state.keepers = [{ ...tiredKeeper, session: { ...tiredKeeper.session, status: "rested" } }];
    bus.emit("state:loaded", { state });
    advance(scene, 1);
    expect(eyes.scale.y).toBeGreaterThan(0.85); // refreshed to rested
    expect(zzz.visible).toBe(false);
    scene.dispose();
  });

  it("clicking the keeper in the room opens the same talk panel (keeper:selected)", async () => {
    const container = document.createElement("div");
    container.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
    });
    document.body.appendChild(container);
    const bus = createBus();
    const api = { listBooks: vi.fn(async () => [flyingBook()]) };
    const state = { keepers: [dreamsKeeper()], selectedKeeperId: "dreams" };
    const scene = createInteriorScene({ state, bus, api, keeperId: "dreams", container });
    await flush();
    const selected = vi.fn();
    bus.on("keeper:selected", selected);

    // project her body center to screen coordinates and click right there
    scene.scene.updateMatrixWorld(true);
    scene.camera.updateMatrixWorld(true);
    let body = null;
    scene.scene.traverse((o) => {
      if (!body && o.userData?.pick === "keeper") body = o;
    });
    expect(body).toBeTruthy();
    const p = new THREE.Vector3();
    body.getWorldPosition(p);
    p.project(scene.camera);
    const clientX = ((p.x + 1) / 2) * 800;
    const clientY = ((1 - p.y) / 2) * 600;
    container.dispatchEvent(new MouseEvent("click", { clientX, clientY, bubbles: true }));
    expect(selected).toHaveBeenCalledWith({ keeperId: "dreams" });

    scene.dispose();
    container.remove();
  });
});
