// Top HUD bar: keeper/book counts, the View keepers button, and the action
// buttons (Create keeper, Dreaming, How to play, Demo data, mute). Factory
// per the module contract, no module-level side effects:
//
//   const hud = createHud({ root, state, bus, api, toasts });
//
// Bus wiring:
//   emits   "create_keeper:open"                     Create keeper button
//   emits   "consolidation:started" { runId }      after POST /dream
//   emits   "howto:open"                           How to play button
//   emits   "keepers_list:open"                      View keepers button (opens the
//                                                  holo list of everyone on the
//                                                  island; the crossing shortcut
//                                                  lives inside that list)
//   emits   "audio:mute" { muted }                 mute button
//   emits   "state:loaded" { state, consolidation } after Demo data reloads state
//   listens "state:loaded"            initial counts + consolidation.running
//   listens "consolidation:finished" / "report:loaded"  re-enables Dreaming
//   listens "keeper:created" / "book:created" / "book:destroyed"  refreshes counts
//
// Dreaming is disabled while a run is active or a request is in flight; a
// 409 CONSOLIDATION_RUNNING marks the run active and toasts. Demo data only
// shows while there are zero keepers. Buttons carry small [data-tooltip]
// bubbles; the counters do a tiny scale pop when their number changes.

const TOOLTIPS = {
  keepers: "Everyone on the island: her level, her books, how rested she is",
  create: "A new memory keeper moves in",
  dreaming: "Send your keepers to sleep so they can consolidate",
  seed: "Load a small demo world to explore",
  howto: "Controls and what everything means",
  mute: "Toggle the game sounds",
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
.mk-hud-mute{min-width:44px;}
`;

function ensureStyles(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

export function createHud({ root, state, bus, api, toasts, ui } = {}) {
  const doc = root.ownerDocument;
  const notify = toasts ?? ui?.toasts ?? null;
  ensureStyles(doc);

  let running = !!state?.consolidation?.running;
  let consolidating = false;
  let seeding = false;
  let muted = false;
  const offs = [];

  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

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

  const howtoBtn = el("button", "btn btn-ghost", "How to play");
  howtoBtn.type = "button";
  howtoBtn.setAttribute("data-tooltip", TOOLTIPS.howto);
  howtoBtn.addEventListener("click", () => bus?.emit("howto:open"));

  const muteBtn = el("button", "mk-hud-mute btn btn-ghost");
  muteBtn.type = "button";
  muteBtn.setAttribute("aria-label", "toggle sound");
  muteBtn.setAttribute("aria-pressed", "false");
  muteBtn.setAttribute("data-tooltip", TOOLTIPS.mute);
  muteBtn.addEventListener("click", () => {
    muted = !muted;
    bus?.emit("audio:mute", { muted });
    refresh();
  });

  bar.append(keeperStat, bookStat, keepersBtn, spacer, createBtn, dreamBtn, howtoBtn, muteBtn);
  root.appendChild(bar);

  function refresh() {
    const keepers = state?.keepers ?? [];
    const bookCount = keepers.reduce((sum, a) => sum + (a.book_count ?? 0), 0);
    setStat(keeperStat, `${keepers.length} keepers`);
    setStat(bookStat, `${bookCount} books`);

    dreamBtn.disabled = running || consolidating;
    muteBtn.textContent = muted ? "🔇" : "🔊";
    muteBtn.setAttribute("aria-pressed", String(muted));

    seedBtn.disabled = seeding;
    const showSeed = keepers.length === 0;
    if (showSeed && !bar.contains(seedBtn)) bar.insertBefore(seedBtn, howtoBtn);
    else if (!showSeed && bar.contains(seedBtn)) seedBtn.remove();
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
    element: bar,
    refresh,
    isMuted: () => muted,
    dispose() {
      for (const off of offs) off();
      bar.remove();
    },
  };
}
