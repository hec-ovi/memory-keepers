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

Deployment: one Cloud Run service (engine + frontend statics), one Cloud Run Job (dreaming) fed by Pub/Sub (nightly schedule plus tired-keeper events), Firestore as the only store.

Reading order for a fresh session: this file, then the CONTRACT.md of the box being changed.
