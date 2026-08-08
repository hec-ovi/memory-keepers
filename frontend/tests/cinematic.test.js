// ui/cinematic.js: letterbox bars + caption + Skip, the fade plate, the
// ui-cinematic body class (input lock for the other panels) and Esc
// handling. Real DOM via RTL + user-event; bus events asserted.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { createCinematic } from "../src/ui/cinematic.js";
import { createBus } from "../src/bus.js";
import { makeState } from "./ui_fixtures.js";

describe("createCinematic", () => {
  let root, bus, state, cinematic;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
    bus = createBus();
    state = makeState();
    cinematic = createCinematic({ root, state, bus });
  });

  afterEach(() => {
    cinematic.dispose();
    document.body.innerHTML = "";
    document.body.className = "";
  });

  it("letterboxes in with the keeper's name as caption on cinematic:started", () => {
    expect(cinematic.isActive()).toBe(false);
    bus.emit("cinematic:started", { keeperId: "dreams", name: "Keeper of Dreams" });

    expect(cinematic.isActive()).toBe(true);
    expect(document.body.classList.contains("ui-cinematic")).toBe(true);
    const bars = root.querySelectorAll(".mk-cine-bar");
    expect(bars).toHaveLength(2); // top + bottom
    for (const bar of bars) expect(bar.classList.contains("is-in")).toBe(true);
    expect(screen.getByText("Following Keeper of Dreams home")).toBeTruthy();
    expect(screen.getByRole("button", { name: "skip cinematic" })).toBeTruthy();
  });

  it("resolves the caption name from state when the payload has none", () => {
    bus.emit("cinematic:started", { keeperId: "meetings" });
    expect(screen.getByText("Following Keeper of Meetings home")).toBeTruthy();
  });

  it("Skip click emits cinematic:skip once, with the keeperId", async () => {
    const user = userEvent.setup();
    const skipped = vi.fn();
    bus.on("cinematic:skip", skipped);
    bus.emit("cinematic:started", { keeperId: "dreams", name: "Keeper of Dreams" });

    const btn = screen.getByRole("button", { name: "skip cinematic" });
    await user.click(btn);
    await user.click(btn); // hammering Skip fires it only once
    expect(skipped).toHaveBeenCalledTimes(1);
    expect(skipped).toHaveBeenCalledWith({ keeperId: "dreams" });
  });

  it("Esc emits cinematic:skip and is swallowed (nothing else may react)", async () => {
    const user = userEvent.setup();
    const skipped = vi.fn();
    const leaked = vi.fn();
    bus.on("cinematic:skip", skipped);
    document.addEventListener("keydown", leaked); // e.g. main.js's Esc handler
    bus.emit("cinematic:started", { keeperId: "dreams", name: "Keeper of Dreams" });

    await user.keyboard("{Escape}");
    expect(skipped).toHaveBeenCalledTimes(1);
    expect(skipped).toHaveBeenCalledWith({ keeperId: "dreams" });
    expect(leaked).not.toHaveBeenCalled(); // stopPropagation in capture

    document.removeEventListener("keydown", leaked);
  });

  it("Esc does nothing while no cinematic plays", async () => {
    const user = userEvent.setup();
    const skipped = vi.fn();
    bus.on("cinematic:skip", skipped);
    await user.keyboard("{Escape}");
    expect(skipped).not.toHaveBeenCalled();
  });

  it("cinematic:fade darkens the plate; cinematic:ended restores everything", async () => {
    bus.emit("cinematic:started", { keeperId: "dreams", name: "Keeper of Dreams" });
    const fade = root.querySelector(".mk-cine-fade");
    expect(fade.classList.contains("is-dark")).toBe(false);

    bus.emit("cinematic:fade", { seconds: 0.5 });
    expect(fade.classList.contains("is-dark")).toBe(true);

    bus.emit("cinematic:ended", { keeperId: "dreams" });
    expect(cinematic.isActive()).toBe(false);
    expect(document.body.classList.contains("ui-cinematic")).toBe(false);
    // Bars animate out (is-in dropped) and leave the DOM; the black plate
    // holds a beat over the scene swap, then reveals.
    for (const bar of root.querySelectorAll(".mk-cine-bar")) {
      expect(bar.classList.contains("is-in")).toBe(false);
    }
    await waitFor(() => expect(root.querySelectorAll(".mk-cine-bar")).toHaveLength(0));
    await waitFor(() => expect(fade.classList.contains("is-dark")).toBe(false));
  });

  it("fade before started is ignored (no stray black screen)", () => {
    bus.emit("cinematic:fade", {});
    expect(root.querySelector(".mk-cine-fade").classList.contains("is-dark")).toBe(false);
  });

  it("a second cinematic:started while active is ignored (single letterbox)", () => {
    bus.emit("cinematic:started", { keeperId: "dreams", name: "Keeper of Dreams" });
    bus.emit("cinematic:started", { keeperId: "meetings", name: "Keeper of Meetings" });
    expect(root.querySelectorAll(".mk-cine-bar")).toHaveLength(2); // still one pair
    expect(screen.getByText("Following Keeper of Dreams home")).toBeTruthy();
    expect(screen.queryByText("Following Keeper of Meetings home")).toBeNull();
  });

  it("skip after ended is inert; a new cinematic re-arms it", async () => {
    const user = userEvent.setup();
    const skipped = vi.fn();
    bus.on("cinematic:skip", skipped);

    bus.emit("cinematic:started", { keeperId: "dreams", name: "Keeper of Dreams" });
    bus.emit("cinematic:ended", { keeperId: "dreams" });
    await user.keyboard("{Escape}");
    expect(skipped).not.toHaveBeenCalled();

    bus.emit("cinematic:started", { keeperId: "meetings", name: "Keeper of Meetings" });
    await user.keyboard("{Escape}");
    expect(skipped).toHaveBeenCalledTimes(1);
    expect(skipped).toHaveBeenCalledWith({ keeperId: "meetings" });
  });

  it("the idle fade plate pins pointer-events with !important (the #ui > * opt-in)", () => {
    // styles.css opts every direct #ui child back into pointer events with an
    // ID-specificity rule (#ui > *{pointer-events:auto}). The full-viewport
    // fade plate mounts as a direct #ui child, so without !important that
    // rule outranks the plate's class rule and an invisible plate swallows
    // every click in the app. jsdom's cascade cannot model cross-sheet ID
    // specificity (it resolves this to "none" either way), so the regression
    // is pinned at the declaration level: both states must carry !important.
    const css = document.getElementById("mk-cinematic-style").textContent;
    const idle = css.match(/\.mk-cine-fade\{[^}]*\}/)?.[0] ?? "";
    const dark = css.match(/\.mk-cine-fade\.is-dark\{[^}]*\}/)?.[0] ?? "";
    expect(idle).toMatch(/pointer-events:\s*none\s*!important/);
    expect(dark).toMatch(/pointer-events:\s*auto\s*!important/);
  });

  it("dispose removes the overlay, timers and the body class", () => {
    bus.emit("cinematic:started", { keeperId: "dreams", name: "Keeper of Dreams" });
    bus.emit("cinematic:fade", {});
    cinematic.dispose();
    expect(document.body.classList.contains("ui-cinematic")).toBe(false);
    expect(root.querySelector(".mk-cine-bar")).toBeNull();
    expect(root.querySelector(".mk-cine-fade")).toBeNull();
  });
});
