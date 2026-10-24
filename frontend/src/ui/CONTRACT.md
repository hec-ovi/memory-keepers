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

### dialog.js: the holo comm panel
`createDialog({ root, state, bus, api, toasts, ui, sleepPollMs = SLEEP_POLL_MS } = {}) -> { open(keeperId), close(), isOpen(), dispose() }`
(`toasts` falls back to `ui?.toasts`; exported pure helpers:
`typingStep(length, maxTicks = 220)`, `restTone(session)` -> {ratio, tone
"cyan"|"amber"|"red", label "getting tired"|"needs to dream"|"", status},
`bookSpineColor(tags)` (same formula as the interior's spineColorFromTags so
chat spine bars match shelf spines), `SLEEP_POLL_MS` = 1500, and
`MONUMENT_ID` (= `config.monumentId`))
Keeper name = amber holo header (panel aria-label "talk to {name}", accent
`--mk-dialog-accent` from her palette), joined by a session cluster: an
amber `LV n` level badge (aria-label "keeper level", `keeper.level`,
default 1) and a thin rest meter (role=progressbar "rest meter") fed from
`keeper.session` {tokens_used, budget, status}; the fill goes
cyan -> amber -> red as she tires (restTone). The panel opens top-right at
75vh and resizes vertically.
LAYOUT: the panel is a flex column, top to bottom: topic chip (only when the
name does not already say the topic), the scrollback (`.mk-dialog-hist`,
aria-label "recent exchanges": your rows hug the right, hers the left, at
most 60 rows, autoscrolled to the newest), the Join button ("Join
instance"; absent for the main keeper and inside her own interior, the
player is already with her), the sleep prompt, the unconscious whisper
hint, and the COMPOSER PINNED TO THE BOTTOM. ONE input serves the whole
conversation: a pill (`form.mk-dialog-io`) holding only the text input
(aria-label "speak to {name}", placeholder "tell her a memory, or ask her
anything..."), with a round attach button (aria-label "attach a memory
file") outside it; Enter sends. Every send goes through `api.say` (the model
routes it to tell, ask or talk). Your row lands in the scrollback the moment
you send and the input empties; while the request is in flight the input is
disabled and the pill wears the kit's `holo-thinking` spinning border
(`ensureThinking`), cleared when it settles. Her reply types itself out in
amber into a fresh row (`typingStep` characters per 14 ms tick, markdown
swapped in when typing completes; an interrupted reply finishes instantly).
A reply in flight belongs to the keeper, not the panel: closing or switching
keepers keeps it pending, her reopened panel shows the sent row and the
thinking border, and the reply lands there. Every open replays her history
instantly from `api.getChat(keeperId)` turns (your rows plain text, hers
markdown).
Attach: a `.md` / `.txt` file is read as text and sent as `Keep this memory
from my file "{name}":` followed by its content; the scrollback shows
`[file] {name}`; an empty file toasts "that file is empty" and sends nothing.
A reply carrying a `book` (any `kind` but "ask") bumps the record's
`book_count` and emits `book:created`; a reply carrying `session` patches the
record and the header.
Unconscious keepers are chattable: she answers but the engine writes no
book, so her replies bump nothing and emit no `book:created`; a soft
`.mk-dialog-whisper` hint above the composer says she listens but keeps no
books of what you tell her (her books are born from dreaming).
The main keeper rides the same panel: opening `MONUMENT_ID` renders her
card ("Memory Keeper") with no Join button and no level/meter cluster; the
composer (placeholder "ask across every shelf, or ask for a new keeper...")
sends through `api.monument`, and a reply carrying `created_keeper` emits
`keeper:created`. She holds no session, so her conversation lives in the
page for the current load.
Chat grounding (a reply with `kind: "ask"`):
- grounded reply (sources non-empty): a consulted-books list
  (`.mk-dialog-consulted`, aria-label "consulted books") attaches under the
  reply text inside her row: one full-width row per source
  (`.mk-dialog-book`, spine-colored bar `.mk-dialog-spine` with
  `--mk-book-spine` from bookSpineColor(source.tags) + the full title; title
  also as tooltip/aria-label), glow staggered 220 ms apart with the first
  (lead) book strongest (`.mk-dialog-book--lead`); clicking a row emits
  `book:open` {keeperId: `source.keeper_id` or hers, slug}; the moment the
  list appears the panel emits `memory:used` {keeperId, slugs}. A ridge
  reply of any other kind that carries sources renders the same list.
- ungrounded ({grounded: false, followup: true}): instead a
  `.mk-dialog-nomem` hint ("she does not remember this"; her follow-up
  question is the typed reply) with a "Save this as a memory" shortcut that
  pre-fills the input with "Remember this: {question}" (omitted for
  unconscious keepers).
Sleep: when status is unrested/needs_sleep a prompt row shows the status
line ("she is getting tired" / "she needs to dream") and a "Send to sleep"
button: calls `api.sleep`, emits `keeper:sleep` {keeperId}, locks the
composer ("dreaming..."), polls `api.sleepJob` every sleepPollMs until done,
refreshes the keeper record (`api.getKeeper`, patched into state.keepers),
then emits `keeper:rested` {keeperId} and unlocks. The composer also stays
locked while she needs to dream. Polling continues if the panel closes
(dispose() stops it). A 409 NEEDS_SLEEP from a send is caught and rendered
as the same prompt (no error toast); a 409 LIBRARY_FULL renders the same
prompt with the warm note "her library is full. she needs to dream to make
room" (cleared once her sleep completes); any other send failure toasts.
Every failed send gives its text back to the input. Sleep failures toast
and unlock (and emit `keeper:rested` when her sleep had already begun, so
the scenes wake her).
- listens `keeper:selected` ({keeperId} or bare id) -> open
- listens `mode:changed` interior:* -> overworld: closes the panel (it
  belonged to that room)
- `keeper:deselected` (the overworld's click-on-nothing) is deliberately NOT
  consumed: the panel closes only from its header X (aria-label "close talk
  panel"), never from outside clicks or Esc, so a conversation cannot be
  lost mid-thought
- listens `state:loaded` -> the OPEN panel refreshes its session/level
  header cluster (badge, meter, sleep prompt) from the re-synced
  state.keepers record, so out-of-band session changes never leave a stale
  header or a hidden Sleep button (say replies and 409s keep it fresh
  in-panel)
- emits `keeper:join` {keeperId} (closes first), `book:created` {keeperId, book}
  (only when the reply carries a book), `keeper:created` (Keeper; a
  monument reply carrying `created_keeper`), `book:open` {keeperId, slug}
  (consulted book row)
- emits `memory:used` {keeperId, slugs} (consulted-books list lands),
  `keeper:sleep` {keeperId} (after api.sleep succeeds), `keeper:rested` {keeperId}
  (sleep job polled to done)
- emits `ui:open` {panel:"dialog", keeperId} / `ui:close` {panel:"dialog"}
- emits `toast` {message, kind?} only when no toasts instance is injected

### reader.js: book reader in a holo frame
`createReader({ root, state, bus, api, toasts, confirm, ui } = {}) -> { open(keeperId, slug), close(), isOpen(), dispose() }`
(`toasts`/`confirm` fall back to `ui?.toasts`/`ui?.confirm`; `parseBookLink(link, currentKeeperId)` exported)
Holo frame + amber header (book title); the BODY stays a light paper page
(paper tint, ink text, drop cap) for legibility. Meta chips, linked books
(cross-keeper `parseBookLink`), Destroy behind confirm.
- listens `book:open` {keeperId, slug}; `mode:changed` interior:* -> overworld
  closes the panel (Back to the island while a book is open)
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
`createHud({ root, state, bus, api, toasts, ui, reload } = {})`; `reload`
defaults to a page reload and is injectable for tests.
Buttons: View keepers (cyan, opens the roster; the crossing shortcut moved
into that list), Create keeper, Dreaming (label "Dreaming", tooltip "Send your
keepers to sleep so they can consolidate"; POST /dream, disabled while a
run is active; a 409 always toasts the warm "they are already dreaming",
never the engine's consolidation-worded message), How to play, Demo data
(zero keepers only), and world travel: Export island (keepers exist;
downloads `api.exportWorld()` as a JSON file) / Import island (zero keepers;
hidden file input aria-label "island file"; `api.importWorld` then adopts
the returned world id into localStorage "mk-world" and reloads; a non-island
file toasts "that file is not an island").
- emits `create_keeper:open`, `consolidation:started` {runId}, `howto:open`,
  `keepers_list:open`, `state:loaded` (after Demo data)
- listens `state:loaded`, `consolidation:finished`, `report:loaded`,
  `keeper:created`, `book:created`, `book:destroyed`

### keepers_list.js: the View keepers roster (holo panel, `.mk-keepers` top-left)
`createKeepersList({ root, state, bus } = {}) -> { open(), close(), isOpen(), dispose() }`;
`restHint(session)` -> {tone "cyan"|"amber"|"red", label "rested"|"getting
tired"|"needs to dream"} exported pure.
Every keeper from `state.keepers`, grouped "the village" (conscious) then
"across the ridge" (unconscious): per row a tiredness dot (restHint tone +
title), her name + topic, an `LV n` badge and her book count ("1 book" /
"n books"); rows re-render on every open and on `state:loaded`. A search box
(aria-label "search keepers", reset each open) filters rows live by name,
topic or id, case-insensitive; no match renders "no keeper answers to
that...". Row click:
close, then `mode:set` "overworld" first when `state.mode` is an interior,
then `keeper:selected` {keeperId} (the comm panel opens; the overworld focuses
her). Footer keeps the crossing shortcut: a "Cross the ridge" button that
closes and emits `district:travel` {}. Empty state: "nobody lives here
yet...". Esc closes unless a modal overlay or the reader is
open (checks `.overlay-backdrop` / `.mk-reader` first).
- listens `keepers_list:open` (the HUD emits it), `state:loaded` (re-render)
- emits `mode:set` "overworld" (from interiors), `keeper:selected` {keeperId},
  `district:travel` {}, `ui:open`/`ui:close` {panel:"keepers"}
- aria: panel "keepers list", close button "close keepers list", rows
  "view {name}"

### minimap.js: amber-trimmed frame, canvas map, real coastline
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
- `startConsolidationWatch({ api, bus, runId, intervalMs,
  maxIntervalMs = 10000, backoffFactor = 1.4, sleep } = {}) -> { stop(), done }`
  (`intervalMs` required; main.js passes `config.CONSOLIDATION_POLL_MS`)
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
+ aria-pressed; the exit button carries neither). Inactive view buttons use
the same glass fill as the readout (`rgba(20,10,4,.72)`).
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


## Invariants

- LANGUAGE: every player-facing string is warm and plain. The player never
  reads consolidate/consolidation, session, tokens, context or compaction:
  it is dreaming, resting, tired, memories, books. (One sanctioned
  exception: the HUD Dreaming tooltip "Send your keepers to sleep so they can
  consolidate", the owner's own copy.)
- Esc ordering: `.overlay-backdrop` modals (confirm/howto/create) own Esc
  first, then `.mk-reader`, then the keepers list, then main.js mode exit;
  the talk panel ignores Esc. Panels check `doc.querySelector(".overlay-backdrop")`
  (and the list also `.mk-reader`) before handling Esc.
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
- Keep aria labels stable: "talk to {name}", "close talk panel", "speak
  to {name}", "recent exchanges", "attach a memory file", "keeper level",
  "book reader", "close reader", "game hud", "minimap", "welcome hints",
  "keepers list", "close keepers list", "rest meter", "consulted books";
  button texts "Send to sleep",
  "Save this as a memory", "View keepers", "Cross the ridge".
- The reader body and paper palette stay light; everything else is dark
  amber/cyan holo.
- Join button, KEEPERS_FULL message, the unconscious keeps-no-books whisper
  hint, and the in-list Cross the ridge shortcut are product contracts; do
  not drop them in redesigns.

## How to test

`cd frontend && npm test` (vitest + jsdom + RTL + user-event + MSW). Every
panel has its suite in `frontend/tests/*.test.js`; the kit has
`holo.test.js`; wiring in `main.test.js`. Mock
`HTMLCanvasElement.prototype.getContext` to null in panel tests (jsdom has no
canvas backend).
