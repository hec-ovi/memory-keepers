# frontend

Purpose: the game. A three.js SPA served as static ES modules, no build step, no CDN. Presentation only: every rule about memory, caps and grounding lives behind the engine API.

## Components

| component | what |
|---|---|
| shell | boot, world id (generated once, localStorage, sent as `X-World`), mode loop (overworld / interior / dream movie) |
| api client | the single fetch module; every request goes through it, errors map to `{code, message}` |
| sim | pure logic, no three.js: walker paths on the plot network, chatter scheduling, graph layout |
| render | three.js scenes: island (light village, dark side, spatial day/night), houses, keepers, interior with the 24-slot bookcase, dream movie playback |
| ui | holo panel kit (materialize/dissolve animations, reused by every modal), dialog with voice ring (listening) and orb (speaking) states plus mic button, book reader, HUD, minimap |

Each component becomes its own folder with a CONTRACT.md when its code lands.

## Keeper look

One shared body and animation set; identity comes from the skin: a material and color pair derived from the keeper's palette (per topic), with dark keepers on a night variant. No two keepers read as identical at a glance.

## World rules mirrored visually (never enforced here)

- Plot grid: 16 light plots, 8 dark plots; empty plots read VACANT. Creating a keeper fills the next free plot, deleting frees it.
- A keeper's level and tiredness show on her; `needs_sleep` routes the player to the sleep action.
- Book spines size by the book's `tier`; the shelf view pans in 2D so every spine is reachable on small screens.

## Invariants

- One API module; no fetch calls anywhere else.
- `sim` never imports three.js; `render` never contains game rules.
- Voice is optional: when `/voice` returns `VOICE_UNAVAILABLE` the dialog stays fully usable as text.
