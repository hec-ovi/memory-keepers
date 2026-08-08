// The holographic panel kit. ISOLATED and game-agnostic: it renders whatever
// content element it is given and knows nothing about keepers, books, the bus,
// or the engine. Every memory-keepers panel (dialog, reader, modals, onboarding)
// mounts through this factory; see CONTRACT.md next to this file.
//
//   import { createHoloPanel } from "./holo/holo.js";
//   const panel = createHoloPanel({ title, content, size, onClose, className });
//   root.appendChild(panel.el);      // mounting starts the materialize sequence
//   panel.setTitle("new title");
//   panel.close();                   // synchronous DOM removal + scatter ghost
//
// Materialize (open) phases, ~820 ms total:
//   1. shards  (0..420 ms)   scattered wireframe triangles fly in and
//                            tessellate over the panel rect (canvas overlay)
//   2. skin    (420 ms)      the panel chrome snaps in with a brief flicker
//   3. content (560..820 ms) the body fades in
// close() removes the element from the DOM immediately (so hosts and tests
// stay synchronous) and plays a ~350 ms scatter ghost at the old rect.
// prefers-reduced-motion (or an environment without canvas/rAF) falls back to
// a plain fade.
//
// The kit owns ALL holo styling via one injected stylesheet (HOLO_STYLE_ID):
// amber/orange chrome and type, cyan selection accents, scan lines, glow.
// Shared classes (also usable without createHoloPanel): holo-panel, holo-btn,
// holo-btn--primary, holo-btn--danger, holo-tabs, holo-tab, holo-tab--active,
// holo-list, holo-row, holo-row--selected, holo-chip, holo-input, holo-close.
// Theming: override the --holo-* custom properties (see CSS below).

import { runShards } from "./shards.js";

export const HOLO_STYLE_ID = "holo-kit-style";

// Open/close timings (ms). Exported so hosts/tests share one clock.
export const HOLO_OPEN_MS = { shards: 420, skin: 420, content: 560, total: 820 };
export const HOLO_CLOSE_MS = 350;

export const HOLO_CLASSES = [
  "holo-panel",
  "holo-btn",
  "holo-btn--primary",
  "holo-btn--danger",
  "holo-tabs",
  "holo-tab",
  "holo-tab--active",
  "holo-list",
  "holo-row",
  "holo-row--selected",
  "holo-chip",
  "holo-input",
  "holo-close",
  "holo-thinking",
];

const SIZE_PRESETS = { sm: 340, md: 460, lg: 640 };

const CSS = `
:root{
  --holo-amber:#ffb658;
  --holo-amber-hi:#ffd9a0;
  --holo-amber-dim:rgba(255,166,64,.55);
  --holo-cyan:#3fe0ff;
  --holo-cyan-dim:rgba(63,224,255,.35);
  --holo-ink:#241102;
  --holo-ink-cyan:#03272e;
  --holo-text:#ffd3a1;
  --holo-danger:#ff7a5c;
  --holo-bg:rgba(26,13,4,.86);
  --holo-bg-2:rgba(96,48,14,.34);
  --holo-line:rgba(255,166,64,.42);
  --holo-glow:0 0 20px rgba(255,150,40,.22),0 8px 30px rgba(0,0,0,.55);
  --holo-font:"Bahnschrift","DIN Alternate","Franklin Gothic Medium","Segoe UI",system-ui,sans-serif;
  --holo-scan:repeating-linear-gradient(0deg,rgba(255,196,128,.05) 0 1px,rgba(0,0,0,0) 1px 3px);
}

/* --- panel shell ---------------------------------------------------------- */
/* Positioning default lives in :where() (zero specificity) so a host's own
   single-class rule (.mk-dialog{position:absolute;...}) always wins, no
   matter which stylesheet was injected first. The kit must never win a
   positioning fight against its host. */
:where(.holo-panel){position:relative;}
.holo-panel{
  background:var(--holo-scan),linear-gradient(180deg,rgba(120,58,14,.30),rgba(30,14,4,0) 34%),var(--holo-bg);
  border:1px solid var(--holo-line);
  border-top:2px solid var(--holo-amber);
  border-radius:6px;
  box-shadow:var(--holo-glow),inset 0 0 34px rgba(255,140,40,.06);
  color:var(--holo-text);
  font-family:var(--holo-font);
  letter-spacing:.015em;
  padding:14px 16px;
  backdrop-filter:blur(6px) saturate(1.15);
  -webkit-backdrop-filter:blur(6px) saturate(1.15);
}
.holo-panel__head{display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--holo-line);padding-bottom:8px;margin-bottom:10px;}
.holo-panel__title{margin:0;flex:1;font-family:var(--holo-font);font-size:.92rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--holo-amber);text-shadow:0 0 9px rgba(255,166,64,.5);}
.holo-panel__body{opacity:1;transition:opacity 240ms ease;}
.holo-close{background:transparent;border:1px solid transparent;border-radius:4px;color:var(--holo-amber);font:inherit;font-size:1rem;line-height:1;cursor:pointer;padding:3px 8px;transition:background 120ms ease,box-shadow 120ms ease;}
.holo-close:hover{background:rgba(255,166,64,.14);box-shadow:0 0 10px rgba(255,166,64,.45);}
.holo-close:focus-visible{outline:2px solid var(--holo-cyan);outline-offset:1px;}

/* --- materialize state machine -------------------------------------------- */
/* before the skin snaps in, the shell is invisible (shards carry the visual) */
.holo-panel--materializing:not(.holo-panel--skin){background:none;border-color:transparent;box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none;}
.holo-panel--materializing:not(.holo-panel--skin) .holo-panel__head{opacity:0;}
.holo-panel--materializing:not(.holo-panel--ready) .holo-panel__body{opacity:0;}
.holo-panel--skin{animation:holo-flicker 240ms linear;}
.holo-panel--skin .holo-panel__head{opacity:1;transition:opacity 160ms ease;}
.holo-panel--reduced{animation:holo-fade 180ms ease both;}
@keyframes holo-flicker{0%{opacity:0;}10%{opacity:.95;}22%{opacity:.4;}34%{opacity:1;}46%{opacity:.75;}60%{opacity:1;}100%{opacity:1;}}
@keyframes holo-fade{from{opacity:0;}to{opacity:1;}}

/* shard overlay canvases (open fly-in and the close ghost) */
.holo-shards{position:fixed;pointer-events:none;z-index:999;}

/* --- controls -------------------------------------------------------------- */
.holo-btn{
  appearance:none;display:inline-block;
  background:rgba(255,166,64,.08);
  border:1px solid var(--holo-amber-dim);
  border-radius:4px;
  color:var(--holo-amber);
  font-family:var(--holo-font);font-size:.8rem;font-weight:700;
  letter-spacing:.08em;text-transform:uppercase;
  padding:7px 14px;cursor:pointer;
  transition:background 130ms ease,box-shadow 130ms ease,color 130ms ease,filter 130ms ease;
}
.holo-btn:hover{background:rgba(255,166,64,.2);box-shadow:0 0 14px rgba(255,166,64,.5);}
.holo-btn:active{filter:brightness(.9);}
.holo-btn:focus-visible{outline:2px solid var(--holo-cyan);outline-offset:2px;}
.holo-btn:disabled{opacity:.4;cursor:not-allowed;box-shadow:none;background:rgba(255,166,64,.05);}
.holo-btn--primary{background:linear-gradient(180deg,var(--holo-amber-hi),var(--holo-amber));border-color:transparent;color:var(--holo-ink);text-shadow:none;}
.holo-btn--primary:hover{background:linear-gradient(180deg,#ffe4b8,#ffc270);box-shadow:0 0 16px rgba(255,182,88,.65);}
.holo-btn--danger{background:rgba(255,122,92,.08);border-color:rgba(255,122,92,.6);color:var(--holo-danger);}
.holo-btn--danger:hover{background:rgba(255,122,92,.2);box-shadow:0 0 14px rgba(255,122,92,.5);}

.holo-tabs{display:flex;gap:2px;border-bottom:1px solid var(--holo-line);margin:10px 0;}
.holo-tab{
  appearance:none;flex:1;background:rgba(255,166,64,.06);
  border:1px solid transparent;border-bottom:none;border-radius:3px 3px 0 0;
  color:var(--holo-amber-dim);font-family:var(--holo-font);font-size:.78rem;font-weight:700;
  letter-spacing:.1em;text-transform:uppercase;padding:7px 0;cursor:pointer;
  transition:background 130ms ease,color 130ms ease;
}
.holo-tab:hover{color:var(--holo-amber);background:rgba(255,166,64,.14);}
.holo-tab:focus-visible{outline:2px solid var(--holo-cyan);outline-offset:-2px;}
.holo-tab--active,.holo-tab[aria-selected="true"]{background:var(--holo-amber);color:var(--holo-ink);text-shadow:none;}

.holo-list{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none;}
.holo-row{
  display:flex;align-items:baseline;gap:8px;
  background:var(--holo-bg-2);border:1px solid rgba(255,166,64,.16);border-radius:2px;
  color:var(--holo-text);font-size:.85rem;padding:6px 10px;
}
.holo-row--selected{background:var(--holo-cyan);border-color:var(--holo-cyan);color:var(--holo-ink-cyan);font-weight:700;text-shadow:none;}

.holo-chip{
  display:inline-block;background:rgba(40,20,4,.55);
  border:1px solid var(--holo-amber-dim);border-radius:3px;
  color:var(--holo-amber);font-family:var(--holo-font);font-size:.72rem;font-weight:700;
  letter-spacing:.05em;padding:2px 8px;margin:0 4px 4px 0;
}
button.holo-chip{cursor:pointer;transition:background 120ms ease,box-shadow 120ms ease;}
button.holo-chip:hover{background:rgba(255,166,64,.18);box-shadow:0 0 10px rgba(255,166,64,.4);}
button.holo-chip:focus-visible{outline:2px solid var(--holo-cyan);outline-offset:1px;}

.holo-input,textarea.holo-input{
  width:100%;background:rgba(10,5,2,.75);
  border:1px solid var(--holo-amber-dim);border-radius:4px;
  color:var(--holo-amber-hi);caret-color:var(--holo-cyan);
  font-family:var(--holo-font);font-size:.92rem;letter-spacing:.02em;
  padding:9px 11px;
  transition:border-color 130ms ease,box-shadow 130ms ease;
}
.holo-input::placeholder{color:rgba(255,182,88,.4);}
.holo-input:focus-visible{outline:none;border-color:var(--holo-cyan);box-shadow:0 0 12px rgba(63,224,255,.35);}

/* voice visualizer host (canvas is drawn by voice.js) */
.holo-voice{display:flex;align-items:center;justify-content:center;}
.holo-voice canvas{display:block;}

/* --- thinking border -------------------------------------------------------- */
/* Wrap any element in .holo-thinking while work is in flight: a multicolor
   conic-gradient ring (amber/cyan/magenta) sweeps around it with a soft
   blurred glow. CSS-only: the sweep animates the registered custom property
   --holo-think-a (browsers without @property keep a static gradient, still
   pulsing). prefers-reduced-motion drops the sweep for a gentle pulse. */
@property --holo-think-a{syntax:"<angle>";inherits:false;initial-value:0deg;}
.holo-thinking{position:relative;isolation:isolate;border-radius:7px;}
.holo-thinking::before,.holo-thinking::after{
  content:"";position:absolute;inset:-3px;border-radius:9px;pointer-events:none;
  background:conic-gradient(from var(--holo-think-a,0deg),
    var(--holo-amber) 0deg,var(--holo-cyan) 110deg,var(--holo-magenta,#ff5ad0) 235deg,var(--holo-amber) 360deg);
  animation:holo-think-spin 2.4s linear infinite,holo-think-pulse 1.6s ease-in-out infinite;
}
.holo-thinking::before{
  padding:3px;
  -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
  -webkit-mask-composite:xor;
  mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
  mask-composite:exclude;
}
.holo-thinking::after{z-index:-1;filter:blur(10px);opacity:.55;}
@keyframes holo-think-spin{to{--holo-think-a:360deg;}}
@keyframes holo-think-pulse{0%,100%{opacity:1;}50%{opacity:.55;}}

@media (prefers-reduced-motion: reduce){
  .holo-panel--skin{animation:none;}
  .holo-panel__body{transition:none;}
  .holo-thinking::before,.holo-thinking::after{animation:holo-think-pulse 1.6s ease-in-out infinite;}
}
`;

export function ensureHoloStyles(doc = globalThis.document) {
  if (!doc || doc.getElementById(HOLO_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = HOLO_STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

export function prefersReducedMotion(win) {
  try {
    return !!win?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  } catch {
    return false;
  }
}

// Toggle the reusable "thinking" border on any element: a conic-gradient
// amber/cyan/magenta sweep with a soft glow (CSS-only; see .holo-thinking in
// the stylesheet). Hosts call ensureThinking(el, true) when a request goes in
// flight and ensureThinking(el, false) when it settles. Injects the kit
// stylesheet on first use; safe on null. Returns el.
export const HOLO_THINKING_CLASS = "holo-thinking";

export function ensureThinking(el, on = true) {
  if (!el) return el;
  ensureHoloStyles(el.ownerDocument ?? globalThis.document);
  el.classList.toggle(HOLO_THINKING_CLASS, !!on);
  return el;
}

let seedCounter = 1;

// size: "sm" | "md" | "lg" preset (max-width) or { width, height } in px.
export function createHoloPanel({ title = "", content = null, size = "md", onClose = null, className = "" } = {}) {
  const doc = content?.ownerDocument ?? globalThis.document;
  const win = doc?.defaultView ?? globalThis;
  ensureHoloStyles(doc);

  const el = doc.createElement("section");
  el.className = `holo-panel${className ? ` ${className}` : ""}`;
  el.dataset.holoState = "materializing";

  if (typeof size === "string") {
    const px = SIZE_PRESETS[size] ?? SIZE_PRESETS.md;
    el.style.maxWidth = `min(${px}px, calc(100vw - 32px))`;
  } else if (size && typeof size === "object") {
    if (size.width) el.style.width = typeof size.width === "number" ? `${size.width}px` : size.width;
    if (size.height) el.style.height = typeof size.height === "number" ? `${size.height}px` : size.height;
  }

  let titleEl = null;
  if (title || onClose) {
    const head = doc.createElement("header");
    head.className = "holo-panel__head";
    titleEl = doc.createElement("h2");
    titleEl.className = "holo-panel__title";
    titleEl.textContent = title;
    head.appendChild(titleEl);
    if (onClose) {
      const closeBtn = doc.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "holo-close";
      closeBtn.setAttribute("aria-label", "close panel");
      closeBtn.textContent = "✕";
      closeBtn.addEventListener("click", () => onClose());
      head.appendChild(closeBtn);
    }
    // Drag anywhere by the header; the panel stays where it is dropped.
    head.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button")) return;
      const rect = el.getBoundingClientRect();
      el.classList.add("holo-dragged");
      Object.assign(el.style, {
        position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`,
        right: "auto", bottom: "auto", margin: "0", transform: "none",
      });
      const grabX = e.clientX - rect.left;
      const grabY = e.clientY - rect.top;
      const move = (ev) => {
        const maxX = (win.innerWidth ?? 1e4) - 48;
        const maxY = (win.innerHeight ?? 1e4) - 40;
        el.style.left = `${Math.min(Math.max(ev.clientX - grabX, 48 - rect.width), maxX)}px`;
        el.style.top = `${Math.min(Math.max(ev.clientY - grabY, 0), maxY)}px`;
      };
      const up = () => {
        doc.removeEventListener("pointermove", move);
        doc.removeEventListener("pointerup", up);
      };
      doc.addEventListener("pointermove", move);
      doc.addEventListener("pointerup", up);
      e.preventDefault();
    });
    el.appendChild(head);
  }

  const body = doc.createElement("div");
  body.className = "holo-panel__body";
  if (content) body.appendChild(content);
  el.appendChild(body);

  const reduced = prefersReducedMotion(win);
  const seed = seedCounter++;
  const timers = new Set();
  let shardRun = null;
  let shardCanvas = null;
  let closed = false;

  const later = (fn, ms) => {
    const id = win.setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
    return id;
  };
  const clearTimers = () => {
    for (const id of timers) win.clearTimeout(id);
    timers.clear();
  };
  const dropShards = () => {
    shardRun?.cancel();
    shardRun = null;
    shardCanvas?.remove();
    shardCanvas = null;
  };

  // Places a fixed-position shard canvas over a rect. Returns null when the
  // rect is unusable (jsdom, panel not yet mounted).
  function spawnShardCanvas(rect) {
    if (!rect || rect.width < 8 || rect.height < 8) return null;
    const canvas = doc.createElement("canvas");
    canvas.className = "holo-shards";
    canvas.width = Math.round(rect.width);
    canvas.height = Math.round(rect.height);
    canvas.style.left = `${rect.left}px`;
    canvas.style.top = `${rect.top}px`;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    doc.body.appendChild(canvas);
    return canvas;
  }

  function finishOpen() {
    dropShards();
    el.classList.remove("holo-panel--materializing");
    el.classList.add("holo-panel--open");
    if (!closed) el.dataset.holoState = "open";
  }

  if (reduced) {
    el.classList.add("holo-panel--reduced", "holo-panel--skin", "holo-panel--ready");
    later(finishOpen, 20);
  } else {
    el.classList.add("holo-panel--materializing");
    later(() => {
      // Runs after the host has appended el (hosts mount synchronously).
      shardCanvas = spawnShardCanvas(el.getBoundingClientRect?.());
      if (shardCanvas) {
        shardRun = runShards(shardCanvas, { mode: "in", duration: HOLO_OPEN_MS.shards, seed, win });
      }
    }, 0);
    later(() => {
      el.classList.add("holo-panel--skin");
      // the seated triangle mesh dissolves into the panel skin
      if (shardCanvas) {
        shardCanvas.style.transition = "opacity 320ms ease";
        shardCanvas.style.opacity = "0";
      }
    }, HOLO_OPEN_MS.skin);
    later(() => el.classList.add("holo-panel--ready"), HOLO_OPEN_MS.content);
    later(finishOpen, HOLO_OPEN_MS.total);
  }

  function close() {
    if (closed) return;
    closed = true;
    clearTimers();
    dropShards();
    const rect = el.getBoundingClientRect?.();
    el.remove(); // synchronous: hosts and tests never wait on the animation
    el.dataset.holoState = "closed";
    if (!reduced) {
      const ghost = spawnShardCanvas(rect);
      if (ghost) {
        runShards(ghost, {
          mode: "out",
          duration: HOLO_CLOSE_MS,
          seed,
          win,
          onDone: () => ghost.remove(),
        });
      }
    }
  }

  return {
    el,
    close,
    setTitle(t) {
      if (titleEl) titleEl.textContent = t ?? "";
    },
  };
}
