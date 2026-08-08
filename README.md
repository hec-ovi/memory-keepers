# memory-keepers

A 3D game where keepers (small blob librarians) manage your memories. Each keeper owns a topic (dreams, meetings, music, anything you create), lives in a cottage on a floating island, and keeps a library of books. Tell her something and she writes a book; ask her and she reads her shelves back to you, always grounded in real books. At night the island dreams: everything that connects across shelves becomes a knowledge graph, and dark keepers are born from what keeps returning.

Built for the All Things Agentic Hackathon (The Collaborative Partner track).

Stack: Gemini on Vertex AI, Google ADK agents, Cloud Run, Firestore, Pub/Sub, Cloud Text-to-Speech and Speech-to-Text, with a local Gemma tier.

## Run locally (zero cloud cost)

```
docker compose up
```

Engine on http://localhost:8000 against the official Firestore and Pub/Sub emulators, model tier `fake` (deterministic). `MODEL_TIER=local docker compose up` points the model at a llama.cpp server on the host (Gemma). Nothing installs on the machine; everything lives in the containers.

## Tests

```
docker compose run --rm test
```

Every box's contract suite in one pass: real FastAPI app, real ADK runner and tools, fake Firestore client (same suites pass against the emulator when `FIRESTORE_EMULATOR_HOST` is set).

## Deploy

```
export INTERNAL_TOKEN=<random secret>
scripts/deploy.sh
```

Creates everything: Cloud Run service (engine + frontend), Firestore, the `dream-runs` Pub/Sub topic with its push subscription, and the nightly Cloud Scheduler sweep.

## Layout

Box map and dependency edges: `docs/INDEX.md`. Each box is one folder with a CONTRACT.md; the contract alone is enough to use the box.

| box | what |
|---|---|
| `frontend/` | three.js SPA, no build step |
| `engine/` | FastAPI surface, world scoping, meters, jobs |
| `agents/` | ADK: monument root agent, keeper agents, dream prose |
| `library/` | Firestore store: worlds, keepers, books, sessions, dream runs |
| `models/` | model gateway: cloud / local / fake tiers |
| `dreaming/` | consolidation: linking pass and dark side writer |
| `voice/` | Cloud TTS / STT router |
