# CONTRACT: frontend/src/ui (DOM overlay panels)

Every panel is a factory (`createX({...}) -> { ..., dispose() }`), no
module-level side effects, Testing-Library-testable. All panels render in the
holographic language: they mount through `ui/holo/holo.js` (createHoloPanel)
or reuse its injected classes; the holo kit itself is game-agnostic and has
its own CONTRACT.md in `ui/holo/`. Cross-module talk goes over the bus
(`src/bus.js`) plus the shared `state` owned by main.js; ui modules never
import each other (except the holo kit and `md.js`).

Shared legacy classes (`.panel .btn .input .chip .toast .overlay-backdrop
.dialog .kbd`, styles.css) are re-themed to the same holo look for surfaces
that do not use the kit directly (HUD bar, minimap frame, toasts, connect
screen). Legacy CSS variable NAMES are kept with holo VALUES (`--pink` is now
amber #ffb658, `--lavender` is cyan #3fe0ff).

## Modules, factories, bus events

### dialog.js: the holo comm panel (NOT a chat window)
`createDialog({ root, state, bus, api, toasts, ui, sleepPollMs = SLEEP_POLL_MS } = {}) -> { open(keeperId), close(), isOpen(), dispose() }`
(`toasts` falls back to `ui?.toasts`; exported pure helpers:
`typingStep(length, maxTicks = 220)`, `restTone(session)` -> {ratio, tone
"cyan"|"amber"|"red", label "getting tired"|"needs to dream"|"", status},
`bookSpineColor(tags)` (same formula as the interior's spineColorFromTags so
chat spine bars match shelf spines), `SLEEP_POLL_MS` = 1500, and the book
list paging constants `BOOKS_VISIBLE` = 4 / `BOOK_ROW_PX` = 26)
Keeper name = amber holo header, joined by a session cluster: an amber `LV n`
level badge (`keeper.level`, default 1) and a thin rest meter
(role=progressbar "rest meter") fed from `keeper.session` {tokens_used,
budget, status}; the fill goes cyan -> amber -> red as she tires (restTone).
LAYOUT: the panel is a flex column, top to bottom: topic chip + Join button,
the scrollback (bottom-anchored so it grows UPWARD), the voice visualizer
hero (`createVoiceViz`, speaker toggle beside it), the reply area, the sleep
prompt, the Tell/Ask tabs, and the COMPOSER PINNED TO THE BOTTOM. One
composer (`form.mk-dialog-io`) serves both tabs: a pill-shaped input whose
right end merges into the circular mic button (one continuous shape; the mic
is the form's last child), with a compact round send button inside the pill
(aria-label "Tell" or "Ask" follows the active tab); Enter sends too. While
`api.tell`/`api.ask` is in flight the viz goes LISTENING (cyan strands) with
a "listening..." status AND the whole pill wears the kit's `holo-thinking`
spinning border (`ensureThinking`), cleared on settle (success or error);
when the reply arrives the viz goes SPEAKING (purple/blue strands) while the
reply text types itself out in amber (markdown swapped in when typing
completes); the previous reply and the sent text collapse into the
scrollback. Engine calls stay the real `api.tell` / `api.ask`.
Unconscious keepers are chattable: Tell works (conversational; the engine
writes no book, so a reply without `book` bumps nothing and emits no
`book:created`), and a soft `.mk-dialog-whisper` hint on the Tell tab says
she listens but keeps no books of what you tell her (her books are born
from dreaming).
Chat grounding (ask replies):
- grounded reply (grounded not false, sources non-empty): a consulted-books
  list (`.mk-dialog-consulted`, aria-label "consulted books") renders on the
  LEFT of the reply inside `.mk-dialog-reply`: one row per source
  (`.mk-dialog-book`, spine-colored bar `.mk-dialog-spine` with
  `--mk-book-spine` from bookSpineColor(source.tags) + the visible title;
  title also as tooltip/aria-label), glow staggered 220 ms apart with the
  first (lead) book strongest (`.mk-dialog-book--lead`); when more than
  BOOKS_VISIBLE sources land, up/down arrow buttons (aria-labels "scroll
  books up"/"scroll books down", keyboard accessible) page ONE item per
  press (scrollTop steps by BOOK_ROW_PX, `data-offset` mirrors the window,
  arrows disable at the ends); clicking a row emits `book:open`; the moment
  the list appears the panel emits `memory:used` {keeperId, slugs}.
- ungrounded ({grounded: false, followup: true}): instead a
  `.mk-dialog-nomem` hint ("she does not remember this" + the follow-up
  question) with a "Save this as a memory" shortcut that jumps to the Tell
  tab pre-filled with the asked question (omitted for unconscious keepers).
Sleep: when status is unrested/needs_sleep a prompt row shows the status
line ("she is getting tired" / "she needs to dream") and a "Send to sleep"
button: calls `api.sleep`, emits `keeper:sleep` {keeperId}, disables the chat
inputs ("dreaming..."), polls `api.sleepJob` every sleepPollMs until done,
refreshes the keeper record (`api.getKeeper`, patched into state.keepers), then
emits `keeper:rested` {keeperId} and unlocks. Polling continues if the panel
closes (dispose() stops it). A 409 NEEDS_SLEEP from tell/ask is caught and
rendered as the same prompt (no error toast); a 409 LIBRARY_FULL from tell
renders the same prompt with the warm note "her library is full. she needs
to dream to make room" (cleared once her sleep completes); sleep failures
toast and unlock.
- listens `keeper:selected` ({keeperId} or bare id) -> open
- listens `keeper:deselected` (the overworld's click-on-nothing while she was
  selected) -> the open panel closes (no-op when already closed)
- listens `state:loaded` -> the OPEN panel refreshes its session/level
  header cluster (badge, meter, sleep prompt) from the re-synced
  state.keepers record, so out-of-band session changes never leave a stale
  header or a hidden Sleep button (tell/ask responses and 409s keep it
  fresh in-panel)
- emits `keeper:join` {keeperId} (closes first), `book:created` {keeperId, book}
  (only when the tell reply carries a book), `book:open` {keeperId, slug}
  (consulted book row)
- emits `memory:used` {keeperId, slugs} (grounded ask reply lands),
  `keeper:sleep` {keeperId} (after api.sleep succeeds), `keeper:rested` {keeperId}
  (sleep job polled to done)
Voice, push-to-talk: holding the physical T key (only while the panel is
open; ignored on typing surfaces: inputs, textareas, contenteditable; key
repeat and ctrl/alt/meta combos ignored) or holding the mic button
(pointerdown starts, pointerup/pointerleave stops) records through
`getUserMedia` + `MediaRecorder` (opus: `audio/webm;codecs=opus` when
supported, else `audio/ogg;codecs=opus`; ONE stream per dialog session,
tracks released on close). Release sends the clip to `api.stt`; the
transcription lands in the composer and goes through the exact same send
path as a typed message. While recording the viz is LISTENING; while
transcribing the pill wears `holo-thinking`. An empty transcription toasts
gently ("no words came through; try again") and sends nothing.
VOICE_UNAVAILABLE or a denied microphone toasts once ("voice is not
available here; typing still works") and disables the mic button for that
dialog session.
Voice, spoken replies: the visualizer doubles as the speaker toggle; when ON
each completed reply is fetched from `api.tts(text, kind)` (kind: monument
panel -> "monument", unconscious keeper -> "dark", else "light") and played
from a Blob object URL, revoked after playback (toggling off stops
playback). A TTS failure falls back to the written reply (one gentle toast
per session at most) and never breaks the dialog.
- emits `voice:mic` {keeperId, on} (push-to-talk recording started/stopped),
  `voice:tts` {keeperId, on} (speaker toggle for spoken replies),
  `voice:state` {keeperId, mode: "idle"|"listening"|"speaking"} on every viz
  mode change
- emits `ui:open` {panel:"dialog", keeperId} / `ui:close` {panel:"dialog"}

### reader.js: book reader in a holo frame
`createReader({ root, state, bus, api, toasts, confirm, ui } = {}) -> { open(keeperId, slug), close(), isOpen(), dispose() }`
(`toasts`/`confirm` fall back to `ui?.toasts`/`ui?.confirm`; `parseBookLink(link, currentKeeperId)` exported)
Holo frame + amber header (book title); the BODY stays a light paper page
(paper tint, ink text, drop cap) for legibility. Meta chips, linked books
(cross-keeper `parseBookLink`), Destroy behind confirm.
- listens `book:open` {keeperId, slug}
- emits `book:destroyed` {keeperId, slug}, `reader:closed` (every close)

### create_keeper.js: modal form (holo panel in `.overlay-backdrop`)
`createCreateKeeper({ root, state, bus, api, toasts, ui } = {})`; `slugify(topic)` exported.
- listens `create_keeper:open`; emits `keeper:created` (Keeper)
- inline 409 errors: KEEPER_EXISTS and KEEPERS_FULL ("the village has no free
  plots yet...")

### confirm.js / howto.js: modal holo panels in `.overlay-backdrop`
`createConfirm({root}).ask({title, message, confirmLabel, cancelLabel, danger})
-> Promise<boolean>` (Enter true, Esc/backdrop false, one at a time).
`createHowto({root})` open/close/toggle. No bus. The howto notes speak the
warm island language only (dreaming, resting, books; never consolidation or
session words) and describe the current HUD: View keepers, Dreaming, and the
chattable night keepers who keep no books of what you tell them.

### onboarding.js: first-visit holo card
`createOnboarding({ root, bus, storage = null } = {})`; localStorage key
`ONBOARDING_KEY = "memory-keepers:onboarded"` (exported); listens `state:loaded`
(show once), `mode:changed` (hide outside overworld).

### hud.js: top bar (holo-styled `.panel`, cyan View keepers button)
`createHud({ root, state, bus, api, toasts, ui } = {})`.
Buttons: View keepers (cyan, opens the roster; the crossing shortcut moved
into that list), Create keeper, Dreaming (label "Dreaming", tooltip "Send your
keepers to sleep so they can consolidate"; POST /dream, disabled while a
run is active; a 409 always toasts the warm "they are already dreaming",
never the engine's consolidation-worded message), How to play, Demo data
(zero keepers only), mute.
- emits `create_keeper:open`, `consolidation:started` {runId}, `howto:open`,
  `keepers_list:open`, `audio:mute` {muted}, `state:loaded` (after Demo data)
- listens `state:loaded`, `consolidation:finished`, `report:loaded`,
  `keeper:created`, `book:created`, `book:destroyed`

### keepers_list.js: the View keepers roster (holo panel, `.mk-keepers` top-left)
`createKeepersList({ root, state, bus } = {}) -> { open(), close(), isOpen(), dispose() }`;
`restHint(session)` -> {tone "cyan"|"amber"|"red", label "rested"|"getting
tired"|"needs to dream"} exported pure.
Every keeper from `state.keepers`, grouped "the village" (conscious) then
"across the ridge" (unconscious): per row a tiredness dot (restHint tone +
title), her name + topic, an `LV n` badge and her book count ("1 book" /
"n books"); rows re-render on every open and on `state:loaded`. Row click:
close, then `mode:set` "overworld" first when `state.mode` is an interior,
then `keeper:selected` {keeperId} (the comm panel opens; the overworld focuses
her). Footer keeps the crossing shortcut: a "Cross the ridge" button that
closes and emits `district:travel` {}. Empty state: "nobody lives here
yet...". Esc closes unless a modal overlay, the reader or the talk panel is
open (checks `.overlay-backdrop` / `.mk-reader` / `.mk-dialog` first).
- listens `keepers_list:open` (the HUD emits it), `state:loaded` (re-render)
- emits `mode:set` "overworld" (from interiors), `keeper:selected` {keeperId},
  `district:travel` {}, `ui:open`/`ui:close` {panel:"keepers"}
- aria: panel "keepers list", close button "close keepers list", rows
  "view {name}"

### minimap.js: amber-chromed frame, canvas map, real coastline
`createMinimap({ root, state, bus, config } = {})`; pure helpers
`computeMapBounds`, `makeProjector`, `wedgePoints`, `pingState`, `PING_MS`,
plus the coastline mask: `sampleLandMask(world, bounds, cols, rows)` (samples
`world.heightAt` over a COAST_GRID 96x80 grid once per layout: above-water
`land` Uint8Array + per-cell `night` blend from `world.nightMaskAt` +
`heights`), `maskToRgba(mask, {landRgb, nightRgb, sandRgb})` (water
transparent, land mixed day-green -> night-purple by the night blend, sandy
fringe near the waterline), `COAST_MARGIN` = 6 (map bounds margin so bays and
headlands fit the frame), `COAST_GRID`. The mask is rasterized into a small
offscreen canvas and drawn scaled-up with smoothing: the real irregular
silhouette instead of the old two discs. Hosts without ImageData (mocked
canvas in jsdom) fall back to the two district discs. Streets, plot rings,
house/keeper dots, wedge and ping unchanged.
- listens `minimap:update`, `state:loaded` (redraw), `mode:changed` (hide
  outside overworld); emits `minimap:jump` {x, z}

### graph_hud.js: the dreaming overlay, holo-recolored (keepergx- classes)
`createGraphHud({ root, bus, report = null } = {})`; narrative header reads
"The Dreaming".
- emits `graph:skip`, `graph:back`; listens `graph:progress`, `graph:settled`
- `startConsolidationWatch({ api, bus, runId, intervalMs = 2500,
  maxIntervalMs = 10000, backoffFactor = 1.4, sleep } = {}) -> { stop(), done }`
  poll helper: emits `consolidation:finished` {report} /
  `consolidation:failed` {runId, ...} + `toast` on failure (warm copy: "The
  dreaming came apart; try again." / "Could not check on the dreaming: ...")

### interior_views.js: interior nav cluster + room readout (holo-btn based)
`createInteriorViews({ root, bus, onSelect, onExit, active })`; a VERTICAL
bottom-right cluster (role group "Room navigation"), top to bottom: Back to
Keeper (view `main`) / Sit beside her (`chairs`) / Bookshelf (`shelf`) / Back
to the island. View buttons emit `interior:view` {view}; the exit button
emits `interior:exit` (it replaced the interior scene's old back button).
`setActive(view)` mirrors the scene (active view button = holo-btn--primary
+ aria-pressed; the exit button carries neither).
`createInteriorReadout({ root, bus, state, keeperId, capacity = LIBRARY_CAP })`;
a small role="status" card bottom-left: her name, `LV n`, `<n> of <cap>
shelved`, rest in warm words (`restWording`: rested / getting tired / needs
to dream; `readoutModel` derives the whole view, both exported pure).
Listens `state:loaded` and re-reads `state.keepers`. `LIBRARY_CAP` (24) is
imported from `render/scene_interior.js`: the ONE sanctioned ui -> render
import (this module is owned and mounted by that scene, see
render/CONTRACT.md; the general "ui/ cannot import render/" rule still holds
everywhere else). Uses `ensureHoloStyles` from the kit, no createHoloPanel.

### toasts.js: holo chip toasts (`.toast`, `.toast-error`, `.toast-success`)
`createToasts({ root, duration = 3500 } = {}) -> { show(message, {kind, duration}), error(m), success(m), dispose() }`

### cinematic.js: join-cinematic letterbox (not a panel; unchanged)
`createCinematic({ root, state, bus } = {}) -> { isActive(), dispose() }`
- listens `cinematic:started` {keeperId, name?}, `cinematic:fade`,
  `cinematic:ended`; emits `cinematic:skip` {keeperId} (Skip button / Esc)

### md.js: minimal safe markdown -> DOM
`mdToDom(md, doc = globalThis.document) -> DocumentFragment`;
`renderMd(container, md)`

## Audio hooks (render/audio.js listens)

`ui:open` / `howto:open` / `create_keeper:open` -> materialize chirp;
`ui:close` / `reader:closed` -> collapse chirp; `voice:state` -> listening
ping / speaking double tone (idle silent); `voice:mic` -> rising/falling
click. Plus the older `keeper:selected` / `book:created` / `book:open` /
`graph:wave` / `district:changed` / `audio:mute` map.

## Invariants

- LANGUAGE: every player-facing string is warm and plain. The player never
  reads consolidate/consolidation, session, tokens, context or compaction:
  it is dreaming, resting, tired, memories, books. (One sanctioned
  exception: the HUD Dreaming tooltip "Send your keepers to sleep so they can
  consolidate", the owner's own copy.)
- Esc ordering: `.overlay-backdrop` modals (confirm/howto/create) own Esc
  first, then `.mk-reader`, then the dialog, then the keepers list, then
  main.js mode exit. Panels check `doc.querySelector(".overlay-backdrop")`
  (and the list also `.mk-reader`/`.mk-dialog`) before handling Esc.
- Panel close is synchronous DOM removal (the holo kit plays its scatter
  ghost independently); `isOpen()` flips immediately.
- Hosts that anchor a holo panel with their own class (`.mk-dialog` top-right,
  `.mk-keepers` top-left, `.mk-reader` centered, `.mk-onboard` bottom-right)
  call `ensureHoloStyles(doc)` BEFORE injecting their host stylesheet, so
  host positioning always sits later in the cascade than the kit shell (the
  kit also declares its position default at zero specificity; see
  `ui/holo/CONTRACT.md`).
- All engine mutations funnel through `api.*`; panels patch `state.keepers`
  optimistically (book_count) and main.js re-syncs via GET /state on
  `keeper:created` / `book:created` / `book:destroyed`.
- Keep aria labels stable: "talk to {name}", "close talk panel", "book
  reader", "close reader", "game hud", "minimap", "welcome hints",
  "keepers list", "close keepers list", "hold to talk",
  "toggle voice replies", "toggle sound", "rest meter", "consulted books",
  "scroll books up", "scroll books down"; button texts "Send to sleep",
  "Save this as a memory", "View keepers", "Cross the ridge".
- The reader body and paper palette stay light; everything else is dark
  amber/cyan holo.
- Join button, KEEPERS_FULL message, the unconscious keeps-no-books whisper
  hint, and the in-list Cross the ridge shortcut are product contracts; do
  not drop them in redesigns.

## How to test

`cd frontend && npm test` (vitest + jsdom + RTL + user-event + MSW). Every
panel has its suite in `frontend/tests/*.test.js`; the kit has
`holo.test.js` / `voice.test.js`; wiring in `main.test.js`. Mock
`HTMLCanvasElement.prototype.getContext` to null in panel tests (jsdom has no
canvas backend).
