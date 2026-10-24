// The real page entry: main.js auto-boots when #app exists. Boot screens are
// the only UI until /health says ok and /state loads; retry swaps screens by
// outcome. fetch is stubbed per path; scenes are the built-in placeholders.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";

const routes = {};

function reply(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

// Fresh module registry per test, so main.js auto-boots again on import.
async function loadPage() {
  vi.resetModules();
  const { config } = await import("../src/config.js");
  config.sceneModules = {};
  await import("../src/main.js");
}

describe("boot screens (real page entry)", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    globalThis.requestAnimationFrame = vi.fn(() => 1);
    globalThis.cancelAnimationFrame = vi.fn();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi.fn(async (url) => routes[new URL(url, "http://mk").pathname]());
    document.body.innerHTML = '<div id="app"></div><div id="ui"></div>';
  });

  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("blocks on a degraded health behind API ERROR, then opens on a healthy retry", async () => {
    routes["/health"] = () => reply(200, { status: "degraded", tier: "local", model: "down" });
    routes["/state"] = () => reply(200, { keepers: [], dream: { latest_run_id: null, running: false } });
    await loadPage();

    const title = await screen.findByRole("heading", { name: "API ERROR" });
    expect(title.parentElement.textContent).toContain("The local model is not answering");
    expect(title.parentElement.textContent).toContain(".env");
    expect(screen.queryByLabelText("game hud")).toBeNull();
    expect(screen.queryByLabelText("minimap")).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalledWith(expect.stringContaining("/state"), expect.anything());

    routes["/health"] = () => reply(200, { status: "ok", tier: "local", model: "ok" });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "API ERROR" })).toBeNull());
    expect(screen.getByLabelText("game hud")).toBeTruthy();
    expect(globalThis.__keeperBrain.state.mode).toBe("overworld");
  });

  it("a retry that hits the island gate swaps to the key screen; the key opens the game", async () => {
    routes["/health"] = () => reply(200, { status: "degraded", tier: "local", model: "down" });
    await loadPage();
    await screen.findByRole("heading", { name: "API ERROR" });

    routes["/health"] = () => reply(200, { status: "ok", tier: "local", model: "ok" });
    routes["/state"] = () => reply(401, { error: { code: "ACCESS_REQUIRED", message: "this island asks for its key" } });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: "This island asks for its key" });
    expect(screen.queryByRole("heading", { name: "API ERROR" })).toBeNull();
    expect(screen.queryByLabelText("game hud")).toBeNull();
    const keyInput = screen.getByLabelText("island key");
    expect(keyInput.nextElementSibling).toBe(screen.getByRole("button", { name: "Enter" }));

    routes["/state"] = () => reply(200, { keepers: [], dream: { latest_run_id: null, running: false } });
    await userEvent.type(screen.getByLabelText("island key"), "open-sesame{Enter}");
    await waitFor(() => expect(screen.queryByRole("heading", { name: "This island asks for its key" })).toBeNull());
    expect(screen.getByLabelText("game hud")).toBeTruthy();
    const stateCall = globalThis.fetch.mock.calls.findLast(([url]) => url.endsWith("/state"));
    expect(stateCall[1].headers["X-Access-Code"]).toBe("open-sesame");
  });
});
