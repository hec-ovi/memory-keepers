// View keepers: a holo list panel of everyone on the island, day and night
// side, with a search box filtering rows by name or topic as you type.
// Each row shows her tiredness dot, name, topic, level and book count;
// clicking a row closes the panel and selects her (the comm panel opens and
// the overworld focuses her). A small footer keeps the old crossing shortcut:
// "Cross the ridge" glides the camera to the other district.
//
//   const list = createKeepersList({ root, state, bus });
//   list.open(); list.close(); list.dispose();
//
// Bus wiring:
//   listens "keepers_list:open"  -> opens the panel (the HUD emits this)
//   listens "state:loaded"     -> re-renders the OPEN list from fresh state
//   emits   "mode:set" "overworld"   before selecting, when the player is
//                                    inside an interior (main.js routes it)
//   emits   "keeper:selected" { keeperId }   row click (closes first)
//   emits   "district:travel" {}         Cross the ridge footer (closes first)
//   emits   "ui:open" / "ui:close" { panel: "keepers" }  panel lifecycle
//                                    (no consumer today; see the event table)
//
// Esc closes, unless a modal overlay or the reader is open (they own Esc
// first). Rows re-render on every open and on state:loaded, so levels and
// book counts never go stale.

import { createHoloPanel, ensureHoloStyles, injectStyle, makeEl } from "./holo/holo.js";

// session.status -> what the player reads on the tiredness dot.
export function restHint(session = null) {
  const status = session?.status;
  if (status === "needs_sleep") return { tone: "red", label: "needs to dream" };
  if (status === "unrested") return { tone: "amber", label: "getting tired" };
  return { tone: "cyan", label: "rested" };
}

const STYLE_ID = "mk-keepers-style";
const CSS = `
.mk-keepers{position:absolute;top:70px;left:16px;width:min(340px,calc(100vw - 32px));max-height:calc(100vh - 96px);display:flex;flex-direction:column;overflow:hidden;z-index:30;}
.mk-keepers .holo-panel__body{flex:1;min-height:0;display:flex;flex-direction:column;}
.mk-keepers-search{flex:none;width:100%;margin:0 0 8px;}
.mk-keepers-scroll{flex:1;min-height:0;overflow-y:auto;}
.mk-keepers-group{margin:0 0 4px;padding:6px 2px 2px;font-size:.66rem;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--holo-cyan,#3fe0ff);text-shadow:0 0 8px rgba(63,224,255,.4);}
.mk-keepers-row{display:flex;align-items:center;gap:8px;width:100%;text-align:left;cursor:pointer;font-family:inherit;}
.mk-keepers-row:hover{background:rgba(63,224,255,.14);border-color:rgba(63,224,255,.45);}
.mk-keepers-row:focus-visible{outline:2px solid var(--holo-cyan,#3fe0ff);outline-offset:1px;}
.mk-keepers-dot{width:8px;height:8px;flex:none;border-radius:50%;}
.mk-keepers-dot--cyan{background:var(--holo-cyan,#3fe0ff);box-shadow:0 0 6px rgba(63,224,255,.7);}
.mk-keepers-dot--amber{background:var(--holo-amber,#ffb658);box-shadow:0 0 6px rgba(255,182,88,.7);}
.mk-keepers-dot--red{background:var(--holo-danger,#ff7a5c);box-shadow:0 0 7px rgba(255,122,92,.85);animation:mk-keepers-pulse 1.4s ease-in-out infinite;}
@keyframes mk-keepers-pulse{0%,100%{opacity:1;}50%{opacity:.45;}}
.mk-keepers-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--holo-amber-hi,#ffd9a0);}
.mk-keepers-topic{display:block;font-size:.68rem;color:var(--holo-amber-dim,rgba(255,166,64,.7));overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.mk-keepers-lv{flex:none;font-size:.64rem;font-weight:700;letter-spacing:.1em;color:var(--holo-amber,#ffb658);border:1px solid var(--holo-amber-dim,rgba(255,166,64,.55));border-radius:3px;padding:1px 5px;white-space:nowrap;}
.mk-keepers-books{flex:none;font-size:.7rem;color:var(--holo-cyan,#3fe0ff);white-space:nowrap;}
.mk-keepers-empty{font-size:.85rem;font-style:italic;opacity:.8;padding:8px 4px;}
.mk-keepers-foot{margin-top:10px;padding-top:8px;border-top:1px solid var(--holo-line,rgba(255,166,64,.42));}
.mk-keepers-travel{display:block;width:100%;border-color:rgba(63,224,255,.45);color:var(--holo-cyan,#3fe0ff);background:rgba(63,224,255,.08);}
.mk-keepers-travel:hover{background:rgba(63,224,255,.18);box-shadow:0 0 14px rgba(63,224,255,.45);}
`;

export function createKeepersList({ root, state, bus } = {}) {
  const doc = root.ownerDocument;
  // Kit styles first, host styles second: .mk-keepers positioning must come
  // later in the cascade than the kit's .holo-panel defaults.
  ensureHoloStyles(doc);
  injectStyle(doc, STYLE_ID, CSS);

  let holo = null;
  let scroll = null;
  let onKey = null;
  let query = "";
  const offs = [];

  const el = makeEl(doc);

  function close() {
    if (!holo) return;
    if (onKey) doc.removeEventListener("keydown", onKey, true);
    onKey = null;
    holo.close();
    holo = null;
    scroll = null;
    bus?.emit("ui:close", { panel: "keepers" });
  }

  function selectKeeper(keeperId) {
    close();
    // From inside a library, step back out first; main.js routes mode:set.
    if (String(state?.mode ?? "").startsWith("interior")) {
      bus?.emit("mode:set", "overworld");
    }
    bus?.emit("keeper:selected", { keeperId });
  }

  function rowFor(keeper) {
    const row = el("button", "mk-keepers-row holo-row");
    row.type = "button";
    const name = keeper.name || keeper.id;
    row.setAttribute("aria-label", `view ${name}`);

    const hint = restHint(keeper.session);
    const dot = el("span", `mk-keepers-dot mk-keepers-dot--${hint.tone}`);
    dot.title = hint.label;

    const nameEl = el("span", "mk-keepers-name", name);
    if (keeper.topic && keeper.topic !== name) {
      nameEl.appendChild(el("span", "mk-keepers-topic", keeper.topic));
    }

    const level = Number.isFinite(keeper.level) ? keeper.level : 1;
    const lv = el("span", "mk-keepers-lv", `LV ${level}`);
    const count = keeper.book_count ?? 0;
    const books = el("span", "mk-keepers-books", `${count} ${count === 1 ? "book" : "books"}`);

    row.append(dot, nameEl, lv, books);
    row.addEventListener("click", () => selectKeeper(keeper.id));
    return row;
  }

  // (Re)fills the scroll body from state.keepers: the day village first, then
  // the night quarter across the ridge.
  function renderRows() {
    if (!scroll) return;
    scroll.textContent = "";
    const all = state?.keepers ?? [];
    if (!all.length) {
      scroll.appendChild(
        el("p", "mk-keepers-empty", "nobody lives here yet. create a keeper and she moves in."),
      );
      return;
    }
    const q = query.trim().toLowerCase();
    const keepers = q
      ? all.filter((k) => `${k.name ?? ""} ${k.topic ?? ""} ${k.id}`.toLowerCase().includes(q))
      : all;
    if (!keepers.length) {
      scroll.appendChild(
        el("p", "mk-keepers-empty", "no keeper answers to that. clear the search to see everyone."),
      );
      return;
    }
    const groups = [
      ["the village", keepers.filter((a) => a.kind !== "unconscious")],
      ["across the ridge", keepers.filter((a) => a.kind === "unconscious")],
    ];
    for (const [title, members] of groups) {
      if (!members.length) continue;
      scroll.appendChild(el("h3", "mk-keepers-group", title));
      const list = el("div", "holo-list");
      for (const keeper of members) list.appendChild(rowFor(keeper));
      scroll.appendChild(list);
    }
  }

  function open() {
    if (holo) return;

    const content = el("div");
    query = "";
    const search = el("input", "input mk-keepers-search");
    search.type = "search";
    search.placeholder = "search name or topic";
    search.setAttribute("aria-label", "search keepers");
    search.addEventListener("input", () => {
      query = search.value;
      renderRows();
    });
    content.appendChild(search);
    scroll = el("div", "mk-keepers-scroll");
    content.appendChild(scroll);
    renderRows();

    // The crossing shortcut lives here now (the HUD button became View keepers).
    const foot = el("div", "mk-keepers-foot");
    const travel = el("button", "holo-btn mk-keepers-travel", "Cross the ridge");
    travel.type = "button";
    travel.setAttribute("data-tooltip", "Glide the camera to the other side of the island");
    travel.addEventListener("click", () => {
      close();
      bus?.emit("district:travel", {});
    });
    foot.appendChild(travel);
    content.appendChild(foot);

    holo = createHoloPanel({
      title: "The keepers",
      content,
      size: null, // .mk-keepers owns the footprint
      onClose: close,
      className: "mk-keepers",
    });
    holo.el.setAttribute("aria-label", "keepers list");
    holo.el.querySelector(".holo-close")?.setAttribute("aria-label", "close keepers list");

    onKey = (e) => {
      if (e.key !== "Escape") return;
      // Modal overlays and the reader own Esc first; the talk panel never
      // takes Esc (its X is its only close), so it does not block the list.
      if (doc.querySelector(".overlay-backdrop") || doc.querySelector(".mk-reader")) {
        return;
      }
      e.stopPropagation();
      close();
    };
    doc.addEventListener("keydown", onKey, true);

    root.appendChild(holo.el);
    bus?.emit("ui:open", { panel: "keepers" });
  }

  offs.push(bus?.on?.("keepers_list:open", open) ?? (() => {}));
  offs.push(bus?.on?.("state:loaded", () => renderRows()) ?? (() => {}));

  return {
    open,
    close,
    isOpen: () => holo !== null,
    dispose() {
      close();
      for (const off of offs) off();
    },
  };
}
