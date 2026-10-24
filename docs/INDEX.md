# Box map

Each box is one folder with a CONTRACT.md; outsiders use the contract, never the code.

| box | purpose | depends on |
|---|---|---|
| frontend | three.js SPA: island, keepers, houses, libraries, holo UI, dream movie | engine |
| engine | FastAPI app: REST surface, world scoping, meters and caps, dream dispatch and the nightly timer, serves the frontend | agents, library, models, dreaming, lookups |
| agents | the monument (root), one agent per keeper (tell, ask, talk, notes), the ridge keepers (cross-shelf, therapeutic), dream agents (theme selection, prose, narrative), on a lean tool-calling loop | library, models, lookups |
| library | SQLite store: worlds, keepers, books, sessions, dream runs | - |
| models | model gateway: Qwen on an OpenAI-compatible llama.cpp server, fake tier for tests | - |
| dreaming | consolidation run: builds the knowledge graph and the dark keepers | agents, library |
| lookups | external lookups for keepers: podcast transcripts, song and book facts, lyrics, movie plots | - |

Runtime: one process (engine + frontend statics) and one SQLite file. Dreams run as background tasks on the engine's loop: asked from the HUD, dispatched by a tired keeper, or swept nightly at `DREAM_AT`. `docker-compose.yml` runs it all locally; the library lives in `./.data/memory-keepers.db` on the host.

Reading order for a fresh session: this file, then the CONTRACT.md of the box being changed.

Private notes (gitignored): `REQUIREMENTS.md` holds the owner's requests, raw and in order.
