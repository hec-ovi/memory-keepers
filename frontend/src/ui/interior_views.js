// Interior navigation cluster + room readout. Pure UI: neither touches the
// 3D scene.
//
// The cluster (bottom-right, vertical) has a clear top-to-bottom order:
//   1. "Back to Keeper"        (view "main": from chairs/shelf it returns to the
//                             room view; when the room view is already up the
//                             scene gently re-frames on her)
//   2. "Sit beside her"      (view "chairs")
//   3. "Bookshelf"           (view "shelf")
//   4. "Back to the island"  (leaves the house: emits "interior:exit"; this
//                             replaced the old bottom-left back button)
// View buttons emit "interior:view" { view } (and call onSelect); the scene
// answers by tweening the camera and calls setActive(view) back so the
// cluster mirrors the view that is actually up. The exit button emits
// "interior:exit" (and calls onExit); main.js switches back to the overworld.
//
//   const views = createInteriorViews({ root, bus, onSelect, onExit, active });
//   views.setActive("shelf"); views.dispose();
//
// The readout (bottom-left, unobtrusive) shows who lives here and how she is
// doing: her name, LV n, how many books are shelved against the library
// capacity ("7 of 24 shelved") and her rest in warm words (rested / getting
// tired / needs to dream). It reads state.keepers and refreshes itself on
// "state:loaded", exactly like the tired look does.
//
//   const readout = createInteriorReadout({ root, bus, state, keeperId });
//   readout.dispose();
//
// Styling comes from the shared holo kit (ensureHoloStyles injects the
// holo-btn / holo-btn--primary classes); only the local placement is here.

import { ensureHoloStyles } from "./holo/holo.js";
import { LIBRARY_CAP } from "../render/scene_interior.js";

export const VIEW_BUTTONS = Object.freeze([
  Object.freeze({ view: "main", label: "Back to Keeper" }),
  Object.freeze({ view: "chairs", label: "Sit beside her" }),
  Object.freeze({ view: "shelf", label: "Bookshelf" }),
]);

export const EXIT_LABEL = "Back to the island";

// Rest status in warm words; the player never reads engine vocabulary.
export function restWording(status) {
  if (status === "needs_sleep") return "needs to dream";
  if (status === "unrested") return "getting tired";
  return "rested";
}

// Everything the room readout shows, derived from an Keeper record.
export function readoutModel(keeper = {}, capacity = LIBRARY_CAP) {
  return {
    name: String(keeper.name ?? keeper.id ?? "her"),
    level: Number.isFinite(keeper.level) ? keeper.level : 1,
    shelved: Math.max(0, Number.isFinite(keeper.book_count) ? keeper.book_count : 0),
    capacity,
    rest: restWording(keeper.session?.status),
  };
}

const STYLE_ID = "mk-interior-views-style";
const CSS = `
.mk-interior-views{position:absolute;right:16px;bottom:18px;z-index:20;display:flex;flex-direction:row;justify-content:flex-end;align-items:center;gap:8px;}
.mk-interior-views .mk-view-btn{pointer-events:auto;}
.mk-interior-views .mk-view-exit{margin-left:6px;}
.mk-interior-readout{position:absolute;left:16px;bottom:18px;z-index:20;display:flex;flex-direction:column;gap:2px;padding:8px 12px;pointer-events:none;background:rgba(20,10,4,.72);border:1px solid var(--holo-amber-dim,rgba(255,166,64,.45));border-radius:6px;box-shadow:0 0 14px rgba(255,150,40,.14);font-family:var(--holo-font,inherit);}
.mk-interior-readout strong{font-size:.82rem;color:var(--holo-amber-hi,#ffd9a0);letter-spacing:.04em;}
.mk-interior-readout span{font-size:.7rem;color:var(--holo-text,#ffe9d2);opacity:.9;}
`;

function injectStyles(doc) {
  ensureHoloStyles(doc);
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    doc.head.appendChild(style);
  }
}

export function createInteriorViews({
  root,
  bus = null,
  onSelect = null,
  onExit = null,
  active = "main",
} = {}) {
  const doc = root.ownerDocument;
  injectStyles(doc);

  const el = doc.createElement("div");
  el.className = "mk-interior-views";
  el.setAttribute("role", "group");
  el.setAttribute("aria-label", "Room navigation");

  const buttons = new Map(); // view -> button
  for (const { view, label } of VIEW_BUTTONS) {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "holo-btn mk-view-btn";
    btn.dataset.view = view;
    btn.textContent = label;
    btn.addEventListener("click", () => {
      onSelect?.(view);
      bus?.emit?.("interior:view", { view });
    });
    buttons.set(view, btn);
    el.appendChild(btn);
  }

  const exitBtn = doc.createElement("button");
  exitBtn.type = "button";
  exitBtn.className = "holo-btn mk-view-btn mk-view-exit";
  exitBtn.textContent = EXIT_LABEL;
  exitBtn.addEventListener("click", () => {
    onExit?.();
    bus?.emit?.("interior:exit");
  });
  el.appendChild(exitBtn);

  function setActive(view) {
    for (const [v, btn] of buttons) {
      const isActive = v === view;
      btn.classList.toggle("holo-btn--primary", isActive);
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
    }
  }
  setActive(active);

  root.appendChild(el);
  return {
    el,
    setActive,
    dispose() {
      el.remove();
    },
  };
}

export function createInteriorReadout({
  root,
  bus = null,
  state = {},
  keeperId = null,
  capacity = LIBRARY_CAP,
} = {}) {
  const doc = root.ownerDocument;
  injectStyles(doc);

  const el = doc.createElement("div");
  el.className = "mk-interior-readout";
  el.setAttribute("role", "status");
  el.setAttribute("aria-label", "about her");

  const nameEl = doc.createElement("strong");
  const levelEl = doc.createElement("span");
  const booksEl = doc.createElement("span");
  const restEl = doc.createElement("span");
  el.append(nameEl, levelEl, booksEl, restEl);

  function refresh() {
    const keeper = state.keepers?.find((a) => a.id === keeperId) ?? { id: keeperId };
    const m = readoutModel(keeper, capacity);
    nameEl.textContent = m.name;
    levelEl.textContent = `LV ${m.level}`;
    booksEl.textContent = `${m.shelved} of ${m.capacity} shelved`;
    restEl.textContent = m.rest;
  }
  refresh();

  const off = bus?.on?.("state:loaded", refresh) ?? (() => {});
  root.appendChild(el);
  return {
    el,
    dispose() {
      off();
      el.remove();
    },
  };
}
