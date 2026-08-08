# render/ module contracts

Per the isolation policy, every isolated module in this directory keeps its
section here up to date on every modification. Sections are independent so
parallel work merges cleanly: add or edit ONLY your module's section.

## scene_interior.js (owns ui/interior_views.js)

### Purpose

The keeper's library home. The 3D books are the interface (no list panel):
shelves on two walls, one spine mesh per book with the title drawn on a canvas
texture. The two bookcases hold exactly `LIBRARY_CAP` (24) slots in total: ONE
full library is the memory cap per keeper (the backend pins the same number in
`engine/limits.py`); each spine is sized by the book's corpus tier
(`BookSummary.tier`, small | medium | big | large by body length, see
docs/api.md): `bookTier(book)` picks the tier (one_liner-length fallback for
payloads without the field), `tierSizing(tier)` maps it to spine thickness and
height inside the slot. A "digest"
book (source `sleep`, written by the dreaming merge) is just a normal book
with its own spine: nothing here looks at `book.source`. Clicking a book sends
the sitting keeper to fetch it and opens the reader. Clicking the KEEPER herself
emits `keeper:selected`: the same ui/dialog comm panel as the overworld opens.
Three clickable camera views: `main` (the wide framing), `chairs` (the two
armchairs are a cozy pair angled toward one another; the camera sits IN the
guest chair looking AT her, she faces the camera, gentle sitting sway),
`shelf` (a dolly close to a bookcase wall, framed so spine titles are readable
on screen; spine canvases re-render at higher resolution for the close-up).
In the settled shelf view the close-up can be DRAGGED on x/y (a 2D pan for
small screens, logic in `shelf_pan.js`): position and lookAt truck together,
clamped to the case's overflow past the viewport; no zoom, no depth, no
rotation. A drag past 4 px swallows the click it ends on, so book picks stay
clicks; when the whole case fits, the drag never arms. The offset resets on
every view change.
The chair pair geometry is exported (`CHAIR_POS`, `CHAIR_ANGLE`,
`SECOND_CHAIR`, `CHAIRS_POSE`) and unit-tested; her fetch pathing (hop-off
spot in front of her chair, walks to either case) stays clear of the guest
chair.

Round 5: on `memory:used` she physically fetches the FIRST used book without
opening the reader (silent fetch: pull out, hold ~1.4 s with a soft emissive
glow, reshelve, return to her chair); a running fetch/reader flow queues it
(bounded + deduped, `enqueueRemember`/`nextRemember`). On `keeper:sleep` she
returns to her chair and dozes (eyes shut, slow breathing, Zzz;
`keeper_mesh.setSleeping`) until `keeper:rested` wakes her rested. Her tired look
(`keeper_mesh.setTired` from `keeper.session.status`) is applied when the mesh
loads and re-applied on every `state:loaded`, exactly like the overworld.

### Public API

```js
import { createInteriorScene } from "./render/scene_interior.js";

const scene = createInteriorScene({ state, bus, api, config, container, mode, keeperId, renderer, camera });
// -> {
//   scene, group, camera, keeperId,
//   update(dt), dispose(),
//   pick(slug),                       // start the fetch for a book
//   keeperState(),                      // sit/fetch machine state string
//   dozeState(),                      // "awake" | "settling" | "dozing"
//   rememberPending(),                // queued memory:used fetch count
//   view(),                           // settled view: "main"|"chairs"|"shelf"
//   viewTarget(),                     // tween target or null
//   setView(view, { force, wall }),   // request a view; false if rejected
//   reframing(),                      // "Back to Keeper" look-tween running?
// }
```

`keeperId` falls out of `mode` (`"interior:<keeperId>"`) or
`state.selectedKeeperId`. Without `renderer`/`camera` the scene owns both
(canvas appended to `container`, removed on dispose); with `container: null`
it runs fully headless (that is how the tests drive it).

Pure helpers (exported, no three.js state): `hashString`,
`spineColorFromTags`, `BOOK_TIERS`, `bookTier`, `tierSizing`, `shelfSlot`,
`shelfCapacity`, `LIBRARY_CAP` (= 24 = `shelfCapacity()`),
`SHELF_LAYOUT`, `CHAIR_POS`, `CHAIR_ANGLE`, `SECOND_CHAIR`, `CHAIRS_POSE`,
`contrastInk`, `spineLabelSpec`, `scaleSpineSpec`, `SIT_FETCH`,
`nextKeeperState`, `runKeeperTimeline`, `hopArc`, `labelPlacement`,
`INTERIOR_VIEWS`, `VIEW_TWEEN_SECONDS`, `createViewMachine`, `viewRequest`,
`viewStep`, `viewIsTweening`, `pickAction`, `projectedSizePx`,
`shelfFontRatio`, `shelfLabelSizing`, `shelfViewFraming`, `DOZE`,
`nextDozeState`, `runDozeTimeline`, `enqueueRemember`, `nextRemember`.

Doze machine: `DOZE` is `awake -(sleep)-> settling -(seated)-> dozing
-(rested)-> awake` (`rested` while settling wakes her without dozing).
Remember queue: `enqueueRemember(queue, slugs, {limit = 3})` keeps only the
FIRST valid slug per event, dedupes (a re-remembered slug moves to the back)
and bounds the queue; `nextRemember(queue, busy)` pops in order, never while
busy. Both return new arrays. `pickAction` additionally maps `{ keeper: true }`
hits to `{ type: "keeper" }` in every view (still locked mid-tween).

View machine shape: `createViewMachine()` -> `{ current, target, t, seconds }`;
`viewRequest(machine, view, { force })` -> accepted boolean (mid-tween input is
rejected unless `force`, used by the programmatic reader jumps);
`viewStep(machine, dt)` -> `{ k, settled, view }` with eased progress k.

`ui/interior_views.js` (mounted by this scene, browser only):

```js
import { createInteriorViews, createInteriorReadout } from "./ui/interior_views.js";
const views = createInteriorViews({ root, bus, onSelect, onExit, active });
// -> { el, setActive(view), dispose() }
const readout = createInteriorReadout({ root, bus, state, keeperId, capacity });
// -> { el, refresh(), dispose() }
```

The navigation cluster: four holo-kit buttons (classes `holo-btn`, active view
`holo-btn--primary`, styles from `ui/holo/holo.js` `ensureHoloStyles`) stacked
VERTICALLY bottom-right (`role="group"`, label "Room navigation"), top to
bottom: "Back to Keeper" (view `main`; from the settled main view the scene
answers with a gentle look-tween onto her instead of a camera move), "Sit
beside her" (`chairs`), "Bookshelf" (`shelf`), then "Back to the island"
(emits `interior:exit`; it replaced the scene's old bottom-left back button).
Stateless: clicks always emit; the scene calls `setActive` with the view that
is actually up (the exit button never carries active state).

The room readout: a small unobtrusive card bottom-left (`role="status"`) with
her name, `LV n`, `<n> of <LIBRARY_CAP> shelved` and her rest in warm words
(`rested` / `getting tired` / `needs to dream`, via the pure `restWording` /
`readoutModel` exports; the player never reads engine vocabulary). It reads
`state.keepers` and refreshes itself on `state:loaded`, exactly like the tired
look does. `capacity` defaults to `LIBRARY_CAP` (imported from this scene
module).

### Bus events

Consumed:

- `"reader:closed"`: the fetched book flies home, the keeper walks back, and the
  view active before the pick is restored (force tween).
- `"book:created"` / `"book:destroyed"` `{ keeperId, book|slug }`: add/remove a
  spine mesh (destroying the fetched book aborts the fetch).
- `"interior:view"` `{ view }`: switch view; emitted by the holo buttons.
  Unknown views and mid-tween requests are ignored. `main` while the main
  view is already settled runs the gentle "Back to Keeper" re-frame (the
  camera stays put and turns onto her chair over ~0.9 s; any real view
  change cancels it).
- `"memory:used"` `{ keeperId, slugs }` (this keeper only): silent fetch of the
  first used slug, queued/skipped gracefully when she is busy.
- `"keeper:sleep"` / `"keeper:rested"` `{ keeperId }` (this keeper only): doze on the
  chair / wake rested (`setSleeping(false)` + `setTired(0)`).
- `"state:loaded"`: re-apply her tired level from the fresh
  `keeper.session.status` (skipped while she dozes); the room readout refreshes
  itself from `state.keepers` on the same event.

Emitted:

- `"book:open"` `{ keeperId, slug }` when the fetched book floats out (the view
  is forced to `main` first; the pre-pick view is remembered). While she
  dozes, a pick opens the reader directly without waking her (no fetch).
- `"keeper:selected"` `{ keeperId }` when the empty-library hint book OR the keeper
  herself is clicked (same talk panel as the overworld).
- `"interior:exit"` on Esc from the settled main view (the scene no longer
  has its own back button and no longer emits `mode:set`).

`ui/interior_views.js` emits `"interior:view"` `{ view }` on a view-button
click (and calls `onSelect(view)`) and `"interior:exit"` on "Back to the
island" (and calls `onExit()`); the readout consumes `"state:loaded"`.

### Invariants

- Views are exactly `main | chairs | shelf`; tweens run ~0.8 s
  (`VIEW_TWEEN_SECONDS`) with eased position + lookAt; ALL pointer/keyboard
  input into the scene is ignored mid-tween (`pickAction` returns null,
  `viewRequest` rejects, Esc is swallowed).
- Esc layering (capture phase on the scene's document): reader open or focus
  inside `#ui` -> the overlay owns Esc; non-main view -> back to main and the
  event is stopped so main.js never exits; settled main view -> falls through
  to the existing exit path.
- Picking a book from any view forces `main` for the fetch choreography; on
  `"reader:closed"` the previous view is restored, unless the user manually
  switched views while the reader was open.
- Shelf view framing (`shelfViewFraming`) fills the view with the whole case
  but clamps closer whenever the typical title would land under 14 px on
  screen, never closer than 1.05 world units; spine canvases on the framed
  wall re-render upscaled (`shelfLabelSizing`, cap 3x, never downscaled) so
  the close-up stays crisp.
- The guest armchair and both bookcases are raycast hotspots (hover cursor +
  soft emissive highlight); books and the hint book always win the raycast
  over hotspots; a hotspot for the view you are in does nothing. The keeper's
  body meshes are raycast targets too (`userData.pick === "keeper"`).
- The silent memory fetch NEVER opens the reader or changes the camera view;
  a user pick during it upgrades it to the normal reader flow (no double
  `book:open`); `keeper:sleep` aborts it gracefully.
- Memory fetches drain from the queue only when she is awake, seated and the
  reader is closed; `memory:used` for other keepers / unknown slugs is dropped.
- Everything from before the views feature is unchanged: sit/fetch machine
  timeline, empty-library hint book, window sky, procedural textures,
  `dispose()` releases every geometry/material/texture and all listeners.

### How to test

```
cd frontend && npx vitest run tests/scene_interior.test.js tests/interior_views.test.js
```

`tests/scene_interior.test.js`: pure helpers (slotting, 24-slot capacity math
+ full-shelf bounds + visibly-full thickness scaling, facing-chairs geometry,
spine specs, sit/fetch timeline, doze machine, remember queue, view machine,
pickAction, shelf framing + label sizing) plus a headless end-to-end run (no
WebGL, `container: null`): fetch loop, a full 24-book library (digests
included) staying inside the cases, silent memory:used fetch + queueing, doze
/ wake (eyes + Zzz), tired level from session status, view tweens + input
lock, the "Back to Keeper" re-frame (start / cancel / final look direction),
chairs camera seated in the guest chair looking at her, Esc layering,
reader-close view restore, hotspot meshes, close-up canvas re-render, and a
jsdom click on the keeper emitting `keeper:selected`.
`tests/interior_views.test.js`: RTL + user-event through a real DOM (nav
cluster order top-to-bottom, view clicks emit `interior:view`, exit emits
`interior:exit` only, active state, readout content + warm wording +
state:loaded refresh, dispose).

## shelf_pan.js

### Purpose

2D pan for the interior shelf close-up: drag the framed bookcase on x/y so
small screens can reach every spine. Pure logic, no three.js, no DOM;
`scene_interior.js` owns the wiring (pointer events in, camera offsets out)
and applies the offset as a camera truck (position + lookAt together: never a
zoom, depth move, or rotation).

### Public API

```js
import { panLimits, worldPerPixel, clampOffset, createShelfPan, applyDrag } from "./render/shelf_pan.js";

panLimits({ layout, distance, fovDeg, aspect, bookH, margin })
// -> { maxU, maxV }  max camera offset per axis (world units): the case's
//    overflow past the viewport; {0, 0} when everything fits (no pan).
worldPerPixel({ distance, fovDeg, viewportH })  // world units per screen px
clampOffset({ u, v }, { maxU, maxV })           // symmetric clamp, -0 normalized
createShelfPan({ thresholdPx = 4 })
// -> { dragging, down(x, y), move(x, y), up(), cancel() }
//    move() -> null before the threshold, then { dx, dy } pixel deltas;
//    up() -> { wasDrag } so the caller can swallow the click a drag ends on.
applyDrag(offset, delta, { worldPerPx, limits })
// -> next clamped offset, content-follows-pointer (drag right -> camera left).
```

### Invariants

- `u` runs along the screen's x axis; the scene maps it onto world z with the
  wall's sign (`shelfWall === 0 ? -u : u`). `v` is world y. Both reset when a
  view change leaves the shelf.
- A press only becomes a pan past `thresholdPx`, so book picks stay clicks.
- Tests: `tests/shelf_pan.test.js` (limits math, px->world, clamp, drag
  machine, accumulate + clamp, click-vs-drag).

## blend.js

### Purpose

Camera-driven day/night environment crossfade plus dithered material
transition bands. Pure math, no three.js.

### Public API

- `ENV` day/night presets; `envAt(n) -> env` continuous crossfade;
  `mixHexColor(a, b, t) -> hex`; `easeBlend(current, target, dt, rate = 3.2)`;
  `createDistrictTracker({initial, low, high, minGapS}) -> {district, update(n, dt) -> name|null}`.
- `blendBand(value, edge0, edge1, dither = 0.5, ditherAmp = 0.6) -> 0..1`
  a smoothstep whose band shifts with the per-sample `dither` (0..1 noise),
  so material borders (grass-sand, grass-dirt, district tint) dissolve
  organically. Monotonic in value; dither 0.5 is the plain smoothstep.

### Bus events

None (pure module).

### Invariants

envAt is continuous in n and matches the presets at 0/1; the tracker has
hysteresis (low/high) and throttles flips (minGapS); blendBand stays in
[0, 1] and saturates outside the band for every dither.

### How to test

`cd frontend && npx vitest run tests/blend.test.js`

## terrain.js

### Purpose

Overworld ground, water, coast and grass: the heightfield mesh (dithered
vertex colors x a procedural macro texture), depth-tinted water with calm
glints, animated shore foam, and instanced swaying grass tufts. Procedural
canvas textures only. There is NO rocky coast rim anymore: the owner asked
for the brown collar slabs to be removed (BACKLOG 1); grass fades into sand
and water everywhere.

### Public API

Pure (tested): `groundShade({height, slope, streetW, hubW, nightW, tone,
waterLevel, dither = 0.5}) -> [r,g,b]` (every band goes through
`blendBand`; street/hub weights are perturbed only inside their transition
so meadow stays meadow and roadbeds stay solid);
`macroShade({grain, mottle, flowerW, mossW, contourW, wearW, sandW}) -> [r,g,b]`
(`sandW` = texel-level beach dither, warm sandy lift);
`grassPlacements(world, {count, seed})`; `extractShoreline(world, opts)`;
`coastSteepness(world, x, z, span)`; `foamMotion(t, phase)`.

Builders: `buildTerrain({world, resolution}) -> {mesh}`;
`buildWater({world, size, segments = 200}) -> {mesh, update(elapsed, tintHex)}`
(200 segments smooth the widened turquoise shallow band; calmer, dimmer
glints; slightly smaller waves); `buildShoreFoam({world, chains})`;
`buildCoastRim()` (returns an EMPTY named group: kept only so the scene call
site keeps working until the next scene-owned cleanup removes it);
`buildGrass({world, placements}) -> {mesh, update(elapsed)}`.

### Bus events

None; the overworld scene calls these directly.

### Invariants

All colors stay in [0, 1]; helpers are deterministic; the beach dither makes
grass-sand-water transitions speckled, never a drawn ring; the water wave
loop runs at 30 Hz and is the module's only per-frame CPU cost.

### How to test

`cd frontend && npx vitest run tests/terrain_helpers.test.js`

## props.js

### Purpose

Buildings and scenery: cottages (seeded per-keeper variants, style unchanged),
street ribbons, plaza/hub discs, empty-plot markers with VACANT signboards,
gardens, instanced trees, small props.

### Public API

Pure (tested): `cottageVariant(keeperId)`, `cottagePalette(palette, dark,
variant)`, `cottageObstacles(keeperId, {x, z, angle}) -> [{x, z, r}]`
(world-space collision circles for the variant's solid EXTENSIONS: two
porch pillars flanking the doorway, or the side shed; empty for
flowerbox/none; the door approach corridor is never covered, BACKLOG 18),
`endFadeAlpha(d, fadeLen = 2.4) -> 0..1` (terminal alpha ramp: 0 at the
tip, quadratic, 1 past the stretch), `vacantSignSpec() -> {text: "VACANT",
w, h, bg, ink, frame, font}`, `drawVacantSign(ctx, spec)` (draws on any
2d-context-shaped object), `flagTexture(topic, primaryHex) -> CanvasTexture`
(jsdom-safe topic banner).

Builders:

- `buildCottage({keeper, dark}) -> {group, door, windowMats, lanternMats}`;
  when `keeper.topic` (or name) is non-empty the group also carries a topic
  flag: `topic-flag-pole` plus `topic-flag-front`/`topic-flag-back` meshes
  (one shared MeshBasic canvas texture, readable from both sides, BACKLOG 8).
  The GROUP picks as the owner's house (`userData.pick "house"` + `keeperId`,
  BACKLOG 13): clicking any cottage part selects her; the door mesh AND its
  knob keep their own `"door"` pick, so a door click still enters the
  interior. Flag meshes carry no pick of their own (they bubble to "house").
- `buildStreetRibbon({points, world, width = 1.15, texture, fade = 1, endFade = null}) -> mesh|null`
  draped lane; `makeSandPathTexture()` fades its edges over a wide band
  undulating with low-frequency noise (seamless under v-repeat) plus texel
  dither, shoulders tinted grass-ward: lanes dissolve into the meadow.
  `endFade` (`{head, tail, length = 2.4}`) fades per-vertex alpha (RGBA
  color attribute, itemSize 4) to 0 at the flagged terminals over the last
  stretch (clamped to 40% of the lane per end), so ends meeting the plaza,
  the hub or another lane never draw a hard collided edge (BACKLOG 15); the
  scene flags them from `world.streets[].ends` junction hints (plot ends
  stay solid). Ribbons render at `renderOrder 1`, polygonOffset -2.
- `buildPlaza({center, radius, world, dark, texture}) -> {group, glowMats}`
  cobbled disc with a periodic-noise wobbled rim (no perfect circle).
- `buildEmptyPlots({plots}) -> {group, mist}` instanced undiscovered sites:
  stones, posts, boards, plus TWO instanced VACANT text faces (front and
  back of every board, one shared canvas texture, MeshBasic so it reads in
  the night quarter). 5 instanced draws total + one mist sprite per plot;
  the faint white ground ring was removed per owner feedback (BACKLOG 2).
  The post stops under the board so it never crosses the lettering.
- `buildGardens({plots, world, texture}) -> {group, glowMats}` renders each
  plot's pre-planned garden PROPS only (2-3 seeded props of existing
  kinds). The garden loop stays walkable via `plot.garden.loop` in
  sim/world.js but draws NO ribbon texture (BACKLOG 3). `world`/`texture`
  params are accepted and ignored for signature compatibility. Call with
  OCCUPIED plots only.
- `buildTrees({trees}) -> {group}` (max 2 instanced draws per species),
  `buildProp(prop, dark) -> {group, glowMats, floaty}`,
  `makeCobbleTexture()`, `makeSandPathTexture()`.

### Bus events

None; the overworld scene calls these directly.

### Invariants

Ribbon triangles wind counter-clockwise seen from above (+y) or the play
camera culls them; builders are deterministic per seed/id; jsdom-safe (2d
context failures fall back to undrawn textures); cottage/tree/prop visual
style stays as the owner approved it.

### How to test

`cd frontend && npx vitest run tests/props.test.js`

## sky.js

### Purpose

Gradient sky dome, SOFT sparse high clouds with faint ground shadow blobs,
and the night quarter's localized sky (stars, moon, aurora, pall).

### Public API

Pure (tested): `cloudLayout({world, seed, cumulus = 6, wisps = 4}) ->
clusters` (few, high y 22..30 so they never sit over the village paths,
slow drift <= ~0.26, translucent puffs <= ~0.44 opacity);
`cloudProximityFade(dist, radius) -> 0..1` (kept: sprites fade as the
camera flies in, the ground shadow stays); `drawCumulusPuff(ctx, w, h)`
(soft radial gradients ONLY, every gradient ends fully transparent inside
the canvas, plain source-over: no rims, no rectangles, no composite tricks).

Builders: `buildSkyDome({radius}) -> {mesh, update(nightness)}`;
`buildClouds({world, layout}) -> {group, update(dt, {tint, camPos})}`
(shadow blobs at opacity 0.06, cooled/faded over the quarter);
`buildNightSky({world, starCount, seed}) -> {group, update(dt, camBlend, elapsed)}`.

### Bus events

None; the overworld scene calls these directly.

### Invariants

cloudLayout is deterministic per seed; cumulus hang over the day side and
wisps over the quarter; every cluster keeps a sane drift/wrap range; puff
textures can never show a hard edge (enforced by the gradient-stop test).

### How to test

`cd frontend && npx vitest run tests/sky_helpers.test.js`

## scene_overworld.js

### Purpose

The island scene: one irregular landmass, two districts, spatial day/night
driven by the camera, cottages + gardens on occupied plots, VACANT sites on
empty ones, keepers wandering the street graph, chatter, minimap feed, and
the join cinematic.

Round 5: session fatigue + sleep. Every keeper's mesh gets
`setTired(tiredLevelFor(keeper))` on build and on every `state:loaded`
(droopy eyes, slower hop, Zzz at needs_sleep). On `keeper:sleep {keeperId}` the
SLEEP choreography plays (ambient, NO input lock, never a cinematic): she
stops chatting, walks home over the street graph
(`world.routeToDoorFrom`), fades through the door, the cottage windows dim
and a soft dream effect (pulsing glow + rising wisps, guarded canvas
sprites) plays above the roof; `keeper:rested {keeperId}` fades the effect and
she re-emerges rested (`setTired(0)`) with a small doorstep sparkle.
`memory:used {keeperId, slugs}` shows a brief sparkle + tiny book sprite over
her head. Joining a sleeping keeper cancels her sleep visuals and plays the
mini cinematic from her doorstep; a scene rebuild aborts all sleeps.

Round 6 (overworld behaviors): select-to-follow (any `keeper:selected`, from
a pick on her or her cottage or an outside module, tweens the camera to
`camera.FOLLOW_FRAMING` and follows her; user camera input, clicking
elsewhere, or the talk panel closing exits, BACKLOG 13+14); a global
chatter gate while anyone walks home (BACKLOG 4); the selection ring layers
over street ribbons (`SELECTION_RING`, BACKLOG 5); street-end alpha fades
from the graph's junction hints (BACKLOG 15); cottage extension footprints
feed the walkers (`props.cottageObstacles`, BACKLOG 18); the sleep dream
always dwells `SLEEP_TIMING.minDreamS` before waking.

### Public API

```js
import { createOverworldScene } from "./render/scene_overworld.js";
const scene = createOverworldScene({ state, bus, api, config, container, ui, renderer, camera });
// -> { scene, update(dt), dispose(), onResize(w, h), joinKeeper(keeperId) }
```

Pure exports: `createCinematicTimeline(timing) -> {phase, active, start,
arrive, skip, cancel, update}` and `CINEMATIC_TIMING`;
`createSleepTimeline(timing) -> {phase, active, clock, timing, start({atDoor}),
arrive, rested, cancel, update}` (phases `idle -> walking -> entering ->
dreaming -> waking -> idle`; events `started/walk/enter/dream/wake/done`;
`rested()` before she is inside OR before the dream has dwelled is
remembered; `wake` never fires before `minDreamS` of dreaming, so an
instant backend still shows a visible dream) with
`SLEEP_TIMING = {enterS, wakeS, sparkleS, minDreamS}`;
`sleepGlow(phase, clock, timing) -> 0..1` (dream-effect intensity: ramps in
entering, 1 dreaming, fades waking; the door fade is `1 - k` in both
directions); `dreamWisp(u, {rise}) -> {y, opacity, scale}` (loops, opacity 0
at both ends); `SELECTION_RING = {inner, outer, lift, renderOrder,
polygonOffsetFactor, polygonOffsetUnits}` (renderOrder 2 + offset -4: the
ring always draws crisply ON the street ribbons, which sit at order 1 and
offset -2, while depth testing still hides it behind terrain);
`chatterPausedFor({cinematicActive, sleepPhases}) -> bool` (true while the
join cinematic runs or any sleep timeline is in phase "walking": no chatter
bubble spawns anywhere until arrival; the scene passes chatter.update an
empty visible list so timers keep ticking); `resolvePickTarget(obj) ->
{pick, keeperId} | null` (walks up the parents to the first `userData.pick`;
hidden chains resolve null; door meshes keep "door", other cottage parts
bubble to "house"); `clickOutcome(target, selectedKeeperId) -> {type:
"select"|"enter"|"deselect", keeperId} | null` (pure mapping of the first
resolved pick to what a click means: keeper/house selects, the door enters,
and a click that resolves NOTHING while someone is selected deselects her;
the scene then emits `keeper:deselected` {keeperId} so the talk panel closes,
and clears the ring + follow itself).

Walkers: each keeper gets `createWalker` with
`sampleRoute: makeGraphWanderPlanner(world, {sector, plotId})`, so NPCs walk
ONLY on the street network (own garden, district junctions, plaza or night
hub), with route-clamped separation and lane passing (two walkers meeting
slow down and pass on their own right within the lane), the stall watchdog
(a wedged wander re-routes) and the hard sector clamp (never cross
districts). Walker obstacles are `world.obstacles` plus each cottage's
`cottageObstacles` footprint (porch pillars, sheds). The join cinematic and
the sleep walk route home with `world.routeToDoorFrom(pos, plotId)` and
`walker.followRoute(route, {goal: true})`; the goal arrival triggers the
door pause + push + fade (join) or the door fade (sleep).

### Bus events

Emitted: `keeper:selected {keeperId}` (picking her OR any part of her cottage;
the door keeps its enter pick), `keeper:deselected {keeperId}` (a true click on
nothing pickable while someone is selected; the talk panel closes on it and
the scene clears the ring + follow), `house:enter {keeperId}`,
`mode:set "interior:<id>"`, `district:changed {district}`,
`minimap:update {keepers, camera}`, `cinematic:started {keeperId, name}`,
`cinematic:fade {seconds}`, `cinematic:ended {keeperId}`.

Consumed: `district:travel`, `keeper:join {keeperId}`, `cinematic:skip`,
`minimap:jump {x, z}`, `state:loaded` (re-apply tired levels),
`keeper:selected {keeperId}` (select-to-follow: `cameraRig.follow` with
`FOLLOW_FRAMING`; ignored mid-cinematic; a selection recorded in
`state.selectedKeeperId` BEFORE this scene existed, e.g. the keepers list
stepping out of an interior while the module still loads, is applied the
same way on build), `ui:open`/`ui:close`
`{panel: "dialog"}` (close = deselect on the next frame: ring off, follow
ends; a synchronous close-reopen while switching keepers cancels the pending
deselect), `keeper:sleep {keeperId}` (sleep choreography), `keeper:rested
{keeperId}` (wake + sparkle), `memory:used {keeperId, slugs}` (glint over her
head).

### Invariants

Population rebuilds only when the keeper id/kind set changes; a mid-cinematic
rebuild aborts the cinematic and restores input; picking is disabled during
cinematics; keepers beyond plot capacity are skipped until a plot frees;
`dispose()` releases everything and never leaves input locked.

Sleep is ambient: it never locks input, never moves the camera, and at most
one sleep per keeper runs at a time (`keeper:sleep` while she sleeps, or while
her join cinematic plays, is ignored). Sleeping keepers are excluded from
chatter, and while ANY keeper walks home (join or sleep) chatter is gated
globally (`chatterPausedFor`); window dim/dream/sparkle materials are
created per effect and disposed with it (rebuild + dispose both abort
cleanly). The dream always shows for at least `minDreamS`. `tiredLevelFor`
comes from keeper_mesh.js. Select-to-follow never fights the cinematic (the
chase owns the camera; selection is locked during cinematics anyway).

Draw-call impact of the organic-island round: street ribbons ~48 meshes
(was ~30), gardens add 1 ribbon + 2-3 prop groups per occupied plot, empty
plots 6 instanced draws (was 4, VACANT faces), clouds fewer sprites, water
200x200 segments (was 120).

### How to test

`cd frontend && npx vitest run tests/scene_overworld_cinematic.test.js tests/scene_overworld_sleep.test.js tests/scene_overworld_behaviors.test.js tests/world.test.js tests/walker.test.js`
(the scene's logic lives in the pure timelines + helpers + sim modules; for
a live look run `bash scripts/dev.sh`).

## scene_graph.js

### Purpose

The consolidation movie: dark space backdrop, glow-sprite nodes, edges that
draw themselves, assembly playback driven by the sim/graphlayout timeline,
slow auto-orbit camera, then a settled interactive state (OrbitControls +
hover highlight). Mounts `ui/graph_hud.js` itself (root = `#ui` or the
container).

### Public API

```js
import { createGraphScene } from "./render/scene_graph.js";
createGraphScene(ctx = {})   // ctx: { state, bus, container, config, renderer, camera, report }
// -> { scene, camera, update(dt), dispose(), skip(), get settled }
```

`report` falls back to `ctx.state.latestReport`; `renderer`/`camera` are
owned unless supplied. Pure exports (unit-tested, no three.js):
`easeInOutCubic(t)`, `easeOutBack(t)`,
`staggeredProgress(waveProgress, index, count, spread = 0.55)`,
`buildPlaybackSchedule(timeline, {nodeWaveSeconds, edgeDrawSeconds, ...})`,
`pickLabeledNodeIds(nodes, max)`, `parseHex(hex)`, `mixHex(hexA, hexB, t)`,
`keeperPaletteMap(state, report)`, `nodeColorHex(node, palettes)`,
`nodeScale(node)`, `starfieldPositions(count, innerRadius, outerRadius, seed = 42)`,
`edgeCurvePoints(a, b, segments = 24, bulge = 0.16)`, `ENTITY_GOLD`.

### Bus events

Emitted: `graph:wave` {index, t} (wave landing), `graph:progress`
{t, settled} (throttled to 0.01 steps), `graph:settled` {report},
`mode:set` "overworld" (in response to graph:back).
Consumed: `graph:skip` (fast-forward to settled), `graph:back`.

### Invariants

Playback is deterministic per report (layout and schedule are pure);
`skip()` and `graph:skip` land on the exact settled state; hover picking is
active only when settled; `dispose()` unsubscribes, removes listeners,
disposes controls/HUD and (when owned) the renderer.

### How to test

`cd frontend && npx vitest run tests/scene_graph_helpers.test.js tests/graphlayout.test.js tests/graph_hud.test.js`

## renderer.js

### Purpose

WebGLRenderer factory: sRGB output, ACESFilmic tone mapping (exposure 1.05),
PCF soft shadows, DPR capped at 2, container-driven resize, and an optional
post pipeline slot so a scene can route frames through a composer.

### Public API

```js
createRenderer({ container, win = globalThis } = {})
// -> { renderer, get domElement, get size, render(scene, camera),
//      setPipeline(p), get pipeline, onResize(fn) -> off, dispose() }
```

`setPipeline({ render, setSize, dispose })` routes `render()` through the
pipeline (null restores direct rendering; the caller keeps ownership).
`onResize(fn)` calls `fn(width, height)` immediately and on every resize.

### Bus events

None.

### Invariants

Canvas is appended to `container` on create and removed on `dispose()`;
sizes never go below 1x1; ResizeObserver is used when available, window
resize otherwise.

### How to test

Exercised through the overworld scene tests; no standalone suite (thin
three.js wrapper, no pure logic).

## camera.js

### Purpose

Camera rig on OrbitControls, "grab the ground" style: left/right drag pan,
right or middle drag orbit, wheel zoom, modifier flips pan/orbit. Focus/follow tweens
(follow optionally eases into a standard framing: the select-to-follow shot)
plus a cinematic third-person chase solver (used by the join cinematic).

### Public API

Pure (tested, no WebGL): `frameLerp(perFrame, dt)`,
`dragModeForPointer({button, ctrlKey, metaKey, shiftKey})`,
`createDragTracker({ clickMoveMax = 6, clickHoldMaxMs = 450 } = {})`,
`FOLLOW_FRAMING = {distance: 7, pitch: 0.5, lerp: 0.08}` (the standard
select-to-follow shot: close enough to read her face, never macro),
`frameOffset(offset, framing = FOLLOW_FRAMING) -> {x, y, z}` (retargets a
camera offset to the framing's distance + pitch, azimuth preserved),
`CHASE_DEFAULTS`, `chaseShot(target, heading, params = CHASE_DEFAULTS)`,
`createChaseSolver(params = {}) -> { update({target, heading, dt, heightAt}) -> {position, lookAt}, setParams(partial) }`.

```js
createCameraRig({ domElement, config: cam = {}, aspect = 1 } = {})
// -> { camera, controls, focus(target), follow(target, {framing}), stopFollow(),
//      startChase(target, opts), setChaseParams(partial), stopChase(),
//      get focusing, get following, get chasing,
//      setControlsEnabled(enabled), update(dt), onResize(w, h), dispose() }
```

`follow(target)` keeps the current camera offset while tracking;
`follow(target, {framing})` also eases the offset to the framing preset
(the overworld's select-to-follow). Limits (fov, min/max distance, polar
angles, speeds, lerp factors) come from `config.camera`; the overworld
merges `sim/world.js CAMERA_OVERRIDES` on top.

### Bus events

None.

### Invariants

`focus` and plain `follow` preserve the orbit offset; a framed follow eases
distance/pitch to the preset but never spins the azimuth; user camera input
cancels follow (framed or not) but NOT chase (chase ends only via
`stopChase()`); a later plain follow never inherits an old framing; the
chase solver clamps above `heightAt(x, z)` so the camera never clips the
ground; `update` is safe with dt = 0.

### How to test

`cd frontend && npx vitest run tests/camera.test.js`

## keeper_mesh.js

### Purpose

The keeper: procedural kawaii pink blob matching sample/keeper.png, built from
geometry and vertex colors only (the one exception: the tiny Zzz canvas
sprite). Conscious keepers all share KEEPER_PINK; unconscious ones are darker
(moonlit tint), hover-float and blink slower, but fully OPAQUE like everyone
else: the old body translucency was removed per owner feedback (BACKLOG 11
visual half; `derivePalette("unconscious").opacity` is 1). Locomotion is a
squash-stretch hop with ground-contact squish. Session fatigue (round 5):
`setTired(level)` droops the eyelids, slows the hop slightly and shows a
pulsing Zzz sprite at level 2; `setSleeping(v)` shuts the eyes and switches
to slow deep breathing (the interior doze).

### Public API

Pure (tested): `hexToRgb(hex)`, `rgbToHex({r, g, b})`, `mixHex(a, b, t)`,
`lightenHex(hex, t)`, `darkenHex(hex, t)`, `KEEPER_PINK = 0xf8a7c0`,
`derivePalette(_palette = {}, kind = "conscious")`,
`hopPose(u, {height, squash, stretch, contact})`, `blinkOpenness(u)`,
`breathScale(t, {amplitude, hz})`,
`TIRED_STATUS = {rested: 0, unrested: 1, needs_sleep: 2}`,
`tiredLevelFor(keeperOrSessionOrStatusOrNumber) -> 0|1|2` (unknown -> 0),
`eyelidPose(level) -> {lid, offsetY}` (monotonic droop, clamped),
`tiredHopHz(level, base = 2.2)` (level 2 is ~22% slower),
`zzzPulse(t, {period}) -> {opacity, scale, y}` (never fully invisible).

```js
createKeeperMesh({ keeper = {}, config = {} } = {})
// -> { group, setWalking(v), setSelected(v), setOpacity(f),
//      setTired(level), setSleeping(v), update(dt), dispose() }
```

The eye group is named `"eyes"` and the Zzz sprite `"zzz"` (the headless
tests find them by name).

### Bus events

None; the scenes drive it directly (both apply `setTired` from
`keeper.session.status` via `tiredLevelFor`, on build and on `state:loaded`).

### Invariants

`Keeper.palette` is ignored for the conscious body color (all pink);
`setOpacity` multiplies every material and hides the group under 0.01 (the
Zzz sprite follows it and never shows on a hidden mesh); blinking still runs
under drooped lids and is suspended while sleeping; eyelid changes ease in
(never pop); `update` tolerates invalid dt; `dispose()` frees all geometries
and materials including the Zzz sprite's.

### How to test

`cd frontend && npx vitest run tests/render_helpers.test.js`

## speech.js

### Purpose

Speech bubbles: canvas-texture sprites above an keeper. Pop-in with overshoot,
hold, fade-out; big font so lines read at game camera distance.

### Public API

Pure (tested): `wrapBubbleText(text, maxChars = 22, maxLines = 4)`,
`popScale(u)`, `bubbleSeconds(text, base = 4.5)`.

```js
createSpeech()
// -> { get count, show({text, target, offsetY, seconds}), update(dt), setTint(hex), dispose() }
```

`target` is the Object3D the bubble hovers over (the sprite is added as a
child, so it follows for free). `setTint` takes the district blend's bubble
tint (white paper by day, moonlit over the night quarter).

### Bus events

None; the overworld feeds it from the chatter scheduler + `api.getChatter`.

### Invariants

Expired bubbles dispose their sprite/material/texture; `wrapBubbleText`
never exceeds maxLines (ellipsizes the last line) and hard-breaks over-long
words.

### How to test

`cd frontend && npx vitest run tests/render_helpers.test.js`

## fx.js

### Purpose

Optional post-processing for the overworld: subtle UnrealBloom so emissive
windows, lanterns and crystals glow at night. Flag-gated; with
`bloom: false` the renderer draws directly at zero extra cost.

### Public API

```js
export const overworldFlags = { bloom: true, bloomStrength: 0.3, bloomRadius: 0.5, bloomThreshold: 1.05 };
createBloomPipeline({ renderer, scene, camera, width = 1, height = 1, flags = overworldFlags })
// -> { render(), setSize(w, h), setEnv({bloomThreshold, bloomStrength}), dispose() }
```

The return shape plugs into `renderer.js` `setPipeline`.

### Bus events

None.

### Invariants

Threshold stays above 1.0 by day so lit ground never blooms; the overworld's
district blend lowers it over the night quarter via `setEnv`.

### How to test

Exercised through the overworld scene; no standalone suite (thin composer
wiring).

## audio.js

### Purpose

Procedural WebAudio blips (oscillator + gain envelope, no asset files) that
turn bus events into sounds. Autoplay-safe: the AudioContext is created only
after the first user gesture (pointerdown/keydown/touchstart on `target`);
earlier blips are dropped silently.

### Public API

```js
createAudio({ bus = null, target = globalThis } = {})
// -> { play(name, opts), isMuted(), setMuted(value), get unlocked, dispose() }
export const BLIPS  // name -> tone spec(s); specs may be functions of opts
```

Blip names: `select`, `reply`, `book`, `wave` ({index}), `panel`,
`panelClose`, `voice` ({mode}), `mic` ({on}), `district` ({district}).
Direct `play()` works without a bus.

### Bus events

Consumed (all optional): `keeper:selected` -> select, `book:created` -> reply,
`book:open` -> book, `graph:wave` -> wave, `ui:open` / `howto:open` /
`create_keeper:open` -> panel, `ui:close` / `reader:closed` -> panelClose,
`voice:state` -> voice, `voice:mic` -> mic, `district:changed` -> district
ambience shift, `audio:mute` {muted} -> gate for everything above.
Emitted: none.

### Invariants

Audio is decoration: every WebAudio failure is swallowed and can never break
the game; muted/disposed drop all blips; `dispose()` unsubscribes, removes
gesture listeners and closes the context.

### How to test

`cd frontend && npx vitest run tests/audio.test.js`
