# frontend / sim

Purpose: pure game logic, no three.js and no DOM. Everything is seeded and deterministic.

- `plots.js`: the island layout. `buildLayout()` -> 16 light + 8 dark plots with door angles, and the organic path network (nodes, edges); every door reaches the plaza. `islandRadiusAt(angle)` shapes the irregular shore.
- `walker.js`: keeper motion on the network only; keepers never leave their side and keep separation. `createWalker`, `stepAll(walkers, network, dt)`.
- `graphlayout.js`: `layout(graph)` -> deterministic force layout in [-1,1] for the dream movie.
- `rng.js`: `hashSeed`, `mulberry32`.

Test: `docker compose run --rm test-frontend` (tests/sim.test.js).
