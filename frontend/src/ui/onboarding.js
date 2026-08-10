// First-visit hint card: one compact, dismissible holo panel that teaches the
// five core gestures. Shows once (localStorage-backed) after the first
// "state:loaded", only in the overworld, and never again after "Got it".
// Factory per the module contract, no module-level side effects:
//
//   const onboarding = createOnboarding({ root, bus, storage });
//   onboarding.show(); onboarding.dismiss(); onboarding.dispose();
//
// `storage` is anything localStorage-shaped (getItem/setItem); pass null to
// disable persistence (the card then shows every boot, used by tests/dev).
//
// Bus wiring:
//   listens "state:loaded"   -> shows the card (first time, unless dismissed)
//   listens "mode:changed"   -> hides outside the overworld, returns with it

import { createHoloPanel, ensureHoloStyles } from "./holo/holo.js";

export const ONBOARDING_KEY = "memory-keepers:onboarded";

const TIPS = [
  ["Click a keeper", "to talk to her"],
  ["Join", "follows her home into her library"],
  ["Drag", "pans the camera"],
  ["Middle-drag", "orbits around the island"],
  ["Minimap", "click it to jump anywhere"],
];

const STYLE_ID = "mk-onboard-style";
const CSS = `
.mk-onboard{position:absolute;right:16px;bottom:16px;width:min(300px,calc(100vw - 32px));z-index:25;}
.mk-onboard-list{margin:0 0 12px;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;}
.mk-onboard-list li{display:flex;gap:8px;align-items:baseline;font-size:.85rem;color:var(--text-dim,#c99a66);}
.mk-onboard-actions{display:flex;justify-content:flex-end;}
`;

function ensureStyles(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

export function createOnboarding({ root, bus, storage = null } = {}) {
  const doc = root.ownerDocument;
  // Kit styles first, host styles second: .mk-onboard positioning must come
  // later in the cascade than the kit's .holo-panel defaults.
  ensureHoloStyles(doc);
  ensureStyles(doc);

  let holo = null;
  let dismissed = false;
  const offs = [];

  function seen() {
    try {
      return dismissed || storage?.getItem?.(ONBOARDING_KEY) === "1";
    } catch {
      return dismissed; // storage may be unavailable (private mode)
    }
  }

  function dismiss() {
    dismissed = true;
    try {
      storage?.setItem?.(ONBOARDING_KEY, "1");
    } catch {
      /* persistence is best-effort */
    }
    holo?.close();
    holo = null;
  }

  function show() {
    if (holo || seen()) return;

    const content = doc.createElement("div");

    const list = doc.createElement("ul");
    list.className = "mk-onboard-list";
    for (const [gesture, what] of TIPS) {
      const li = doc.createElement("li");
      const kbd = doc.createElement("span");
      kbd.className = "kbd";
      kbd.textContent = gesture;
      const text = doc.createElement("span");
      text.textContent = what;
      li.append(kbd, text);
      list.appendChild(li);
    }
    content.appendChild(list);

    const actions = doc.createElement("div");
    actions.className = "mk-onboard-actions";
    const gotIt = doc.createElement("button");
    gotIt.type = "button";
    gotIt.className = "holo-btn holo-btn--primary";
    gotIt.textContent = "Got it";
    gotIt.addEventListener("click", dismiss);
    actions.appendChild(gotIt);
    content.appendChild(actions);

    holo = createHoloPanel({
      title: "Welcome to keeper island",
      content,
      size: null, // .mk-onboard owns the footprint
      className: "mk-onboard",
    });
    holo.el.setAttribute("aria-label", "welcome hints");

    root.appendChild(holo.el);
  }

  function syncMode(mode) {
    if (!holo) return;
    const key = String(mode ?? "overworld").split(":")[0];
    holo.el.style.display = key === "overworld" ? "" : "none";
  }

  const on = (event, fn) => offs.push(bus?.on?.(event, fn) ?? (() => {}));
  on("state:loaded", () => show());
  on("mode:changed", (p) => syncMode(p?.mode));

  return {
    show,
    dismiss,
    isOpen: () => holo !== null,
    dispose() {
      for (const off of offs) off();
      holo?.close();
      holo = null;
    },
  };
}
