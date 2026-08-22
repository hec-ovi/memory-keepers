// Entry point: boot, mode switching, rAF game loop, shared state.
//
// Scene wiring is data-driven: config.sceneModules maps a mode key to a module
// path. Each scene module exports one factory (default export or any export
// matching /^create.*Scene$/) called as factory(ctx) where
//   ctx = { state, bus, api, config, container, mode }
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

export function resolveBaseUrl(loc = globalThis.location) {
  // Same-origin by default; ?api=http://127.0.0.1:8000 overrides (dev setup
  // serves the frontend on :8080 and the engine on :8000).
  const override = new URLSearchParams(loc.search).get("api");
  return override || "";
}

export function resolveWorldId(loc = globalThis.location) {
  // Worlds are per-browser by default; ?world=demo opens a named world
  // (shared demo data, the video, judging walkthroughs).
  return new URLSearchParams(loc.search).get("world");
}

export function resolveAccessKey(loc = globalThis.location) {
  // ?key=... carries the island key inside a shared link, so judges land
  // straight in the game; it is remembered and never needs typing.
  return new URLSearchParams(loc.search).get("key");
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
  // Feature UI, mounted once when boot passes its gate (engine reachable,
  // model answering, state loaded). Until then a boot screen is the only
  // thing on the page, so nothing can fire a request behind it. Each piece
  // subscribes to the bus itself: hud drives create/dreaming and opens the
  // keepers list ("keepers_list:open"), dialog opens on "keeper:selected",
  // reader on "book:open" (inside the interior the 3D books themselves are
  // the interface; there is no list panel), create_keeper on
  // "create_keeper:open", minimap redraws on "minimap:update", cinematic
  // letterboxes on "cinematic:started" (the Join sequence), onboarding shows
  // once after the first "state:loaded".
  function mountFeatureUi() {
    if (ui.hud) return;
    ui.hud = createHud({ root: uiEl, state, bus, api, toasts: ui.toasts });
    ui.dialog = createDialog({ root: uiEl, state, bus, api, toasts: ui.toasts });
    ui.reader = createReader({ root: uiEl, state, bus, api, toasts: ui.toasts, confirm: ui.confirm });
    ui.createKeeper = createCreateKeeper({ root: uiEl, state, bus, api, toasts: ui.toasts });
    ui.keepersList = createKeepersList({ root: uiEl, state, bus });
    ui.minimap = createMinimap({ root: uiEl, state, bus, config });
    ui.cinematic = createCinematic({ root: uiEl, state, bus });
    ui.onboarding = createOnboarding({ root: uiEl, bus, storage: win.localStorage ?? null });
  }

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
    const ctx = { state, bus, api, config, container: appEl, mode };
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
    // The engine's health is the gate: the game opens only on status "ok"
    // (engine reachable, model answering). Anything else throws before any
    // feature UI exists, and the page stays blocked behind a boot screen.
    const health = await api.health(); // an unreachable engine throws here
    if (health?.status !== "ok") {
      throw new ApiError({
        status: 503,
        code: "MODEL_DOWN",
        message: `The ${health?.tier ?? "configured"} model is not answering`,
      });
    }
    const res = await api.getState(); // ACCESS_REQUIRED lands on the key screen
    mountFeatureUi();
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

// Boot screens own the page: no feature UI exists until boot passes, so the
// panel is the only thing to click. Retry runs boot again; the next failure
// (or success) replaces the screen, so it always matches the last error.
function blockBoot(uiEl, ctx, error, { badKey = false } = {}) {
  console.warn("[memory-keepers] boot refused:", error);
  const retry = async (screen) => {
    try {
      await ctx.game.boot();
    } catch (next) {
      const sameKey = error?.code === "ACCESS_REQUIRED" && next?.code === "ACCESS_REQUIRED";
      blockBoot(uiEl, ctx, next, { badKey: sameKey });
    }
    screen.close();
  };
  if (error?.code === "ACCESS_REQUIRED") showKeyScreen(uiEl, { api: ctx.api, badKey, retry });
  else showErrorScreen(uiEl, { baseUrl: ctx.baseUrl, error, retry });
}

function openBootScreen(uiEl, { title, message }) {
  const doc = uiEl.ownerDocument;
  const screen = doc.createElement("div");
  screen.className = "center-screen";
  const panel = doc.createElement("div");
  panel.className = "panel boot-panel";
  const heading = doc.createElement("h2");
  heading.className = "panel-title";
  heading.textContent = title;
  const text = doc.createElement("p");
  text.textContent = message;
  panel.append(heading, text);
  screen.appendChild(panel);
  uiEl.appendChild(screen);
  return { doc, panel, close: () => screen.remove() };
}

// The action button of a boot screen: one click, busy until the retry settles
// (the screen is replaced or removed by then).
function bootButton(doc, { label, busy, action }) {
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "btn btn-primary";
  button.textContent = label;
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = busy;
    await action();
  });
  return button;
}

function bootErrorMessage(baseUrl, error) {
  if (error?.code === "MODEL_DOWN") {
    return `${error.message}. Start the model server, or edit .env (MODEL_TIER, LOCAL_MODEL_URL, LOCAL_MODEL_ID) and run docker compose up -d again.`;
  }
  const where = baseUrl || "this page's origin";
  const detail = error instanceof ApiError && error.message ? ` (${error.message})` : "";
  return `Could not reach the engine at ${where}${detail}. Start it with docker compose up -d, or point this page elsewhere with ?api=<url>.`;
}

// Error screen: the engine is unreachable or its health is not ok.
function showErrorScreen(uiEl, { baseUrl, error, retry }) {
  const screen = openBootScreen(uiEl, { title: "API ERROR", message: bootErrorMessage(baseUrl, error) });
  screen.panel.appendChild(
    bootButton(screen.doc, { label: "Try again", busy: "Knocking...", action: () => retry(screen) }),
  );
}

// Key screen: the engine asked for the island key (ACCESS_CODE). Judges and
// friends type it once; it is kept in localStorage and sent from then on.
function showKeyScreen(uiEl, { api, badKey, retry }) {
  const screen = openBootScreen(uiEl, {
    title: "This island asks for its key",
    message: badKey ? "That key does not fit. Try again." : "Enter the access key to wake the keepers.",
  });
  const face = screen.doc.createElement("div");
  face.className = "face";
  face.textContent = "( ' _ ' )";
  screen.panel.prepend(face);

  const input = screen.doc.createElement("input");
  input.className = "input";
  input.type = "password";
  input.setAttribute("aria-label", "island key");
  const enter = bootButton(screen.doc, {
    label: "Enter",
    busy: "Unlocking...",
    action: () => {
      api.setAccessCode(input.value.trim());
      return retry(screen);
    },
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") enter.click();
  });
  screen.panel.append(input, enter);
}

async function bootInBrowser() {
  const appEl = document.getElementById("app");
  const uiEl = document.getElementById("ui");
  const baseUrl = resolveBaseUrl();
  const api = createApi({ baseUrl, worldId: resolveWorldId() });
  const urlKey = resolveAccessKey();
  if (urlKey) api.setAccessCode(urlKey);
  const game = createGame({ appEl, uiEl, api });
  globalThis.__keeperBrain = game; // console access for debugging

  try {
    await game.boot();
  } catch (error) {
    blockBoot(uiEl, { game, api, baseUrl }, error);
  }
}

// Auto-boot only when loaded in the real page (not under tests/imports).
if (typeof document !== "undefined" && document.getElementById("app")) {
  bootInBrowser();
}
