# sim/ module contracts

Per the isolation policy, every isolated module in this directory keeps its
section here up to date on every modification. Sections are independent so
parallel work merges cleanly: add or edit ONLY your module's section.

Pure game logic. No three.js, no DOM, no network. Everything here is
deterministic given its inputs (seeded hashes/PRNG), which is what makes the
whole layer unit-testable and the world stable across sessions.

Modules: `rand.js`, `world.js`, `walker.js`, `chatter.js`, `graphlayout.js`.

## rand.js

Purpose: seeded randomness shared by the sim modules and importable by
render scenes.

- `hashString(str) -> uint32` FNV-1a.
- `mulberry32(seed) -> () -> [0,1)` seeded PRNG.

## world.js

Purpose: the fixed island geography (irregular coastline, heightfield,
street graph, plots, gardens, props, trees) plus keeper-to-plot occupancy.
Geography NEVER depends on which keepers exist; only occupancy does.

### Public API (exact signatures)

Primitives:

- `smoothstep(edge0, edge1, x) -> 0..1`
- `makeNoise2D(seed) -> (x, z) -> [0,1)` value noise, continuous.
- `makeFbm2D(seed, octaves = 3) -> (x, z) -> [0,1]` fractal noise.
- `shoreProfile(h, waterLevel = 0, opts) -> h'` beach-shelf softening,
  strictly monotonic.
- `flattenPlots(h, x, z, plots) -> h'` blends height toward plot levels.
- `clampToSector(sector, point, margin = 1.0) -> {x, z}` disc clamp.

Plot grid:

- `planPlots(options = {}) -> [{id, sector, x, z, angle}]` 16 day + 8 night
  sites, deterministic. The angle here is provisional (faces the hub);
  `layoutWorld` re-aims every plot at its street-graph junction.
- `assignPlots(keepers, plots = planPlots()) -> {assigned: Map<keeperId, plot>, unplaced: [keeperId]}`
  arrival-order (created_at) first-fit with per-keeper hash start. Adding an
  keeper moves nobody; removing frees the plot.

Street graph routing:

- `nearestNode(graph, x, z, {sector = null, kinds = null}) -> node | null`
- `routeOnGraph(graph, fromId, toId, {sector = null}) -> [{x, z}] | null`
  Dijkstra over edge lengths; `[]` when fromId === toId; null when
  unreachable. Passing `sector` restricts to that district's edges (the
  ridge road is sector "ridge", so district-bound routing can never cross).
- `routeClearOf(points, center, radius) -> [{x, z}]` bends a polyline
  around a hard circle: waypoints inside are lifted onto the rim, segments
  cutting through get a detour waypoint just outside the radius (routes
  THROUGH a hub node jump rim-to-rim across the disc, straight over the
  centerpiece otherwise).
- `makeGraphWanderPlanner(world, {sector, plotId = null}) -> (random, pos) -> [{x, z}]`
  a walker `sampleRoute`: picks the keeper's own garden (~34%), the plaza or
  night hub (~22%), or a random junction, and routes there along the edges.
  Garden trips append a stretch of the plot's garden loop. Hub strolls keep
  routing clearance around the centerpiece (centerpieceR plus
  centerpieceClearance) and stay on the entry side of the disc; every
  planned route is passed through `routeClearOf` for the district's
  centerpiece, so walkers path around the well/obelisk, never into it.

Constants: `WORLD_DEFAULTS` (sizes, radii, plot counts 16/8, street width
tiers `{ridge, avenue, lane, spur, garden}`, `coast` irregularity tuning,
`centerpieceR: {day: 1.15, night: 0.85}` + `centerpieceClearance: 0.45`
for the plaza well / night obelisk),
`CAMERA_OVERRIDES` (zoom limits the overworld merges over config.camera).

### layoutWorld(keepers = [], options = {}) -> world

The world object:

- `plots: [{id, sector, x, z, y, angle, plotRadius, occupied: keeperId|null, door: {x,z,y}, garden}]`
  where `garden = { gate: {x,z}, loop: [{x,z,y} x13, closed, starts/ends at
  the gate], props: [{kind, x, z, y, scale, rotation, sector}] }`. Garden
  prop kinds are existing prop kinds only (day: flower/bush/rock, night:
  crystal/rock/bush). EVERY plot carries a garden; the render layer only
  draws it when the plot is occupied.
- `unplaced: [keeperId]` beyond plot capacity.
- `homes: { [keeperId]: {x, z, y, angle, sector, isle, plotId, plotRadius, door, spawn} }`
  door = plot + 1.4 units along `angle`, spawn at 3.0 (both on the facing ray).
- `streets: [{id, sector, kind: "spur"|"avenue"|"lane"|"ridge", width, plotId?, ends: {head, tail}, points: [{x,z,y}]}]`
  one entry per graph edge, same shape the minimap has always consumed.
  Spur ids equal their plot id; the ridge road id is "ridge". Street points
  are clamped above the waterline. `ends` carries the junction hints: the
  node KIND (`"plaza"|"hub"|"junction"|"plot"`) each terminal lands on, so
  the render layer can fade lane ends that collide with the plaza, the hub
  or another lane while door approaches (plot ends) stay solid.
- `graph: { nodes, edges, adjacency }`
  nodes: `{id, kind: "plaza"|"hub"|"junction"|"plot", sector, x, z}` (plot
  nodes are the spur gates, id `plot:<plotId>`); edges:
  `{id, a, b, kind, sector, width, length, points}` (curved jittered
  polylines, loops allowed); adjacency: `{ [nodeId]: [{edgeId, to}] }`, both
  directions. Every plot node is reachable from its district's main node.
- `routeToDoorFrom(from, plotId) -> [{x, z}]` graph route from the nearest
  district node to the plot gate, ending at the doorstep; bent around the
  district hub's centerpiece via `routeClearOf` (these are goal walks the
  walkers never abandon). Used by the join cinematic and the sleep walk.
- `props`, `trees`, `obstacles` (solid circles: occupied cottages, hub
  centerpieces at `centerpieceR`, chunky props, tree trunks; garden props
  are NOT obstacles), `centerpieceR`, `centerpieceClearance`,
  `sectors {day, night}`, `plaza`, `hub`, `isles` (legacy minimap alias),
  `waterLevel`, `size`.
- Field samplers: `heightAt(x, z)`, `normalAt(x, z)`, `nightMaskAt(x, z)`,
  `sectorNameAt(x, z)`, `streetWeightAt(x, z)`, `hubWeightAt(x, z)`.

Coastline: ONE irregular landmass. Each lobe's radius is modulated by
periodic angular noise (bays and headlands) and the whole field is
domain-warped; a guaranteed core disc per district plus a core neck corridor
means the sea can never cut under the plot rings or the ridge road. Tuning
lives in `WORLD_DEFAULTS.coast`. Land area is at least the old two-circle
area (tested).

### Invariants

- Geography (plots minus occupancy, streets, graph, gardens, props, trees,
  heightAt) is byte-identical for ANY keeper set.
- Determinism: same inputs, same world, including iteration order.
- Plot assignment is add-stable and remove-frees.
- heightAt is continuous; plots are flat discs; streets carve gently and
  never dip below the waterline; grades stay walkable.
- The graph is connected per district; the only day-night connection is the
  ridge edge (sector "ridge").
- nightMaskAt rises monotonically from the village to the quarter.

## walker.js

Purpose: wander/goto/route steering on the xz plane with separation, lane
passing, obstacle avoidance, a stall watchdog, sector clamping and
street-route adherence. The scene owns y.

### Public API

`separationPush(pos, neighbors, {radius = 0.9, bias = 0}) -> {x, z}`
`obstaclePush(pos, obstacles) -> {x, z}`
`passingAdjust(pos, heading, neighbors, {radius = 1.6}) -> {x, z, slow}`
lane passing: neighbors roughly AHEAD (within the radius, bearing cos >
0.2) bias the walker to its OWN right and lower `slow` (floor 0.3), so two
walkers meeting head-on drift to opposite shoulders and glide past instead
of pushing chest-to-chest; zero for neighbors beside/behind.

`createWalker(opts) -> walker` with opts:

- `position, speed, arriveRadius, pauseRange`
- `sampleRoute(random, pos) -> [{x,z}]` graph-route wander
- `random, neighbors() -> [{x,z}], obstacles, separationRadius,
  separationSpeed, separationBias, clamp(point) -> {x,z}`
- `routeWobble = 0.45` max lateral offset given to intermediate waypoints
- `routeClamp = 0.65` max lateral drift off the current route segment
- `stallSeconds = 2.5` watchdog: this long without progress toward the
  current target re-routes the walker

walker surface:

- getters `position, heading, target, walking, route` (route: remaining
  waypoints or null)
- `goto(t)` preempts everything, arrival event carries `goal: true`
- `followRoute(points, {goal = true}) -> bool` walk a polyline; ONE
  "arrive" at the final point; intermediate hops are silent and passed
  loosely (radius max(arriveRadius, 0.5))
- `stop()`
- `update(dt) -> [{type: "arrive", target, goal} | {type: "depart", target}
  | {type: "stall", target}]`
  (depart carries the route DESTINATION when wandering by route; stall
  fires when a wedged NON-goal walk is abandoned so the next wander plans a
  fresh route after a short 0.5 s beat)

### Invariants

- Never NaNs; invalid dt/targets ignored.
- While on a route the live position stays within `routeClamp` of the
  current segment: separation, passing and obstacle pushes can slow a
  walker or make it pass on the shoulder, never shove it off the street.
- Walking speed is scaled by `passingAdjust().slow` (never below 0.3), so
  encounters slow the walkers but never freeze them; the lateral pass bias
  is deterministic (each walker's own right).
- Stall watchdog: no progress for `stallSeconds` skips a wedged
  INTERMEDIATE waypoint, abandons a wedged non-goal walk with a "stall"
  event, and merely re-arms on goal walks (goto / followRoute goal: the
  join cinematic and sleep walks are never abandoned).
- Every waypoint AND the live position pass through `clamp`, so a walker can
  never leave its district no matter what the planner returns.
- Deterministic given positions and the seeded `random`.

## chatter.js

Unchanged this round. `createChatter({cooldownS, globalGapS, bubbleS,
jitterS, random}) -> {speaking, update(dt, visibleIds) -> {keeperId}|null,
extendBubble(seconds), reset()}`. One bubble at a time, global gap, per-keeper
cooldown, no same speaker twice in a row when avoidable.

## graphlayout.js

Seeded 3D force layout for the consolidation movie.
Exports: `computeGraphLayout(graph, opts = {}) -> { positions, timeline }`
(positions: `Map(nodeId -> {x, y, z})`; timeline: ordered waves
`[{t, nodeIds: [...]}, ..., {t, edgeIds: [...]}]`, t normalized in (0..1],
keepers first, then books, then entities, then edges by weight descending),
plus `edgeId(edge, index)`. Same graph in, identical positions and timeline
out, independent of node order.

## Bus events

None. sim/ modules neither emit nor consume bus events; the render scenes
call them directly.

## How to test

`cd frontend && npm test` (vitest). Suites: `tests/world.test.js` (grid,
assignment stability, heightAt, coastline irregularity, street graph
connectivity, gardens, planner), `tests/walker.test.js` (steering,
separation, obstacles, sector clamp, route following), `tests/chatter.test.js`,
`tests/graphlayout.test.js`. Everything runs in plain node/jsdom, no WebGL.
