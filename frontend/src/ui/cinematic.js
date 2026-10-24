// Cinematic overlay for the "Join {keeper}" sequence: letterbox bars with a
// caption and a Skip button, a fade-to-black plate, and the global input
// lock (the `ui-cinematic` class on <body> hides the HUD, minimap, dialog,
// onboarding card and toasts via this module's scoped styles). Factory per
// the module contract, no module-level side effects:
//
//   const cinematic = createCinematic({ root, state, bus });
//
// Bus wiring:
//   listens "cinematic:started" { keeperId, name? }  letterbox in, caption
//                                ("Following {name} home"), Skip button,
//                                body class on; Esc is captured while active
//   listens "cinematic:fade"                       fade the plate to black
//   listens "cinematic:ended"  { keeperId }          letterbox out, body class
//                                off; the black plate holds a beat (covering
//                                the scene swap into the interior) then
//                                reveals
//   emits   "cinematic:skip"   { keeperId }          Skip button or the Esc key
//                                (once per cinematic; the overworld answers
//                                by jumping to the fade + enter)
//
// The scene (render/scene_overworld.js) owns the choreography and the
// timing; this module only renders its beats.

import { injectStyle } from "./holo/holo.js";

const STYLE_ID = "mk-cinematic-style";
const BAR_EXIT_MS = 600; // matches the bar transform transition below
const REVEAL_HOLD_MS = 260; // black stays up while the interior mounts
const CSS = `
.mk-cine-bar{position:fixed;left:0;right:0;height:12vh;min-height:58px;background:#08060d;z-index:60;transition:transform ${BAR_EXIT_MS}ms cubic-bezier(.22,.9,.3,1);pointer-events:none;}
.mk-cine-bar-top{top:0;transform:translateY(-102%);}
.mk-cine-bar-bottom{bottom:0;transform:translateY(102%);display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 22px;pointer-events:auto;}
.mk-cine-bar.is-in{transform:translateY(0);}
.mk-cine-caption{font-size:.85rem;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:rgba(240,233,246,.82);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.mk-cine-skip{display:inline-flex;align-items:center;gap:8px;padding:7px 14px;border-radius:4px;border:1px solid var(--holo-amber-dim,rgba(255,166,64,.55));background:rgba(255,166,64,.08);color:var(--holo-amber,#ffb658);font-family:var(--holo-font,inherit);font-size:.8rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;transition:background 130ms ease,box-shadow 130ms ease;}
.mk-cine-skip:hover{background:rgba(255,166,64,.2);box-shadow:0 0 14px rgba(255,166,64,.5);}
.mk-cine-skip:focus-visible{outline:2px solid var(--holo-amber,#ffb658);outline-offset:2px;}
.mk-cine-skip .kbd{font-size:.7rem;opacity:.85;border:1px solid var(--holo-amber-dim,rgba(255,166,64,.55));border-radius:3px;padding:1px 5px;}
/* pointer-events carries !important on both states: the plate mounts as a
   direct child of #ui, and styles.css's "#ui > *{pointer-events:auto}" opt-in
   (ID specificity) would otherwise beat this class rule and leave an
   invisible full-viewport plate swallowing every click in the app. */
.mk-cine-fade{position:fixed;inset:0;background:#000;opacity:0;pointer-events:none!important;transition:opacity 450ms ease;z-index:70;}
.mk-cine-fade.is-dark{opacity:1;pointer-events:auto!important;}
/* Input lock: while a cinematic plays, every panel gets out of the frame.
   visibility (delayed until the fade ends) also kills hit-testing, which
   pointer-events alone cannot: styles.css's "#ui > *" opt-in outranks any
   class rule by specificity. */
.ui-cinematic .mk-hud,
.ui-cinematic .mk-minimap,
.ui-cinematic .mk-dialog,
.ui-cinematic .mk-onboard,
.ui-cinematic .toast-stack{opacity:0;visibility:hidden;pointer-events:none;animation:none;transition:opacity 240ms ease,visibility 0s 240ms;}
`;

export function createCinematic({ root, state, bus } = {}) {
  const doc = root.ownerDocument;
  injectStyle(doc, STYLE_ID, CSS);

  let active = false;
  let keeperId = null;
  let skipSent = false;
  let wrap = null; // the letterbox bars while a cinematic plays
  const timers = new Set();
  const offs = [];

  // One persistent fade plate, reused across cinematics.
  const fade = doc.createElement("div");
  fade.className = "mk-cine-fade";
  fade.setAttribute("aria-hidden", "true");
  root.appendChild(fade);

  const later = (fn, ms) => {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
  };

  function nameFor(payload) {
    if (payload?.name) return payload.name;
    const keeper = state?.keepers?.find((a) => a.id === payload?.keeperId);
    return keeper?.name || keeper?.id || payload?.keeperId || "her";
  }

  function requestSkip() {
    if (!active || skipSent) return;
    skipSent = true;
    bus?.emit("cinematic:skip", { keeperId });
  }

  function onKeydown(e) {
    if (!active || e.key !== "Escape") return;
    // The cinematic owns Esc while it plays; nothing else may react.
    e.stopPropagation();
    e.preventDefault();
    requestSkip();
  }

  function start(payload) {
    if (active) return; // one cinematic at a time
    active = true;
    skipSent = false;
    keeperId = payload?.keeperId ?? null;
    doc.body.classList.add("ui-cinematic");

    wrap = doc.createElement("div");
    wrap.setAttribute("aria-label", "cinematic");
    const top = doc.createElement("div");
    top.className = "mk-cine-bar mk-cine-bar-top";
    const bottom = doc.createElement("div");
    bottom.className = "mk-cine-bar mk-cine-bar-bottom";

    const caption = doc.createElement("span");
    caption.className = "mk-cine-caption";
    caption.textContent = `Following ${nameFor(payload)} home`;

    const skip = doc.createElement("button");
    skip.type = "button";
    skip.className = "mk-cine-skip";
    skip.setAttribute("aria-label", "skip cinematic");
    skip.append("Skip");
    const kbd = doc.createElement("span");
    kbd.className = "kbd";
    kbd.textContent = "Esc";
    skip.appendChild(kbd);
    skip.addEventListener("click", requestSkip);

    bottom.append(caption, skip);
    wrap.append(top, bottom);
    root.appendChild(wrap);
    void wrap.offsetWidth; // reflow so the .is-in transition animates
    top.classList.add("is-in");
    bottom.classList.add("is-in");
    doc.addEventListener("keydown", onKeydown, true);
  }

  function fadeToBlack() {
    if (!active) return;
    fade.classList.add("is-dark");
  }

  function end() {
    if (!active) return;
    active = false;
    keeperId = null;
    doc.body.classList.remove("ui-cinematic");
    doc.removeEventListener("keydown", onKeydown, true);
    const bars = wrap;
    wrap = null;
    if (bars) {
      for (const bar of bars.querySelectorAll(".mk-cine-bar")) bar.classList.remove("is-in");
      later(() => bars.remove(), BAR_EXIT_MS);
    }
    // Hold the black a beat so the interior mounts under it, then reveal.
    later(() => fade.classList.remove("is-dark"), REVEAL_HOLD_MS);
  }

  offs.push(bus?.on?.("cinematic:started", start) ?? (() => {}));
  offs.push(bus?.on?.("cinematic:fade", fadeToBlack) ?? (() => {}));
  offs.push(bus?.on?.("cinematic:ended", end) ?? (() => {}));

  return {
    isActive: () => active,
    dispose() {
      for (const off of offs) off();
      for (const id of timers) clearTimeout(id);
      timers.clear();
      doc.removeEventListener("keydown", onKeydown, true);
      doc.body.classList.remove("ui-cinematic");
      wrap?.remove();
      wrap = null;
      fade.remove();
      active = false;
    },
  };
}
