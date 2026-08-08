# CONTRACT: frontend/src/ui/holo (the holographic UI kit)

Isolated, reusable, game-agnostic. This module knows NOTHING about keepers,
books, the engine API, or the bus. It renders whatever content element it is
given and owns all holographic styling. The game side (frontend/src/ui/*.js)
consumes it; menus/UI iterate here without touching game logic.

Reference look: sample/refs/ui-style.png (amber/orange chrome and type, cyan
selection fill, scan lines), sample/refs/menu/1..7.png (materialize sequence),
sample/refs/voice-ring.webp (listening), sample/refs/voice-orb.webp (speaking).
Zero-network at runtime: the references are design input only, everything is
drawn procedurally (canvas + CSS).

## Files

- `holo.js`   panel factory + the one injected stylesheet (all holo classes)
- `voice.js`  voice visualizer: one central crisp speaker icon wrapped by
              concentric waveform strands (faint idle / cyan listening /
              purple-blue speaking)
- `shards.js` internal: wireframe-triangle materialize math + canvas driver
- `CONTRACT.md` this file

## Public API (exact signatures, pinned)

```js
import { createHoloPanel } from "./holo/holo.js";
createHoloPanel({ title, content, size, onClose, className })
  -> { el, close(), setTitle(t) }
```

- `title`     string; rendered as an `<h2 class="holo-panel__title">` in the
              header. Empty title + no onClose = headerless panel.
- `content`   an Element; appended into `.holo-panel__body`. The kit never
              inspects it. `content.ownerDocument` decides the document.
- `size`      `"sm" | "md" | "lg"` (max-width 340/460/640 px) or
              `{ width, height }` (number = px, string passed through) or
              `null` for no inline sizing (host class owns the footprint).
- `onClose`   optional callback. When given, the header grows a `✕` button
              (`.holo-close`, aria-label "close panel", override it if you
              need a specific label). The button calls `onClose()` and
              NOTHING else: the host decides and eventually calls `close()`.
- `className` extra class(es) appended after `holo-panel` on `el`.
- `el`        `<section class="holo-panel ...">`, NOT mounted; the host
              appends it. Mount synchronously after creating: the shard
              overlay measures `el.getBoundingClientRect()` one macrotask
              later. `el.dataset.holoState` = "materializing" | "open" |
              "closed" (test hook).
- `close()`   idempotent. Removes `el` from the DOM synchronously (hosts and
              tests never await the animation) and plays a ~350 ms scatter
              ghost canvas at the old rect. Does NOT call `onClose`.
- `setTitle(t)` swaps the header text.

```js
import { createVoiceViz } from "./holo/voice.js";
createVoiceViz({ size }) -> { el, setMode(mode), dispose() }
```

- `size`    CSS px (default 160). `el` is `<div class="holo-voice"
            data-mode="...">` containing the canvas. The backing store is
            `size * RENDER_SCALE` (2x) so the icon stays crisp.
- The picture: ONE central vector speaker icon (driver box, cone, two sound
  arcs; `speakerGeometry(size)` is the pure shape source) wrapped by
  `STRAND_COUNT` (6) concentric wavy waveform strands (`strandParams(i)`
  spreads radius/phase/alpha). Colors follow the mode hue: faint cyan idle,
  bright cyan listening, purple center fading to blue edges speaking
  (voice-ring / voice-orb references).
- `setMode("idle" | "listening" | "speaking")` cross-fades (~450 ms) all
  params (alpha, wobble, waves, speed, scale, hue, hueSpread). Unknown modes
  are ignored. `el.dataset.mode` mirrors the current mode (test/style hook).
- `getMode()` current mode (extra helper).
- `dispose()` cancels the rAF loop and removes `el`. Idempotent.

```js
import { ensureThinking, HOLO_THINKING_CLASS } from "./holo/holo.js";
ensureThinking(el, on = true) -> el
```

- The reusable "thinking" border: while `on`, `el` wears
  `.holo-thinking`, a CSS-only conic-gradient border sweep (amber ->
  cyan -> magenta, from the animated registered property
  `--holo-think-a`) that rotates around the element with a soft blurred
  glow layer (`::after`). Hosts toggle it around any in-flight work
  (the game's comm panel wraps the chat input + send row during
  tell/ask). Injects the kit stylesheet on first use; null-safe
  (returns `el` unchanged). `prefers-reduced-motion` (and engines
  without `@property`) fall back to a pulsing border, no sweep.
  `HOLO_THINKING_CLASS` = `"holo-thinking"` for hosts that prefer to
  toggle the class themselves.

Secondary exports (stable, used by hosts/tests):
`ensureHoloStyles(doc)` inject the stylesheet without creating a panel;
`prefersReducedMotion(win)`; `HOLO_STYLE_ID`; `HOLO_CLASSES`;
`HOLO_OPEN_MS` = `{ shards: 420, skin: 420, content: 560, total: 820 }`;
`HOLO_CLOSE_MS` = 350. From voice.js: `VOICE_MODES`, `MODE_PARAMS`,
`MODE_FADE_MS`, `STRAND_COUNT`, `RENDER_SCALE`, and the pure helpers
`createVoiceState`, `setVoiceMode`, `modeBlend`, `vizFrame`, `ringRadius`,
`strandParams`, `speakerGeometry`. From shards.js: `tessellate`,
`shardPlan`, `shardState`, `runShards`, `mulberry32`, `SHARD_COLORS`,
`easeOutCubic`.

## Animation phases (open ~820 ms, close ~350 ms)

1. **shards** (0..420 ms): a fixed-position `<canvas class="holo-shards">` is
   placed over the panel rect; scattered stroked triangles (teal/white/amber,
   additive "lighter" blend + shadowBlur glow) fly in and tessellate to fill
   the rect (`shards.js`). The panel shell itself is invisible
   (`.holo-panel--materializing` without `--skin`).
2. **skin** (420 ms): `.holo-panel--skin` added; the chrome snaps in with a
   brief CSS flicker; the triangle mesh dissolves (canvas opacity fade).
3. **content** (560..820 ms): `.holo-panel--ready` added; `.holo-panel__body`
   fades from opacity 0 to 1. Content is in the DOM (and in the a11y tree)
   from t=0, only its opacity animates, so tests query immediately.

Close: element removed synchronously, then a ghost canvas replays the shard
animation in reverse (scatter + fade) at the old rect and removes itself.

Fallbacks: `prefers-reduced-motion` = plain 180 ms fade, no shards. A null 2d
context or missing rAF (jsdom) skips drawing but keeps all timings/classes.
A zero-size rect (unmounted/jsdom) skips the overlay entirely.

## Injected classes (the kit owns ALL holo styling)

One `<style id="holo-kit-style">` per document, injected on first use:

| class | role |
|---|---|
| `holo-panel` | panel shell: dark translucent, amber chrome, top bar, scan lines, glow. Positioning: the kit only sets a zero-specificity default (`:where(.holo-panel){position:relative}`), so any host rule (`.mk-dialog{position:absolute;...}`) wins regardless of stylesheet injection order |
| `holo-panel__head` / `__title` / `__body` | header row / amber uppercase h2 / content wrap |
| `holo-close` | header ✕ button |
| `holo-panel--materializing/--skin/--ready/--open/--reduced` | animation state classes |
| `holo-shards` | the overlay canvases |
| `holo-btn` | amber outline button, hover glow |
| `holo-btn--primary` | filled amber, dark ink text |
| `holo-btn--danger` | red-orange outline (destroy actions) |
| `holo-tabs` / `holo-tab` / `holo-tab--active` | tab bar; active tab = solid amber like the reference (`[aria-selected="true"]` also matches) |
| `holo-list` / `holo-row` / `holo-row--selected` | rows; selected row = solid cyan fill with dark ink, like the reference nav list |
| `holo-chip` | small amber outlined tag (button.holo-chip is interactive) |
| `holo-input` | dark field, amber border, cyan caret + focus glow |
| `holo-thinking` | thinking border: spinning amber/cyan/magenta conic ring + glow around the element (reduced motion: pulse). Toggle via `ensureThinking` |
| `holo-voice` | voice visualizer host |

## Theming variables (override on :root or any ancestor)

`--holo-amber, --holo-amber-hi, --holo-amber-dim, --holo-cyan,
--holo-cyan-dim, --holo-ink, --holo-ink-cyan, --holo-text, --holo-danger,
--holo-bg, --holo-bg-2, --holo-line, --holo-glow, --holo-font, --holo-scan`

## Bus events

None. The kit is bus-free by design. Hosts emit their own events (the game's
ui/ modules emit `ui:open` / `ui:close` / `voice:*`; see ../CONTRACT.md).

## Invariants

- No imports outside this directory; no game vocabulary; no network; no
  module-level side effects (styles inject on first factory call).
- The kit never wins a positioning fight against its host: `position` on the
  panel shell is declared only inside `:where()` (specificity 0). Hosts that
  anchor a panel (dialog top-right, keepers list top-left, reader centered,
  onboarding bottom-right) do it with their own single-class rule;
  belt-and-suspenders, those hosts also call `ensureHoloStyles(doc)` BEFORE
  injecting their own stylesheet so the kit sits earlier in the cascade.
- `close()` removes the element synchronously; nothing the host needs ever
  waits on an animation.
- Content stays queryable (RTL roles) during the whole materialize sequence.
- jsdom-safe: null `getContext("2d")`, missing `matchMedia`, zero rects and
  missing rAF must never throw.
- Never put `pointer-events: none` on an ancestor of interactive content.

## How to test

`cd frontend && npx vitest run tests/holo.test.js tests/voice.test.js`
Panel lifecycle runs under `vi.useFakeTimers()` (advance past
`HOLO_OPEN_MS.total`); shard/voice math is pure; canvas is mocked
(`HTMLCanvasElement.prototype.getContext -> null` or a spy object).
