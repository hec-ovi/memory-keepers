import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { createHowto } from "../src/ui/howto.js";

let root;

beforeEach(() => {
  root = document.createElement("div");
  document.body.appendChild(root);
});

afterEach(() => {
  root.remove();
});

describe("createHowto", () => {
  it("opens an overlay describing the controls", () => {
    const howto = createHowto({ root });
    expect(howto.isOpen()).toBe(false);
    howto.open();
    expect(howto.isOpen()).toBe(true);
    expect(screen.getByRole("dialog", { name: "How to play" })).toBeTruthy();
    expect(screen.getByText(/two-finger scroll/i)).toBeTruthy();
    expect(screen.getByText(/orbit/i)).toBeTruthy();
    expect(screen.getByText(/middle-drag/i)).toBeTruthy();
    expect(screen.getByText(/pan: grab the ground/i)).toBeTruthy();
    expect(screen.getByText(/click an keeper/i)).toBeTruthy();
    expect(screen.getByText(/esc \/ back/i)).toBeTruthy();
    // the unconscious quarter is a place you travel to, not a time of day
    expect(screen.getByText(/across the ridge/i)).toBeTruthy();
  });

  it("speaks the warm dreaming language, never the technical words", () => {
    const howto = createHowto({ root });
    howto.open();
    // the big sleep is "Dreaming" now, and the night keepers are chattable
    expect(screen.getByText(/dreaming \(hud button\)/i)).toBeTruthy();
    expect(screen.getByText(/born from the dreaming/i)).toBeTruthy();
    expect(screen.getByText(/they keep no books of what you tell them/i)).toBeTruthy();
    expect(screen.getByText(/view keepers \(hud button\)/i)).toBeTruthy();
    // no consolidation/session/token vocabulary anywhere on the card
    const overlay = root.querySelector(".overlay-backdrop");
    expect(overlay.textContent).not.toMatch(/consolidat|session|token|context/i);
    // and no stale observe-only claim
    expect(overlay.textContent).not.toMatch(/never tell them anything/i);
  });

  it("closes via the close button", async () => {
    const user = userEvent.setup();
    const howto = createHowto({ root });
    howto.open();
    await user.click(screen.getByRole("button", { name: "Got it" }));
    expect(howto.isOpen()).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const howto = createHowto({ root });
    howto.open();
    await user.keyboard("{Escape}");
    expect(howto.isOpen()).toBe(false);
  });

  it("closes when the backdrop is clicked", async () => {
    const user = userEvent.setup();
    const howto = createHowto({ root });
    howto.open();
    await user.click(root.querySelector(".overlay-backdrop"));
    expect(howto.isOpen()).toBe(false);
  });

  it("toggle flips open and closed; double open is a no-op", () => {
    const howto = createHowto({ root });
    howto.toggle();
    expect(howto.isOpen()).toBe(true);
    howto.open(); // no second overlay
    expect(root.querySelectorAll(".overlay-backdrop")).toHaveLength(1);
    howto.toggle();
    expect(howto.isOpen()).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
