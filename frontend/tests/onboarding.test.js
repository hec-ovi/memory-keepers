// First-visit onboarding card: shows once after state:loaded, dismisses to
// localStorage-shaped storage, stays gone on later boots, and hides outside
// the overworld.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { createBus } from "../src/bus.js";
import { createOnboarding, ONBOARDING_KEY } from "../src/ui/onboarding.js";

// localStorage stand-in (jsdom's real one would leak state between tests).
function makeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    data,
  };
}

let root, bus, storage, onboarding;

beforeEach(() => {
  root = document.createElement("div");
  document.body.appendChild(root);
  bus = createBus();
  storage = makeStorage();
});

afterEach(() => {
  onboarding?.dispose();
  root.remove();
  document.getElementById("mk-onboard-style")?.remove();
});

describe("createOnboarding", () => {
  it("injects the holo kit styles before its own so .mk-onboard positioning wins the cascade", () => {
    onboarding = createOnboarding({ root, bus, storage });
    const ids = [...document.head.querySelectorAll("style")].map((s) => s.id);
    expect(ids).toContain("holo-kit-style");
    expect(ids).toContain("mk-onboard-style");
    expect(ids.indexOf("holo-kit-style")).toBeLessThan(ids.indexOf("mk-onboard-style"));
  });

  it("shows the hint card on the first state:loaded", () => {
    onboarding = createOnboarding({ root, bus, storage });
    expect(onboarding.isOpen()).toBe(false);

    bus.emit("state:loaded", {});
    expect(onboarding.isOpen()).toBe(true);
    const card = within(root).getByLabelText("welcome hints");
    expect(card.textContent).toMatch(/click an keeper/i);
    expect(card.textContent).toMatch(/join/i);
    expect(card.textContent).toMatch(/drag/i);
    expect(card.textContent).toMatch(/middle-drag/i);
    expect(card.textContent).toMatch(/minimap/i);
  });

  it("Got it dismisses the card and persists the flag", async () => {
    const user = userEvent.setup();
    onboarding = createOnboarding({ root, bus, storage });
    bus.emit("state:loaded", {});

    await user.click(screen.getByRole("button", { name: "Got it" }));
    expect(onboarding.isOpen()).toBe(false);
    expect(storage.getItem(ONBOARDING_KEY)).toBe("1");

    // A later reload of the state does not resurrect it.
    bus.emit("state:loaded", {});
    expect(onboarding.isOpen()).toBe(false);
  });

  it("never shows when the storage flag is already set", () => {
    onboarding = createOnboarding({ root, bus, storage: makeStorage({ [ONBOARDING_KEY]: "1" }) });
    bus.emit("state:loaded", {});
    expect(onboarding.isOpen()).toBe(false);
    expect(within(root).queryByLabelText("welcome hints")).toBeNull();
  });

  it("hides outside the overworld and returns with it", () => {
    onboarding = createOnboarding({ root, bus, storage });
    bus.emit("state:loaded", {});
    const card = within(root).getByLabelText("welcome hints");

    bus.emit("mode:changed", { mode: "interior:dreams" });
    expect(card.style.display).toBe("none");
    bus.emit("mode:changed", { mode: "overworld" });
    expect(card.style.display).toBe("");
  });

  it("works without storage (shows every boot, dismiss still works in-session)", () => {
    onboarding = createOnboarding({ root, bus, storage: null });
    bus.emit("state:loaded", {});
    expect(onboarding.isOpen()).toBe(true);
    onboarding.dismiss();
    expect(onboarding.isOpen()).toBe(false);
    bus.emit("state:loaded", {});
    expect(onboarding.isOpen()).toBe(false); // dismissed for this session
  });
});
