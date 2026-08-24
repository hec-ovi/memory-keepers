# Box map

Each box is one folder with a CONTRACT.md; outsiders use the contract, never the code.

| box | purpose | depends on |
|---|---|---|
| frontend | three.js SPA: island, keepers, houses, libraries, holo UI, dream movie | engine |
| engine | FastAPI app: REST surface, world scoping, meters and caps, serves the frontend | agents, library, models, voice, lookups |
| agents | ADK agents: the monument (root), one agent per keeper (tell, ask, talk, notes), the ridge keepers (cross-shelf, therapeutic), dream agents (theme selection, prose, narrative) | library, models, lookups |
| library | Firestore store: worlds, keepers, books, sessions, dream runs | - |
| models | model gateway: Gemini on Vertex AI, local Gemma tier, fake tier | - |
| dreaming | consolidation job: Pub/Sub triggered, builds the knowledge graph and the dark keepers | agents, library |
| voice | speech: Cloud Text-to-Speech and Speech-to-Text routers | - |
| lookups | external lookups for keepers: transcripts (YouTube, podcasts), song and book facts, lyrics, movie plots | - |

Deployment: one Cloud Run service (engine + frontend statics). Dreaming rides Pub/Sub: Cloud Scheduler hits `/internal/nightly`, tired keepers publish events, and a push subscription delivers both into `/internal/dream-run`. Firestore is the only store. `gcloud` (Cloud Shell or local) in `docs/cloud-shell.md` creates all of it; `docker-compose.yml` runs the same stack locally on the official Firestore emulator at zero cost (dream dispatch runs inline there; emulator data persists in `./.data/firestore` on the host, snapshotted every minute).

Reading order for a fresh session: this file, then the CONTRACT.md of the box being changed.

Google Cloud architecture (product icons, print to PDF): `docs/diagrams/google-stack.html`. Console click-through: `docs/console-dive.html`.
