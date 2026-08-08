# Box map

Each box is one folder with a CONTRACT.md; outsiders use the contract, never the code.

| box | purpose | depends on |
|---|---|---|
| frontend | three.js SPA: island, keepers, houses, libraries, holo UI, dream movie | engine |
| engine | FastAPI app: REST surface, world scoping, meters and caps, serves the frontend | agents, library, voice |
| agents | ADK agents: the monument (root), one agent per keeper, dream agents | library, models |
| library | Firestore store: worlds, keepers, books, sessions, dream runs | - |
| models | model gateway: Gemini on Vertex AI, local Gemma tier | - |
| dreaming | consolidation job: Pub/Sub triggered, builds the knowledge graph and the dark keepers | agents, library |
| voice | speech: Cloud Text-to-Speech and Speech-to-Text routers | - |

Deployment: one Cloud Run service (engine + frontend statics). Dreaming rides Pub/Sub: Cloud Scheduler hits `/internal/nightly`, tired keepers publish events, and a push subscription delivers both into `/internal/dream-run`. Firestore is the only store. `scripts/deploy.sh` creates all of it; `docker-compose.yml` runs the same stack locally on the official emulators at zero cost.

Reading order for a fresh session: this file, then the CONTRACT.md of the box being changed.
