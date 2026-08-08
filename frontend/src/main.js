// Entry point: boot, mode switching, rAF game loop, shared state.
//
// Scene wiring is data-driven: config.sceneModules maps a mode key to a module
// path. Each scene module exports one factory (default export or any export
// matching /^create.*Scene$/) called as factory(ctx) where
//   ctx = { state, bus, api, config, container, ui }
// and returns { update(dt), dispose(), ... }. If the module is missing or
// broken, an animated DOM placeholder takes its place, so the core runs before
// (and without) the render/ modules. Integrators only flip config entries.

import { config } from "./config.js";
import { createBus } from "./bus.js";
import { createApi, ApiError } from "./api/api.js";
import { createToasts } from "./ui/toasts.js";
import { createConfirm } from "./ui/confirm.js";
import { createHowto } from "./ui/howto.js";
import { createHud } from "./ui/hud.js";
import { createDialog } from "./ui/dialog.js";
import { createReader } from "./ui/reader.js";
import { createCreateKeeper } from "./ui/create_keeper.js";
import { createKeepersList } from "./ui/keepers_list.js";
import { createMinimap } from "./ui/minimap.js";
import { createCinematic } from "./ui/cinematic.js";
import { createOnboarding } from "./ui/onboarding.js";
import { startConsolidationWatch } from "./ui/graph_hud.js";
import { createAudio } from "./render/audio.js";

export function resolveBaseUrl(loc = globalThis.location) {
  // Same-origin by default; ?api=http://127.0.0.1:8000 overrides (dev setup
  // serves the frontend on :8080 and the engine on :8000).
  const override = new URLSearchParams(loc.search).get("api");
  return override || "";
}

function modeKey(mode) {
  return String(mode).split(":")[0];
}

function modeTitle(mode) {
  const key = modeKey(mode);
  if (key === "interior") {
    const keeperId = String(mode).split(":")[1];
    return keeperId ? `${keeperId}'s library` : "library";
  }
  if (key === "graph") return "the dreaming";
  return "keeper island";
}

// Fallback scene: animated gradient + title, no three.js involved.
function createPlaceholderScene({ container, mode }) {
  const doc = container.ownerDocument;
  const el = doc.createElement("div");
  el.className = "scene-placeholder";
  const title = doc.createElement("div");
  title.className = "scene-title";
  title.textContent = modeTitle(mode);
  const sub = doc.createElement("div");
  sub.className = "scene-sub";
  sub.textContent = "this scene has not materialized yet";
  el.appendChild(title);
  el.appendChild(sub);
  container.appendChild(el);
  return {
    placeholder: true,
    update() {}, // CSS animates the gradient
    dispose() {
      el.remove();
    },
  };
}

function pickSceneFactory(mod) {
  if (typeof mod?.default === "function") return mod.default;
  for (const [name, value] of Object.entries(mod ?? {})) {
    if (typeof value === "function" && /^create.*scene$/i.test(name)) return value;
  }
  return null;
}

export function createGame({ appEl, uiEl, api, bus = createBus(), win = globalThis } = {}) {
  const doc = appEl.ownerDocument;

  // Shared state, owned here. Everyone else reads it and listens on the bus.
  const state = {
    keepers: [],
    mode: null, // "overworld" | "interior:<keeperId>" | "graph"
    selectedKeeperId: null,
    district: "day", // which district the camera is over ("day" | "night")
    latestReport: null,
  };

  const ui = {
    toasts: createToasts({ root: uiEl }),
    confirm: createConfirm({ root: uiEl }),
    howto: createHowto({ root: uiEl }),
  };
  // Feature UI, mounted once at boot. Each subscribes to the bus itself:
  // hud drives create/dreaming/mute and opens the keepers list
  // ("keepers_list:open"), dialog opens on "keeper:selected", reader on
  // "book:open" (inside the interior the 3D books themselves are the
  // interface; there is no list panel), create_keeper on "create_keeper:open",
  // minimap redraws on "minimap:update", cinematic letterboxes on
  // "cinematic:started" (the Join sequence), onboarding shows once after the
  // first "state:loaded", audio turns bus events into blips.
  ui.hud = createHud({ root: uiEl, state, bus, api, toasts: ui.toasts });
  ui.dialog = createDialog({ root: uiEl, state, bus, api, toasts: ui.toasts });
  ui.reader = createReader({ root: uiEl, state, bus, api, toasts: ui.toasts, confirm: ui.confirm });
  ui.createKeeper = createCreateKeeper({ root: uiEl, state, bus, api, toasts: ui.toasts });
  ui.keepersList = createKeepersList({ root: uiEl, state, bus });
  ui.minimap = createMinimap({ root: uiEl, state, bus, config });
  ui.cinematic = createCinematic({ root: uiEl, state, bus });
  ui.onboarding = createOnboarding({ root: uiEl, bus, storage: win.localStorage ?? null });
  ui.audio = createAudio({ bus, target: win });

  // Cursor language for the canvas: CSS makes #app show a grab cursor;
  // while a pointer is held down we flip to grabbing (pan) or move (middle
  // -drag orbit). Classes only, the camera rig in render/ is untouched.
  function onCanvasPointerDown(e) {
    appEl.classList.add(e.button === 2 ? "is-orbiting" : "is-grabbing");
  }
  function onCanvasPointerEnd() {
    appEl.classList.remove("is-grabbing", "is-orbiting");
  }
  appEl.addEventListener("pointerdown", onCanvasPointerDown);
  doc.addEventListener("pointerup", onCanvasPointerEnd);
  doc.addEventListener("pointercancel", onCanvasPointerEnd);

  let activeScene = null;
  let rafId = null;
  let lastTime = null;
  let modeGeneration = 0;

  async function loadScene(mode) {
    const key = modeKey(mode);
    const path = config.sceneModules[key];
    const ctx = { state, bus, api, config, container: appEl, ui, mode };
    if (!path) return createPlaceholderScene(ctx);
    try {
      const mod = await import(path);
      const factory = pickSceneFactory(mod);
      if (!factory) throw new Error(`no scene factory exported by ${path}`);
      return factory(ctx);
    } catch (err) {
      console.warn(`[memory-keepers] scene "${key}" unavailable, using placeholder:`, err);
      return createPlaceholderScene(ctx);
    }
  }

  async function setMode(mode) {
    const prev = state.mode;
    if (mode === prev) return;
    const generation = ++modeGeneration;

    state.mode = mode;
    if (modeKey(mode) === "interior") {
      state.selectedKeeperId = String(mode).split(":")[1] ?? null;
    } else {
      // Leaving for the overworld or the graph drops any stale selection
      // ("Back to the island" must not leave the exited keeper ringed and
      // followed). A selection flow that crosses modes (the keepers list
      // stepping out of an interior) emits "keeper:selected" right after its
      // "mode:set", so the handler below re-selects her before the new
      // scene builds and applies the follow framing.
      state.selectedKeeperId = null;
    }
    bus.emit("mode:changed", { mode, prev });

    if (activeScene) {
      try {
        activeScene.dispose?.();
      } catch (err) {
        console.warn("[memory-keepers] scene dispose failed:", err);
      }
      activeScene = null;
    }

    const scene = await loadScene(mode);
    if (generation !== modeGeneration) {
      // A newer setMode won the race; drop this scene.
      scene.dispose?.();
      return;
    }
    activeScene = scene;
    bus.emit("scene:ready", { mode, scene });
  }

  function tick(now) {
    rafId = win.requestAnimationFrame(tick);
    if (lastTime === null) lastTime = now;
    const dt = Math.min((now - lastTime) / 1000, 0.1); // clamp tab-switch jumps
    lastTime = now;
    activeScene?.update?.(dt);
    bus.emit("tick", dt);
  }

  function start() {
    if (rafId === null) rafId = win.requestAnimationFrame(tick);
  }

  function stop() {
    if (rafId !== null) {
      win.cancelAnimationFrame(rafId);
      rafId = null;
      lastTime = null;
    }
  }

  // --- state refresh (create/destroy/seed all funnel through GET /state) ---
  async function refreshState() {
    const res = await api.getState();
    state.keepers = res.keepers ?? [];
    bus.emit("state:loaded", { state, consolidation: res.consolidation ?? {} });
    return res;
  }

  // --- consolidation watcher (poll until done, then play the movie) ---
  let watcher = null;
  function watchConsolidation(runId) {
    if (!runId) return;
    watcher?.stop();
    watcher = startConsolidationWatch({
      api,
      bus,
      runId,
      intervalMs: config.CONSOLIDATION_POLL_MS,
    });
  }

  // --- global wiring ---
  bus.on("mode:set", (mode) => setMode(mode));
  // Selection is shared state owned here: every "keeper:selected" source (a
  // scene pick, the keepers list, the interior) lands in state.selectedKeeperId,
  // so a scene that builds AFTER the emit (the async interior -> overworld
  // step-out) still sees who is selected and can apply the follow framing.
  bus.on("keeper:selected", (p) => {
    const keeperId = typeof p === "string" ? p : p?.keeperId;
    if (keeperId) state.selectedKeeperId = keeperId;
  });
  bus.on("toast", (payload) => {
    if (typeof payload === "string") ui.toasts.show(payload);
    else ui.toasts.show(payload.message, payload);
  });
  bus.on("howto:open", () => ui.howto.open());

  bus.on("house:enter", (p) => {
    const keeperId = typeof p === "string" ? p : p?.keeperId;
    if (keeperId) setMode(`interior:${keeperId}`);
  });
  bus.on("interior:exit", () => setMode("overworld"));
  bus.on("graph:back", () => setMode("overworld"));

  bus.on("consolidation:started", (p) => watchConsolidation(p?.runId ?? p?.run_id));
  bus.on("consolidation:finished", async (p) => {
    const report = p?.report ?? p ?? null;
    if (report?.graph) {
      state.latestReport = report;
      bus.emit("report:loaded", report);
    }
    // Unconscious keepers may have been born; sync before the movie starts.
    await refreshState().catch(() => {});
    await setMode("graph");
  });

  // Day/night is spatial: the overworld emits "district:changed" whenever the
  // camera's dominant district flips. Track it so the HUD label and any panel
  // opened later can read the current district from shared state.
  bus.on("district:changed", (p) => {
    state.district = p?.district === "night" ? "night" : "day";
  });

  bus.on("keeper:created", () => refreshState().catch(() => {}));
  bus.on("book:created", () => refreshState().catch(() => {}));
  bus.on("book:destroyed", () => refreshState().catch(() => {}));
  // Sleep finished (the chat panel's poll emits "keeper:rested"): re-sync so
  // the fresh session status reaches the scenes via "state:loaded" (both
  // scenes re-apply mesh.setTired from it; the visuals never depend on
  // which scene is active).
  bus.on("keeper:rested", () => refreshState().catch(() => {}));

  doc.addEventListener("keydown", (e) => {
    // Overlays (confirm/howto) handle Escape in the capture phase and stop
    // propagation, so this only fires when no overlay is open.
    if (e.key === "Escape" && state.mode && state.mode !== "overworld") {
      setMode("overworld");
    }
  });

  async function boot() {
    const res = await api.getState(); // throws -> caller shows connect screen
    state.keepers = res.keepers ?? [];
    const consolidation = res.consolidation ?? {};
    bus.emit("state:loaded", { state, consolidation });

    if (consolidation.running && consolidation.latest_run_id) {
      // A run was already in flight (e.g. page reload mid-dream): resume polling.
      watchConsolidation(consolidation.latest_run_id);
    } else if (consolidation.latest_run_id) {
      // Best-effort: the graph HUD only needs this eventually.
      api
        .getLatestConsolidation()
        .then((report) => {
          state.latestReport = report;
          bus.emit("report:loaded", report);
        })
        .catch(() => {});
    }

    await setMode("overworld");
    start();
  }

  return {
    state,
    bus,
    api,
    ui,
    boot,
    setMode,
    refreshState,
    start,
    stop,
    get activeScene() {
      return activeScene;
    },
  };
}

// Friendly connect/retry screen shown while the engine is unreachable.
function showConnectScreen(uiEl, { baseUrl, error, onRetry }) {
  const doc = uiEl.ownerDocument;
  const screen = doc.createElement("div");
  screen.className = "center-screen";

  const panel = doc.createElement("div");
  panel.className = "panel connect-panel";

  const face = doc.createElement("div");
  face.className = "face";
  face.textContent = "( . _ . )";

  const title = doc.createElement("h2");
  title.className = "panel-title";
  title.textContent = "The keepers are still asleep";

  const message = doc.createElement("p");
  const where = baseUrl || "this page's origin";
  const detail = error instanceof ApiError && error.message ? ` (${error.message})` : "";
  message.textContent = `Could not reach the engine at ${where}${detail}. Start it, or point me elsewhere with ?api=<url>.`;

  const retry = doc.createElement("button");
  retry.type = "button";
  retry.className = "btn btn-primary";
  retry.textContent = "Try again";
  retry.addEventListener("click", async () => {
    retry.disabled = true;
    retry.textContent = "Knocking...";
    try {
      await onRetry();
      screen.remove();
    } catch {
      retry.disabled = false;
      retry.textContent = "Try again";
    }
  });

  panel.appendChild(face);
  panel.appendChild(title);
  panel.appendChild(message);
  panel.appendChild(retry);
  screen.appendChild(panel);
  uiEl.appendChild(screen);
  return screen;
}

async function bootInBrowser() {
  const appEl = document.getElementById("app");
  const uiEl = document.getElementById("ui");
  const baseUrl = resolveBaseUrl();
  const api = createApi({ baseUrl });
  const game = createGame({ appEl, uiEl, api });
  globalThis.__keeperBrain = game; // console access for debugging

  try {
    await game.boot();
  } catch (error) {
    console.warn("[memory-keepers] engine unreachable:", error);
    showConnectScreen(uiEl, { baseUrl, error, onRetry: () => game.boot() });
  }
}

// Auto-boot only when loaded in the real page (not under tests/imports).
if (typeof document !== "undefined" && document.getElementById("app")) {
  bootInBrowser();
}
