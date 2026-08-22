# CONTRACT: frontend (module map + bus event registry)

Static ES-module three.js SPA. Zero build step, zero runtime network beyond
the engine API: three.js is vendored (`vendor/three/` via the importmap in
`index.html`), all textures are procedural canvas. Cross-module talk happens
ONLY through the event bus (`src/bus.js`) plus the shared `state` object
owned by `src/main.js`; feature modules never import each other (exceptions:
ui/ modules may import the holo kit and `md.js`; render scenes import sim/
and their own render helpers; `ui/interior_views.js`, owned and mounted by
`render/scene_interior.js`, imports that scene's `LIBRARY_CAP` so the room
readout and the shelves can never disagree on the library cap).

## Module map

| module | path | contract |
|---|---|---|
| entry/boot/mode loop | `src/main.js`, `src/config.js`, `src/bus.js` | this file (below) |
| engine client | `src/api/` | `src/api/CONTRACT.md` |
| pure game logic | `src/sim/` | `src/sim/CONTRACT.md` |
| three.js scenes + helpers | `src/render/` | `src/render/CONTRACT.md` |
| DOM overlay panels | `src/ui/` | `src/ui/CONTRACT.md` |
| holographic UI kit | `src/ui/holo/` | `src/ui/holo/CONTRACT.md` |

## main.js / config.js / bus.js (owned here)

```js
// bus.js
createBus() -> { on(event, fn) -> off, off(event, fn), emit(event, payload) }

// main.js
resolveBaseUrl(loc = globalThis.location) -> string   // ?api=<url> override, else ""
resolveWorldId(loc = globalThis.location) -> string?  // ?world=<name> opens a named world, else per-browser
resolveAccessKey(loc = globalThis.location) -> string? // ?key=<island key> in a shared link; remembered
createGame({ appEl, uiEl, api, bus = createBus(), win = globalThis } = {})
  -> { state, bus, api, ui, boot(), setMode(mode), refreshState(), start(), stop(), get activeScene }
```

- `state` (owned by main.js, everyone else reads):
  `{ keepers: [], mode: null, selectedKeeperId: null, district: "day", latestReport: null }`.
  `mode` is `"overworld" | "interior:<keeperId>" | "graph"`.
- `selectedKeeperId` bookkeeping: main.js records every `keeper:selected` into it
  and clears it on any `setMode` to a NON-interior mode (interiors set it to
  the owner). A selection flow that crosses modes (the keepers list stepping out
  of an interior) emits `mode:set` first and `keeper:selected` right after, so
  the id survives the flip; the overworld scene reads it on build and applies
  the follow framing (the emit happened while the module was still loading).
  The overworld's empty-click deselect and talk-panel-close deselect null it.
- Scene wiring is data-driven: `config.sceneModules` maps a mode key to a
  module path; main.js dynamic-imports it lazily and calls the factory
  (default export or any export matching `/^create.*Scene$/i`) as
  `factory({ state, bus, api, config, container, mode })`. A missing or
  broken module falls back to an animated DOM placeholder.
- The rAF loop clamps dt to 0.1 s, calls `activeScene.update(dt)`, then
  emits `tick`.
- `config.js` is read-only tunables (movement, chatter, camera, colors,
  graph movie, `CONSOLIDATION_POLL_MS`, `sceneModules`); nothing writes to
  it at runtime.
- Auto-boot only runs in the real page (`document.getElementById("app")`);
  importing main.js under tests has no side effects.
- Boot gate: `GET /health` must answer `status: "ok"` and `GET /state` must
  load before the feature UI (hud, minimap, dialog, ...) mounts and the
  overworld opens. Until then a boot screen is the only thing on the page:
  "API ERROR" (engine unreachable or health not ok; names `.env` and the
  compose command) or the key screen (`ACCESS_REQUIRED`). Retry runs boot
  again and the screen follows the new outcome.

## Bus event registry (definitive; grep bus.emit / bus.on to re-derive)

Files below are under `src/`. "watch" = `startConsolidationWatch` in
`ui/graph_hud.js`. Payloads are the exact emitted shapes.

| event | payload | emitters | consumers |
|---|---|---|---|
| `tick` | `dt` (seconds, number) | main.js | none in src (open hook, tests) |
| `mode:set` | mode string (`"overworld"`, `"interior:<keeperId>"`) | render/scene_graph, ui/keepers_list (back to overworld before selecting from an interior) | main.js |
| `mode:changed` | `{ mode, prev }` | main.js | ui/minimap, ui/onboarding, ui/dialog (interior -> overworld closes the open talk panel) |
| `scene:ready` | `{ mode, scene }` | main.js | none in src (tests) |
| `state:loaded` | `{ state, consolidation }` | main.js (boot, refreshState), ui/hud (after Demo data) | ui/hud, ui/minimap, ui/onboarding, ui/dialog (open panel refreshes its session/level header cluster), ui/keepers_list (open roster re-renders), ui/interior_views (room readout re-reads state.keepers), render/scene_overworld + render/scene_interior (re-apply setTired from session status) |
| `report:loaded` | consolidation report | main.js | ui/hud |
| `toast` | `{ message, kind? }` or bare string | ui/create_keeper, ui/dialog, ui/reader, ui/hud (no-toasts fallback), ui/graph_hud (watch) | main.js -> toasts |
| `howto:open` | none | ui/hud | main.js |
| `create_keeper:open` | none | ui/hud | ui/create_keeper |
| `keepers_list:open` | none | ui/hud (View keepers) | ui/keepers_list (rows per group ordered needs-to-dream, getting tired, rested) |
| `keeper:created` | Keeper object | ui/create_keeper, ui/dialog (monument reply carrying `created_keeper`) | main.js (refreshState), ui/hud |
| `keeper:selected` | `{ keeperId }` (consumers also accept a bare id) | render/scene_overworld (pick: the keeper herself OR any part of her cottage; the door alone keeps its enter pick), render/scene_interior (hint book, clicking the keeper herself, the "Sit beside her" chairs view), ui/keepers_list (row click) | main.js (records `state.selectedKeeperId`, so a scene that builds after the emit still sees the selection), ui/dialog (open), render/scene_overworld (select-to-follow: camera tweens to the standard framing and follows her; any user camera input or a deselect exits) |
| `keeper:deselected` | `{ keeperId }` | render/scene_overworld (a true click on nothing pickable while someone is selected, and a monument click while a different keeper is selected; the scene then clears the ring + follow itself) | none in src (the talk panel stays open; only its X closes it) |
| `keeper:join` | `{ keeperId }` | ui/dialog | render/scene_overworld |
| `house:enter` | `{ keeperId }` | render/scene_overworld | main.js (setMode interior) |
| `interior:exit` | none | render/scene_interior (Esc from the settled main view), ui/interior_views ("Back to the island") | main.js (setMode overworld) |
| `interior:view` | `{ view: "main"\|"chairs"\|"shelf" }` | ui/interior_views (nav cluster; `main` while the main view is settled = the gentle "Back to Keeper" re-frame) | render/scene_interior |
| `book:created` | `{ keeperId, book }` | ui/dialog (tell reply that carries a book; unconscious tells write none) | main.js, ui/hud, render/scene_interior |
| `book:destroyed` | `{ keeperId, slug }` | ui/reader (Destroy) | main.js, ui/hud, render/scene_interior |
| `book:open` | `{ keeperId, slug }` | ui/dialog (consulted book link; a ridge reply's source carries the shelf it lives on), render/scene_interior (fetched book) | ui/reader (open) |
| `memory:used` | `{ keeperId, slugs }` | ui/dialog (grounded ask reply, or a ridge reply with sources: the consulted-book links appear) | render/scene_overworld (brief sparkle + tiny book sprite over her head) |
| `keeper:sleep` | `{ keeperId }` | ui/dialog (Send to sleep, after api.sleep succeeds) | render/scene_overworld (walk home over the street graph + door fade + window dim + dream effect; ambient, no input lock), render/scene_interior (she returns to her chair and dozes: eyes shut, slow breathing, Zzz) |
| `keeper:rested` | `{ keeperId }` | ui/dialog (sleep job polled to done, after the keeper record refresh) | main.js (refreshState -> state:loaded), render/scene_overworld (dream fades, she re-emerges rested with a sparkle), render/scene_interior (she wakes rested) |
| `reader:closed` | none | ui/reader (every close) | render/scene_interior |
| `district:travel` | `{}` | ui/keepers_list (Cross the ridge footer) | render/scene_overworld |
| `district:changed` | `{ district: "day"\|"night" }` | render/scene_overworld | main.js (state.district) |
| `minimap:update` | `{ keepers: [{id, x, z}], camera: {x, z, angle} }` | render/scene_overworld | ui/minimap |
| `minimap:jump` | `{ x, z }` | ui/minimap | render/scene_overworld |
| (main keeper) | clicking the well or her hologram selects `config.monumentId` through the normal `keeper:selected` flow; the dialog renders her without Join/session and routes sends through `api.monument` | render/scene_overworld | ui/dialog |
| `cinematic:started` | `{ keeperId, name }` | render/scene_overworld | ui/cinematic |
| `cinematic:fade` | `{ seconds }` | render/scene_overworld | ui/cinematic |
| `cinematic:ended` | `{ keeperId }` | render/scene_overworld | ui/cinematic |
| `cinematic:skip` | `{ keeperId }` | ui/cinematic (Skip) | render/scene_overworld |
| `consolidation:started` | `{ runId }` | ui/hud (Dreaming) | main.js (start watch) |
| `consolidation:finished` | `{ report }` | ui/graph_hud (watch) | main.js (refresh + setMode graph), ui/hud |
| `consolidation:failed` | `{ runId, ...error }` | ui/graph_hud (watch) | none in src (tests) |
| `graph:progress` | `{ t, settled }` | render/scene_graph | ui/graph_hud |
| `graph:settled` | `{ report }` | render/scene_graph | ui/graph_hud |
| `graph:wave` | `{ index, t }` | render/scene_graph | none in src (tests) |
| `graph:skip` | none | ui/graph_hud | render/scene_graph |
| `graph:back` | none | ui/graph_hud | main.js (setMode overworld), render/scene_graph (emits mode:set) |
| `ui:open` | `{ panel: "dialog", keeperId }` or `{ panel: "keepers" }` | ui/dialog, ui/keepers_list | render/scene_overworld (dialog only: cancels a pending deselect during a close-reopen switch) |
| `ui:close` | `{ panel: "dialog" \| "keepers" }` | ui/dialog, ui/keepers_list | render/scene_overworld (dialog only: deselect on the next frame, ring off + follow ends; deferred so switching keepers does not kill the fresh selection) |
| `voice:state` | `{ keeperId, mode: "idle"\|"listening"\|"speaking" }` | ui/dialog | none in src (tests) |
| `voice:mic` | `{ keeperId, on }` | ui/dialog (recording started/stopped: hold T, or the mic toggle) | none in src (tests) |
| `voice:tts` | `{ keeperId, on }` | ui/dialog (speaker toggle; ON = the dialog itself speaks each completed reply via api.tts) | none in src (tests) |

## Invariants

- One bus instance per game, created in `createGame`; handlers run
  synchronously in subscription order; `on` returns the unsubscribe.
- Only main.js calls `setMode`; everyone else emits `mode:set` (or the
  specific `house:enter` / `interior:exit` / `graph:back`).
- main.js re-syncs `state.keepers` via GET /state on `keeper:created`,
  `book:created`, `book:destroyed`, `keeper:rested`, and after
  `consolidation:finished`.
- Level/status visuals never depend on the active scene: both the overworld
  and the interior apply `mesh.setTired` from `keeper.session.status` on build
  and on every `state:loaded`; the comm panel is the same ui/dialog
  component everywhere (`keeper:selected` opens it from either scene).
- A reply in flight belongs to the keeper, not the panel: switching panels
  keeps it pending (her reopened panel shows the sent row and the thinking
  border, and the reply lands there), and every open replays her history
  from her session log (`GET /keepers/{id}/chat`). The main keeper holds no
  session, so her conversation lives in the page for the current load.
- Esc ordering: overlay modals first (capture phase), then the reader, then
  the keepers list, then interior-view fallback, then main.js exits the
  current mode. The talk panel is not in the chain: it closes only from its
  header X, and while the mic records the dialog swallows Esc entirely.
- Adding a bus event = update this table plus the emitting and consuming
  modules' CONTRACT.md in the same change.

## How to test

`cd frontend && npm test` (vitest + jsdom, 36 files / 693 tests as of this
writing). Boot/mode/bus wiring: `tests/main.test.js`, `tests/bus.test.js`.
