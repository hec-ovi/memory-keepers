// Top HUD bar: keeper/book counts, the View keepers button, and the action
// buttons (Create keeper, Dreaming, How to play, Demo data, and world travel:
// Export island on a lived-in island, Import island on an empty one). Factory
// per the module contract, no module-level side effects:
//
//   const hud = createHud({ root, state, bus, api, toasts, reload });
//
// Bus wiring:
//   emits   "create_keeper:open"                     Create keeper button
//   emits   "consolidation:started" { runId }      after POST /dream
//   emits   "howto:open"                           How to play button
//   emits   "keepers_list:open"                      View keepers button (opens the
//                                                  holo list of everyone on the
//                                                  island; the crossing shortcut
//                                                  lives inside that list)
//   emits   "state:loaded" { state, consolidation } after Demo data reloads state
//   listens "state:loaded"            initial counts + consolidation.running
//   listens "consolidation:finished" / "report:loaded"  re-enables Dreaming
//   listens "keeper:created" / "book:created" / "book:destroyed"  refreshes counts
//
// Dreaming is disabled while a run is active or a request is in flight; a
// 409 CONSOLIDATION_RUNNING marks the run active and toasts. Demo data only
// shows while there are zero keepers. Buttons carry small [data-tooltip]
// bubbles; the counters do a tiny scale pop when their number changes.

import { injectStyle, makeEl } from "./holo/holo.js";

const TOOLTIPS = {
  keepers: "Everyone on the island: her level, her books, how rested she is",
  create: "A new memory keeper moves in",
  dreaming: "Send your keepers to sleep so they can consolidate",
  seed: "Load a small demo world to explore",
  exportWorld: "Save the whole island as one file you can carry anywhere",
  importWorld: "Bring an island file here; it becomes your island",
  howto: "Controls and what everything means",
};

const STYLE_ID = "mk-hud-style";
const CSS = `
.mk-hud{position:absolute;top:10px;left:12px;right:12px;display:flex;align-items:center;gap:10px;padding:8px 14px;z-index:30;flex-wrap:wrap;}
.mk-hud-stat{font-size:.88rem;font-weight:700;font-family:var(--font-display,inherit);letter-spacing:.04em;color:var(--text-dim,#c99a66);white-space:nowrap;display:inline-block;}
.mk-hud-stat b{color:var(--text,#ffd3a1);}
.mk-hud-spacer{flex:1;}
.mk-hud .btn{padding:7px 13px;font-size:.78rem;}
/* View keepers opens the roster: cyan accent against the amber chrome */
.mk-hud-keepers{border-color:rgba(63,224,255,.45);color:var(--lavender,#3fe0ff);background:rgba(63,224,255,.08);}
.mk-hud-keepers:hover{background:rgba(63,224,255,.18);box-shadow:0 0 14px rgba(63,224,255,.45);}
`;

export function createHud({ root, state, bus, api, toasts, ui, reload } = {}) {
  const reloadPage = reload ?? (() => globalThis.location?.reload?.());
  const doc = root.ownerDocument;
  const notify = toasts ?? ui?.toasts ?? null;
  injectStyle(doc, STYLE_ID, CSS);

  // "state:loaded" carries consolidation as its own payload field; the shared
  // state object never holds it, so a run is only known once that event lands.
  let running = false;
  let consolidating = false;
  let seeding = false;
  const offs = [];

  const el = makeEl(doc);

  const toast = {
    error: (m) => (notify ? notify.error(m) : bus?.emit("toast", { message: m, kind: "error" })),
    success: (m) => (notify ? notify.success(m) : bus?.emit("toast", { message: m, kind: "success" })),
    info: (m) => (notify ? notify.show(m) : bus?.emit("toast", { message: m })),
  };

  const bar = el("header", "mk-hud panel");
  bar.setAttribute("aria-label", "game hud");

  const keeperStat = el("span", "mk-hud-stat");
  const bookStat = el("span", "mk-hud-stat");
  const spacer = el("div", "mk-hud-spacer");

  // Sets the text and, when the value actually changed, replays a tiny
  // scale-pop animation (class removed + reflow + re-added).
  const setStat = (node, text) => {
    if (node.textContent === text) return;
    const pop = node.textContent !== "";
    node.textContent = text;
    if (!pop) return;
    node.classList.remove("stat-pop");
    void node.offsetWidth; // restart the CSS animation
    node.classList.add("stat-pop");
  };

  const keepersBtn = el("button", "mk-hud-keepers btn btn-ghost", "View keepers");
  keepersBtn.type = "button";
  keepersBtn.setAttribute("data-tooltip", TOOLTIPS.keepers);
  keepersBtn.addEventListener("click", () => bus?.emit("keepers_list:open"));

  const createBtn = el("button", "btn btn-primary", "Create keeper");
  createBtn.type = "button";
  createBtn.setAttribute("data-tooltip", TOOLTIPS.create);
  createBtn.addEventListener("click", () => bus?.emit("create_keeper:open"));

  const dreamBtn = el("button", "btn", "Dreaming");
  dreamBtn.type = "button";
  dreamBtn.setAttribute("data-tooltip", TOOLTIPS.dreaming);
  dreamBtn.addEventListener("click", async () => {
    if (running || consolidating) return;
    consolidating = true;
    refresh();
    try {
      const res = await api.consolidate();
      running = true;
      bus?.emit("consolidation:started", { runId: res?.run_id });
      toast.info("the keepers drift into sleep...");
    } catch (err) {
      if (err?.status === 409 || err?.code === "CONSOLIDATION_RUNNING") {
        running = true;
        // Always the warm line: the engine's 409 message speaks in
        // consolidation words the player never reads.
        toast.error("they are already dreaming");
      } else {
        toast.error(err?.message || "the dreaming would not begin");
      }
    } finally {
      consolidating = false;
      refresh();
    }
  });

  const seedBtn = el("button", "btn", "Demo data");
  seedBtn.type = "button";
  seedBtn.setAttribute("data-tooltip", TOOLTIPS.seed);
  seedBtn.addEventListener("click", async () => {
    if (seeding) return;
    seeding = true;
    refresh();
    try {
      const res = await api.seed();
      const st = await api.getState().catch(() => null);
      if (st && state) {
        state.keepers = st.keepers ?? state.keepers;
        bus?.emit("state:loaded", { state, consolidation: st.consolidation ?? {} });
      }
      toast.success(`demo data loaded: ${res?.keepers ?? "?"} keepers, ${res?.books ?? "?"} books`);
    } catch (err) {
      toast.error(err?.message || "the demo world would not load");
    } finally {
      seeding = false;
      refresh();
    }
  });

  // World travel: export shows on a lived-in island, import on an empty one
  // (an import always lands on a fresh island id, then the page reloads into it).
  const exportBtn = el("button", "btn", "Export island");
  exportBtn.type = "button";
  exportBtn.setAttribute("data-tooltip", TOOLTIPS.exportWorld);
  exportBtn.addEventListener("click", async () => {
    try {
      const data = await api.exportWorld();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = el("a");
      a.href = url;
      a.download = `memory-keepers-island-${(data?.exported_at ?? "").slice(0, 10) || "export"}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("the island is saved as a file");
    } catch (err) {
      toast.error(err?.message || "the island would not export");
    }
  });

  // Blob.text() is missing in older engines; FileReader reads everywhere.
  const readFile = (file) =>
    typeof file.text === "function"
      ? file.text()
      : new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.onerror = () => reject(r.error);
          r.readAsText(file);
        });

  const importInput = el("input");
  importInput.type = "file";
  importInput.accept = "application/json,.json";
  importInput.hidden = true;
  importInput.setAttribute("aria-label", "island file");
  importInput.addEventListener("change", async () => {
    const file = importInput.files?.[0];
    importInput.value = "";
    if (!file) return;
    try {
      const res = await api.importWorld(JSON.parse(await readFile(file)));
      api.setWorldId(res.world);
      toast.success("the island has arrived");
      reloadPage();
    } catch (err) {
      toast.error(err instanceof SyntaxError || err?.code === "IMPORT_INVALID"
        ? "that file is not an island"
        : err?.message || "the island would not import");
    }
  });
  const importBtn = el("button", "btn", "Import island");
  importBtn.type = "button";
  importBtn.setAttribute("data-tooltip", TOOLTIPS.importWorld);
  importBtn.addEventListener("click", () => importInput.click());

  const howtoBtn = el("button", "btn btn-ghost", "How to play");
  howtoBtn.type = "button";
  howtoBtn.setAttribute("data-tooltip", TOOLTIPS.howto);
  howtoBtn.addEventListener("click", () => bus?.emit("howto:open"));

  bar.append(keeperStat, bookStat, keepersBtn, spacer, createBtn, dreamBtn, howtoBtn, importInput);
  root.appendChild(bar);

  function refresh() {
    const keepers = state?.keepers ?? [];
    const bookCount = keepers.reduce((sum, a) => sum + (a.book_count ?? 0), 0);
    setStat(keeperStat, `${keepers.length} keepers`);
    setStat(bookStat, `${bookCount} books`);

    dreamBtn.disabled = running || consolidating;

    seedBtn.disabled = seeding;
    const empty = keepers.length === 0;
    const place = (btn, show) => {
      if (show && !bar.contains(btn)) bar.insertBefore(btn, howtoBtn);
      else if (!show && bar.contains(btn)) btn.remove();
    };
    place(seedBtn, empty);
    place(importBtn, empty);
    place(exportBtn, !empty);
  }

  const on = (event, fn) => offs.push(bus?.on?.(event, fn) ?? (() => {}));
  on("state:loaded", (p) => {
    running = !!p?.consolidation?.running;
    refresh();
  });
  on("consolidation:finished", () => {
    running = false;
    refresh();
  });
  on("report:loaded", () => {
    running = false;
    refresh();
  });
  on("keeper:created", (keeper) => {
    if (keeper?.id && Array.isArray(state?.keepers) && !state.keepers.some((a) => a.id === keeper.id)) {
      state.keepers.push(keeper);
    }
    refresh();
  });
  on("book:created", refresh);
  on("book:destroyed", refresh);

  refresh();

  return {
    dispose() {
      for (const off of offs) off();
      bar.remove();
    },
  };
}
