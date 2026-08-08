# Box map

Planned layout; each box gets its own folder with CONTRACT.md as code lands.

| box | purpose | depends on |
|---|---|---|
| frontend | three.js SPA: island, keepers, houses, libraries, holo UI (presentation only) | engine contract |
| engine | FastAPI app: world state, keeper lifecycle, chat routing, serves the frontend | harness, library |
| harness | the only LLM gateway: ADK + Vertex AI (Gemini), plus an offline simulated provider for dev and tests | - |
| library | per-keeper book store (markdown corpus with metadata) on Firestore | - |
| dreaming | consolidation job: Pub/Sub triggers a Cloud Run Job, fans out over keepers, writes the unconscious side and the connection graph | harness, library |
| voice | speech in and out: Cloud Text-to-Speech and Speech-to-Text | engine contract |

Deployment shape: one Cloud Run container serves frontend plus engine; dreaming runs as a separate Cloud Run Job; Firestore holds the libraries.
