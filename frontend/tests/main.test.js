// main.js integration wiring: boot, UI mounting, mode transitions on bus
// events, consolidation watch, district tracking, canvas cursor classes,
// state refresh. Scene modules are swapped for the built-in placeholders (no
// WebGL in jsdom); the wiring under test is identical either way.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { waitFor, within } from "@testing-library/dom";
import { createGame, resolveBaseUrl, resolveWorldId, resolveAccessKey } from "../src/main.js";
import { createBus } from "../src/bus.js";
import { config } from "../src/config.js";
import { dreamsKeeper, meetingsKeeper } from "./ui_fixtures.js";

const savedSceneModules = { ...config.sceneModules };

function makeApi(server) {
  return {
    getState: vi.fn(async () => ({
      keepers: [...server.keepers],
      consolidation: { ...server.consolidation },
    })),
    getLatestConsolidation: vi.fn(async () => server.latestReport),
    getConsolidation: vi.fn(async () => server.report),
    listBooks: vi.fn(async () => []),
    getChatter: vi.fn(async () => ({ line: "..." })),
  };
}

function makeGame({ server } = {}) {
  const srv = server ?? {
    keepers: [dreamsKeeper()],
    consolidation: { latest_run_id: null, running: false },
    latestReport: null,
    report: null,
  };
  const appEl = document.createElement("div");
  const uiEl = document.createElement("div");
  document.body.append(appEl, uiEl);
  const api = makeApi(srv);
  const bus = createBus();
  const win = {
    requestAnimationFrame: vi.fn(() => 1),
    cancelAnimationFrame: vi.fn(),
  };
  const game = createGame({ appEl, uiEl, api, bus, win });
  return { game, api, bus, appEl, uiEl, srv };
}

describe("createGame wiring", () => {
  beforeEach(() => {
    config.sceneModules = {}; // placeholders everywhere; wiring is the same
    // jsdom has no canvas backend; the minimap tolerates a null 2d context.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });

  afterEach(() => {
    config.sceneModules = { ...savedSceneModules };
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("resolveWorldId: per-browser world by default, ?world= opens a named one", () => {
    expect(resolveWorldId({ search: "" })).toBe(null);
    expect(resolveWorldId({ search: "?world=demo" })).toBe("demo");
  });

  it("resolveAccessKey: ?key= carries the island key inside a link", () => {
    expect(resolveAccessKey({ search: "" })).toBe(null);
    expect(resolveAccessKey({ search: "?world=demo&key=island-x" })).toBe("island-x");
  });

  it("resolveBaseUrl: same-origin by default, ?api= overrides", () => {
    expect(resolveBaseUrl({ search: "" })).toBe("");
    expect(resolveBaseUrl({ search: "?api=http://127.0.0.1:8000" })).toBe(
      "http://127.0.0.1:8000",
    );
  });

  it("boots into the overworld with hud, toasts and state loaded", async () => {
    const { game, uiEl, api } = makeGame();
    await game.boot();
    expect(game.state.mode).toBe("overworld");
    expect(game.state.keepers).toHaveLength(1);
    expect(api.getState).toHaveBeenCalledTimes(1);
    expect(within(uiEl).getByLabelText("game hud")).toBeTruthy();
    expect(within(uiEl).getByLabelText("minimap")).toBeTruthy();
    expect(uiEl.querySelector(".toast-stack")).toBeTruthy();
  });

  it("house:enter switches to that keeper's interior and back on interior:exit", async () => {
    const { game, bus, uiEl } = makeGame();
    await game.boot();
    bus.emit("house:enter", { keeperId: "dreams" });
    await waitFor(() => expect(game.state.mode).toBe("interior:dreams"));
    // the 3D books are the whole interface inside: no list side panel mounts
    expect(within(uiEl).queryByLabelText("library book list")).toBeNull();
    bus.emit("interior:exit");
    await waitFor(() => expect(game.state.mode).toBe("overworld"));
  });

  it("graph:back returns to the overworld", async () => {
    const { game, bus } = makeGame();
    await game.boot();
    await game.setMode("graph");
    bus.emit("graph:back");
    await waitFor(() => expect(game.state.mode).toBe("overworld"));
  });

  it("keepers_list:open mounts the roster; clicking a row selects her and opens the talk panel", async () => {
    const { game, bus, uiEl } = makeGame();
    await game.boot();
    bus.emit("keepers_list:open");
    const panel = within(uiEl).getByLabelText("keepers list");
    expect(panel.classList.contains("holo-panel")).toBe(true);

    within(panel).getByRole("button", { name: "view Keeper of Dreams" }).click();
    expect(within(uiEl).queryByLabelText("keepers list")).toBeNull(); // closed
    expect(within(uiEl).getByLabelText("talk to Keeper of Dreams")).toBeTruthy(); // dialog opened
  });

  it("keeper:selected records the selection in shared state; leaving for a non-interior mode clears it", async () => {
    const { game, bus } = makeGame();
    await game.boot();
    expect(game.state.selectedKeeperId).toBe(null);

    // Any selection source lands in state (a scene that builds later, e.g.
    // the async interior -> overworld step-out, reads it to apply follow).
    bus.emit("keeper:selected", { keeperId: "dreams" });
    expect(game.state.selectedKeeperId).toBe("dreams");

    // Entering an interior selects its owner.
    await game.setMode("interior:dreams");
    expect(game.state.selectedKeeperId).toBe("dreams");

    // "Back to the island" (or Esc) must not leave a stale selection behind.
    bus.emit("interior:exit");
    await waitFor(() => expect(game.state.mode).toBe("overworld"));
    expect(game.state.selectedKeeperId).toBe(null);
  });

  it("selecting from the keepers list inside an interior re-selects AFTER the mode flip", async () => {
    const { game, bus, uiEl } = makeGame();
    await game.boot();
    await game.setMode("interior:dreams");

    bus.emit("keepers_list:open");
    const panel = within(uiEl).getByLabelText("keepers list");
    within(panel).getByRole("button", { name: "view Keeper of Dreams" }).click();

    // mode:set "overworld" cleared the selection, the row's keeper:selected
    // re-recorded it: the overworld scene builds seeing her selected.
    expect(game.state.selectedKeeperId).toBe("dreams");
    await waitFor(() => expect(game.state.mode).toBe("overworld"));
    expect(game.state.selectedKeeperId).toBe("dreams");
    expect(within(uiEl).getByLabelText("talk to Keeper of Dreams")).toBeTruthy();
  });

  it("keeper:selected opens the talk dialog as a holo comm panel", async () => {
    const { game, bus, uiEl } = makeGame();
    await game.boot();
    bus.emit("keeper:selected", { keeperId: "dreams" });
    const panel = within(uiEl).getByLabelText("talk to Keeper of Dreams");
    expect(panel.classList.contains("holo-panel")).toBe(true); // holo kit frame
    expect(document.querySelectorAll("#holo-kit-style")).toHaveLength(1); // kit styles injected once
  });

  it("consolidation:started polls to done, refreshes state, enters graph mode", async () => {
    const { game, bus, api, srv } = makeGame();
    await game.boot();

    const report = {
      run_id: "run-0007",
      status: "done",
      narrative: "The dreaming connected two shores.",
      created_keepers: [],
      created_books: [],
      graph: { nodes: [], edges: [] },
    };
    srv.report = report;
    srv.keepers = [dreamsKeeper(), meetingsKeeper()]; // a new keeper was born server-side
    const finished = vi.fn();
    bus.on("consolidation:finished", finished);

    bus.emit("consolidation:started", { runId: "run-0007" });
    await waitFor(() => expect(game.state.mode).toBe("graph"));
    expect(api.getConsolidation).toHaveBeenCalledWith("run-0007");
    expect(finished).toHaveBeenCalledWith({ report });
    expect(game.state.latestReport).toEqual(report);
    expect(game.state.keepers).toHaveLength(2); // refreshed from GET /state
  });

  it("resumes polling at boot when a run is already in flight", async () => {
    const report = { run_id: "run-0001", status: "done", graph: { nodes: [], edges: [] } };
    const { game, api } = makeGame({
      server: {
        keepers: [dreamsKeeper()],
        consolidation: { latest_run_id: "run-0001", running: true },
        latestReport: null,
        report,
      },
    });
    await game.boot();
    await waitFor(() => expect(game.state.mode).toBe("graph"));
    expect(api.getConsolidation).toHaveBeenCalledWith("run-0001");
  });

  it("district:changed updates state.district (spatial day/night, no toggle)", async () => {
    const { game, bus } = makeGame();
    await game.boot();
    expect(game.state.district).toBe("day");

    bus.emit("district:changed", { district: "night" });
    expect(game.state.district).toBe("night");
    bus.emit("district:changed", { district: "day" });
    expect(game.state.district).toBe("day");
    bus.emit("district:changed", { district: "??" }); // anything unknown is day
    expect(game.state.district).toBe("day");
  });

  it("canvas pointer events toggle the grab/orbit cursor classes", async () => {
    const { game, appEl } = makeGame();
    await game.boot();
    // jsdom has no PointerEvent; MouseEvent with the pointer type names
    // dispatches to the same listeners and carries `button`.
    const pointer = (type, button = 0) =>
      new MouseEvent(type, { button, bubbles: true });

    appEl.dispatchEvent(pointer("pointerdown", 0));
    expect(appEl.classList.contains("is-grabbing")).toBe(true);
    document.dispatchEvent(pointer("pointerup"));
    expect(appEl.classList.contains("is-grabbing")).toBe(false);

    appEl.dispatchEvent(pointer("pointerdown", 2)); // right-drag = orbit
    expect(appEl.classList.contains("is-orbiting")).toBe(true);
    document.dispatchEvent(pointer("pointercancel"));
    expect(appEl.classList.contains("is-orbiting")).toBe(false);
  });

  it("mounts the onboarding card after boot (no storage on the fake win)", async () => {
    const { game, uiEl } = makeGame();
    await game.boot();
    expect(within(uiEl).getByLabelText("welcome hints")).toBeTruthy();
  });

  it("mounts the cinematic overlay: letterbox + body lock on cinematic:started", async () => {
    const { game, bus, uiEl } = makeGame();
    await game.boot();
    expect(uiEl.querySelector(".mk-cine-fade")).toBeTruthy(); // fade plate ready

    bus.emit("cinematic:started", { keeperId: "dreams", name: "Keeper of Dreams" });
    expect(document.body.classList.contains("ui-cinematic")).toBe(true);
    expect(within(uiEl).getByLabelText("cinematic")).toBeTruthy();
    expect(within(uiEl).getByText("Following Keeper of Dreams home")).toBeTruthy();

    bus.emit("cinematic:ended", { keeperId: "dreams" });
    expect(document.body.classList.contains("ui-cinematic")).toBe(false);
  });

  it("Esc during a cinematic skips it instead of switching modes", async () => {
    const { game, bus } = makeGame();
    await game.boot();
    await game.setMode("interior:dreams"); // Esc would normally exit to overworld
    const skipped = vi.fn();
    bus.on("cinematic:skip", skipped);
    bus.emit("cinematic:started", { keeperId: "dreams", name: "Keeper of Dreams" });

    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(skipped).toHaveBeenCalledWith({ keeperId: "dreams" });
    expect(game.state.mode).toBe("interior:dreams"); // mode untouched: Esc was swallowed

    bus.emit("cinematic:ended", { keeperId: "dreams" });
  });

  it("keeper:created and book:destroyed refresh state from the engine", async () => {
    const { game, bus, api, srv } = makeGame();
    await game.boot();
    expect(api.getState).toHaveBeenCalledTimes(1);

    srv.keepers = [dreamsKeeper(), meetingsKeeper()];
    bus.emit("keeper:created", meetingsKeeper());
    await waitFor(() => expect(game.state.keepers).toHaveLength(2));
    expect(api.getState).toHaveBeenCalledTimes(2);

    srv.keepers = [dreamsKeeper()];
    bus.emit("book:destroyed", { keeperId: "dreams", slug: "x" });
    await waitFor(() => expect(game.state.keepers).toHaveLength(1));
    expect(api.getState).toHaveBeenCalledTimes(3);
  });

  it("keeper:rested refreshes state so scenes re-read session status (sleep done)", async () => {
    const { game, bus, api, srv } = makeGame();
    await game.boot();
    expect(api.getState).toHaveBeenCalledTimes(1);

    srv.keepers = [
      { ...dreamsKeeper(), level: 2, session: { tokens_used: 12, budget: 1000, status: "rested" } },
    ];
    const loaded = vi.fn();
    bus.on("state:loaded", loaded);
    bus.emit("keeper:rested", { keeperId: "dreams" });
    await waitFor(() => expect(api.getState).toHaveBeenCalledTimes(2));
    expect(game.state.keepers[0].session.status).toBe("rested");
    expect(loaded).toHaveBeenCalledTimes(1); // scenes re-apply setTired from this
  });

  it("keeper:sleep and memory:used are scene-level: no mode switch, no refresh", async () => {
    const { game, bus, api } = makeGame();
    await game.boot();
    bus.emit("keeper:sleep", { keeperId: "dreams" });
    bus.emit("memory:used", { keeperId: "dreams", slugs: ["x"] });
    await Promise.resolve();
    expect(game.state.mode).toBe("overworld"); // ambient, not a cinematic or a mode
    expect(api.getState).toHaveBeenCalledTimes(1); // only the boot call
  });

  it("boot rejects when the engine is unreachable (connect screen path)", async () => {
    const { game, api } = makeGame();
    api.getState.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(game.boot()).rejects.toThrow("ECONNREFUSED");
    expect(game.state.mode).toBe(null);
  });
});
