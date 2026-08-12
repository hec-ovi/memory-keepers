# memory-keepers

![Memory Keepers: an island of keepers that remember and dream](docs/banner.jpg)

A 3D game where keepers (small blob librarians) manage your memories. Each keeper owns a topic (dreams, meetings, music, anything you create), lives in a cottage on a floating island, and keeps a library of books. Tell her something and she writes a book; ask her and she reads her shelves back to you, always grounded in real books. Hold T in any dialog to talk instead of typing, and she answers in her own voice. At night the island dreams: everything that connects across shelves becomes a knowledge graph, and dark keepers are born from what keeps returning.

Built for the All Things Agentic Hackathon (The Collaborative Partner track).

Interactive architecture map: [hec-ovi.github.io/memory-keepers](https://hec-ovi.github.io/memory-keepers/)

## Why

Most AI still lives in chatbots: a text box that waits. The question behind this project is how interacting with an AI can feel natural, carry real meaning, and cover the whole spectrum of what you do, instead of solving one narrow problem. We are, in the end, a collection of memories and the events that happened to us, so the app points at life and memory itself.

Each layer of your life gets its own keeper: the music you hear, the movies you watch, the dreams that stay with you, your diet, your workouts, your meetings. Keepers capture who you are in those moments and hand back the details you lose ("that movie three weeks ago, the guy on an airplane?", "what was the urgent thing John asked me for?"). At night the island consolidates the day the way humans do, by dreaming: a knowledge graph connects the layers holistically and surfaces what keeps returning, including what you avoid.

Privacy first: the same code runs against Gemini on Vertex AI or entirely on your own hardware with Gemma open weights, so your memories, conversations, and the graph itself never have to leave your machine.

## Stack

- Gemini on Vertex AI: keeper replies, synthesis, dream prose
- Google ADK + GenAI SDK: monument root agent, one agent per keeper (call-and-return tools), dream agents
- Cloud Run: one service, engine plus frontend
- Firestore: worlds, keepers, books, sessions, dream runs
- Pub/Sub + Cloud Scheduler: the nightly dream sweep
- Cloud Text-to-Speech and Speech-to-Text: keeper voices and the talk key
- Gemma on llama.cpp: the local model tier
- Keeper tools: YouTube and podcast transcripts, song facts (MusicBrainz) and lyrics (LRCLIB), book facts and public-domain texts (Gutendex), movie facts and plots (OMDb, Wikidata, Wikipedia)
- three.js frontend (no build step), FastAPI engine, Docker

## Run locally (zero cloud cost)

```
docker compose up
```

The game is at http://localhost:8000, running against the official Firestore emulator (browse it at http://localhost:4000). Emulator data survives restarts in a compose volume; `docker compose down -v` starts clean. Three brains, one switch, nothing else changes:

| MODEL_TIER | brain | needs |
|---|---|---|
| `fake` (default) | deterministic in-process model | nothing |
| `local` | Gemma on a llama.cpp server on the host | a machine that fits it |
| `agy` | any MCP-capable CLI you already have | `docker compose --profile agy up`, then point the CLI at `agy/src/mk_agy/mcp_server.py` and tell it to serve the island |

Nothing installs on the machine; everything lives in the containers.

To fill a world with sample memories and test the whole loop (tells, grounded asks, a dream with its knowledge graph):

```
python3 scripts/demo_world.py http://localhost:8000 demo --verify
```

## Tests

```
docker compose run --rm test            # python boxes (79 tests)
docker compose run --rm test-frontend   # frontend (707 tests)
```

Real FastAPI app, real ADK runner and tools, fake Firestore client (same suites pass against the emulator when `FIRESTORE_EMULATOR_HOST` is set); frontend on vitest + jsdom + Testing Library + MSW.

## Deploy

```
export INTERNAL_TOKEN=<random secret>
export ACCESS_CODE=<island key>       # optional: gates the API behind X-Access-Code
export OMDB_KEY=<omdb key>            # optional: movie facts with IMDb ratings
scripts/deploy.sh
```

Creates everything on an existing Google Cloud project: enables the APIs, then Cloud Run service (engine + frontend), Firestore, the `dream-runs` Pub/Sub topic with its push subscription, and the nightly Cloud Scheduler sweep. Starting from nothing:

```
gcloud projects create <project-id>
gcloud billing projects link <project-id> --billing-account=<account-id>
PROJECT=<project-id> scripts/deploy.sh
```

With `ACCESS_CODE` set, visitors enter the key once (or open a `?key=` link); anonymous traffic never reaches a model. `scripts/deploy_billing_cap.sh` adds a hard spend stop: a budget event detaches billing at the line.

## Layout

Box map and dependency edges: `docs/INDEX.md`. Each box is one folder with a CONTRACT.md; the contract alone is enough to use the box.

| box | what |
|---|---|
| `frontend/` | three.js SPA, no build step |
| `engine/` | FastAPI surface, world scoping, meters, jobs |
| `agents/` | ADK: monument root agent, keeper agents, dream prose |
| `library/` | Firestore store: worlds, keepers, books, sessions, dream runs |
| `models/` | model gateway: cloud / local / agy / fake tiers |
| `dreaming/` | consolidation: linking pass and dark side writer |
| `voice/` | Cloud TTS / STT router |
| `lookups/` | keeper tools: transcripts, lyrics, movie facts |
| `agy/` | the agy tier: job broker + MCP toolkit |
