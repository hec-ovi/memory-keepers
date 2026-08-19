// RTL suite for the interior room UI: the navigation cluster (vertical,
// bottom-right: Back to Keeper / Sit beside her / Bookshelf / Back to the
// island) and the room readout (bottom-left: name, level, shelved count,
// rest in warm words).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { createBus } from "../src/bus.js";
import {
  createInteriorViews,
  createInteriorReadout,
  readoutModel,
  restWording,
  VIEW_BUTTONS,
  EXIT_LABEL,
} from "../src/ui/interior_views.js";
import { LIBRARY_CAP } from "../src/render/scene_interior.js";
import { HOLO_STYLE_ID } from "../src/ui/holo/holo.js";
import { dreamsKeeper } from "./ui_fixtures.js";

let root;

beforeEach(() => {
  root = document.createElement("div");
  document.body.appendChild(root);
});

afterEach(() => {
  root.remove();
  vi.restoreAllMocks();
});

describe("createInteriorViews", () => {
  it("renders the nav cluster as one row: Back to Keeper first, Back to the island last", () => {
    createInteriorViews({ root });
    const cluster = screen.getByRole("group", { name: "Room navigation" });
    const buttons = within(cluster).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Back to Keeper",
      "Sit beside her",
      "Bookshelf",
      "Back to the island",
    ]);
    for (const btn of buttons) {
      expect(btn.classList.contains("holo-btn")).toBe(true);
      expect(btn.type).toBe("button");
    }
    expect(VIEW_BUTTONS.map((b) => b.view)).toEqual(["main", "chairs", "shelf"]);
    expect(EXIT_LABEL).toBe("Back to the island");
    // the cluster stacks vertically (top button = first in DOM order)
    const css = document.getElementById("mk-interior-views-style").textContent;
    expect(css).toMatch(/\.mk-interior-views\{[^}]*flex-direction:row/);
  });

  it("injects the holo kit styles and its own placement styles", () => {
    createInteriorViews({ root });
    expect(document.getElementById(HOLO_STYLE_ID)).toBeTruthy();
    expect(document.getElementById("mk-interior-views-style")).toBeTruthy();
  });

  it("marks the main view active by default, and setActive moves the highlight", () => {
    const views = createInteriorViews({ root });
    const main = screen.getByRole("button", { name: "Back to Keeper" });
    const shelf = screen.getByRole("button", { name: "Bookshelf" });
    expect(main.classList.contains("holo-btn--primary")).toBe(true);
    expect(main.getAttribute("aria-pressed")).toBe("true");
    expect(shelf.classList.contains("holo-btn--primary")).toBe(false);
    expect(shelf.getAttribute("aria-pressed")).toBe("false");

    views.setActive("shelf");
    expect(main.classList.contains("holo-btn--primary")).toBe(false);
    expect(main.getAttribute("aria-pressed")).toBe("false");
    expect(shelf.classList.contains("holo-btn--primary")).toBe(true);
    expect(shelf.getAttribute("aria-pressed")).toBe("true");
  });

  it("the exit button is an action, not a view: no aria-pressed, never highlighted", () => {
    const views = createInteriorViews({ root });
    const exit = screen.getByRole("button", { name: "Back to the island" });
    expect(exit.hasAttribute("aria-pressed")).toBe(false);
    views.setActive("main");
    views.setActive("shelf");
    expect(exit.classList.contains("holo-btn--primary")).toBe(false);
  });

  it("honors a non-default initial active view", () => {
    createInteriorViews({ root, active: "chairs" });
    const chairs = screen.getByRole("button", { name: "Sit beside her" });
    expect(chairs.classList.contains("holo-btn--primary")).toBe(true);
  });

  it("view clicks emit interior:view on the bus and call onSelect", async () => {
    const user = userEvent.setup();
    const bus = createBus();
    const onBus = vi.fn();
    bus.on("interior:view", onBus);
    const onSelect = vi.fn();
    createInteriorViews({ root, bus, onSelect });

    await user.click(screen.getByRole("button", { name: "Bookshelf" }));
    expect(onBus).toHaveBeenCalledTimes(1);
    expect(onBus).toHaveBeenCalledWith({ view: "shelf" });
    expect(onSelect).toHaveBeenCalledWith("shelf");

    await user.click(screen.getByRole("button", { name: "Sit beside her" }));
    expect(onBus).toHaveBeenLastCalledWith({ view: "chairs" });

    // "Back to Keeper" is the main-view button; the scene turns a click while
    // main is already up into a gentle re-frame on her
    await user.click(screen.getByRole("button", { name: "Back to Keeper" }));
    expect(onBus).toHaveBeenLastCalledWith({ view: "main" });
    expect(onBus).toHaveBeenCalledTimes(3);
  });

  it("Back to the island emits interior:exit (never interior:view) and calls onExit", async () => {
    const user = userEvent.setup();
    const bus = createBus();
    const onView = vi.fn();
    const onExitBus = vi.fn();
    bus.on("interior:view", onView);
    bus.on("interior:exit", onExitBus);
    const onExit = vi.fn();
    createInteriorViews({ root, bus, onExit });

    await user.click(screen.getByRole("button", { name: "Back to the island" }));
    expect(onExitBus).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onView).not.toHaveBeenCalled();
  });

  it("works without a bus (onSelect only) and without onSelect (bus only)", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const views = createInteriorViews({ root, onSelect });
    await user.click(screen.getByRole("button", { name: "Bookshelf" }));
    expect(onSelect).toHaveBeenCalledWith("shelf");
    await user.click(screen.getByRole("button", { name: "Back to the island" })); // no bus: no throw
    views.dispose();

    const bus = createBus();
    const onBus = vi.fn();
    bus.on("interior:view", onBus);
    createInteriorViews({ root, bus });
    await user.click(screen.getByRole("button", { name: "Bookshelf" }));
    expect(onBus).toHaveBeenCalledWith({ view: "shelf" });
  });

  it("dispose removes the cluster", () => {
    const views = createInteriorViews({ root });
    expect(screen.getByRole("group", { name: "Room navigation" })).toBeTruthy();
    views.dispose();
    expect(screen.queryByRole("group", { name: "Room navigation" })).toBeNull();
  });
});

describe("restWording / readoutModel (pure)", () => {
  it("maps session status to warm words, defaulting to rested", () => {
    expect(restWording("rested")).toBe("rested");
    expect(restWording("unrested")).toBe("getting tired");
    expect(restWording("needs_sleep")).toBe("needs to dream");
    expect(restWording(undefined)).toBe("rested");
    expect(restWording("garbage")).toBe("rested");
  });

  it("derives the readout from an Keeper record with safe fallbacks", () => {
    const keeper = {
      ...dreamsKeeper(),
      level: 3,
      book_count: 7,
      session: { status: "unrested" },
    };
    expect(readoutModel(keeper)).toEqual({
      name: "Keeper of Dreams",
      level: 3,
      shelved: 7,
      capacity: LIBRARY_CAP,
      rest: "getting tired",
    });
    expect(readoutModel({})).toEqual({
      name: "her",
      level: 1,
      shelved: 0,
      capacity: LIBRARY_CAP,
      rest: "rested",
    });
    expect(readoutModel({ id: "dreams", book_count: -2 }).shelved).toBe(0);
    expect(readoutModel({}, 10).capacity).toBe(10);
  });
});

describe("createInteriorReadout", () => {
  it("shows her name, level, shelved count against the library cap, and rest in warm words", () => {
    const keeper = { ...dreamsKeeper(), level: 3, book_count: 7, session: { status: "rested" } };
    createInteriorReadout({ root, state: { keepers: [keeper] }, keeperId: "dreams" });
    const readout = screen.getByRole("status");
    expect(within(readout).getByText("Keeper of Dreams")).toBeTruthy();
    expect(within(readout).getByText("LV 3")).toBeTruthy();
    expect(within(readout).getByText(`7 of ${LIBRARY_CAP} shelved`)).toBeTruthy();
    expect(within(readout).getByText("rested")).toBeTruthy();
  });

  it("never shows the engine's technical words, only the warm ones", () => {
    const keeper = { ...dreamsKeeper(), session: { status: "needs_sleep" } };
    createInteriorReadout({ root, state: { keepers: [keeper] }, keeperId: "dreams" });
    const readout = screen.getByRole("status");
    expect(within(readout).getByText("needs to dream")).toBeTruthy();
    expect(readout.textContent).not.toMatch(/needs_sleep|unrested|session|token|consolidat/i);
  });

  it("refreshes from state.keepers on state:loaded, like the tired look does", () => {
    const bus = createBus();
    const state = {
      keepers: [{ ...dreamsKeeper(), level: 1, book_count: 2, session: { status: "rested" } }],
    };
    createInteriorReadout({ root, bus, state, keeperId: "dreams" });
    const readout = screen.getByRole("status");
    expect(within(readout).getByText(`2 of ${LIBRARY_CAP} shelved`)).toBeTruthy();

    state.keepers = [
      { ...dreamsKeeper(), level: 2, book_count: 9, session: { status: "unrested" } },
    ];
    bus.emit("state:loaded", { state });
    expect(within(readout).getByText("LV 2")).toBeTruthy();
    expect(within(readout).getByText(`9 of ${LIBRARY_CAP} shelved`)).toBeTruthy();
    expect(within(readout).getByText("getting tired")).toBeTruthy();
  });

  it("renders gracefully when the keeper is missing from state", () => {
    createInteriorReadout({ root, state: { keepers: [] }, keeperId: "ghost" });
    const readout = screen.getByRole("status");
    expect(within(readout).getByText("ghost")).toBeTruthy();
    expect(within(readout).getByText(`0 of ${LIBRARY_CAP} shelved`)).toBeTruthy();
    expect(within(readout).getByText("rested")).toBeTruthy();
  });

  it("dispose removes the readout and stops listening", () => {
    const bus = createBus();
    const state = { keepers: [dreamsKeeper()] };
    const readout = createInteriorReadout({ root, bus, state, keeperId: "dreams" });
    readout.dispose();
    expect(screen.queryByRole("status")).toBeNull();
    // a later state:loaded must not throw or resurrect anything
    bus.emit("state:loaded", { state });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
