# memory-keepers

![Memory Keepers: an island of keepers that remember and dream](docs/banner.jpg)

A 3D game where keepers (small blob librarians) guard your memories. Each keeper owns one layer of your life (dreams, meetings, music, anything you create), lives in a cottage on a floating island, and writes a library of books from what you tell her. Ask her and she answers only from her shelves, grounded in real books. Hold T in any dialog to talk instead of typing, and she answers in her own voice. At night the island dreams: everything that connects across shelves becomes a knowledge graph, and dark keepers are born from what keeps returning.

Built for the All Things Agentic Hackathon, track The Collaborative Partner.

- Demo video, 3 minutes: [youtu.be/2m9c1UvCAdA](https://youtu.be/2m9c1UvCAdA)
- Full Google Cloud setup, click by click: [youtu.be/-5D4t0W_PBM](https://youtu.be/-5D4t0W_PBM)
- Live island: [memory-keepers on Cloud Run](https://memory-keepers-1079248358049.europe-west1.run.app) (island key in the Devpost testing credentials)
- Interactive architecture map: [hec-ovi.github.io/memory-keepers](https://hec-ovi.github.io/memory-keepers/)
- Google Cloud diagram, official product icons: [docs/diagrams/google-stack.html](docs/diagrams/google-stack.html) ([PDF](docs/diagrams/google-stack.pdf))
- Console click-through, empty project to live island: [docs/console-dive.html](docs/console-dive.html)

## Why

Most AI interaction is a text box that waits. The question behind this project is how an AI can feel natural to live with, carry real meaning, and cover the whole spectrum of what you do instead of one narrow task. We are, in the end, a collection of memories and the events that happened to us, so the app points at life and memory itself.

Each layer of your life gets its own keeper: the music you hear, the movies you watch, the dreams that stay with you, your diet, your workouts, your meetings. Keepers capture who you are in those moments and hand back the details you lose ("that movie three weeks ago, the guy on an airplane?", "what was the urgent thing John asked me for?"). At night the island consolidates the day the way humans do, by dreaming: a knowledge graph connects the layers and surfaces what keeps returning, including what you avoid.

Privacy first: the same code runs against Gemini on Vertex AI or entirely on your own hardware with Gemma open weights, so your memories, conversations, and the graph itself never have to leave your machine.

## Run locally (zero cloud cost)

```
docker compose up
```

The game is at http://localhost:8000, running against the official Firestore emulator (browse it at http://localhost:4000). Your worlds live in `./.data/firestore` on the host, snapshotted every minute, so they survive restarts, rebuilds, and docker cleanups; delete that folder to start clean. One switch picks the brain, nothing else changes:

| MODEL_TIER | brain | needs |
|---|---|---|
| `fake` (default) | deterministic in-process model | nothing |
| `local` | Gemma on a llama.cpp server on the host | a machine that fits it |

Nothing installs on the machine; everything lives in the containers.

The local tier needs a llama.cpp server on the host (any OpenAI-compatible server works). With a Gemma GGUF:

```
llama-server --model <path to gemma .gguf> --alias gemma-4-26b-a4b-qat-q4 \
  --host 0.0.0.0 --port 8080 --jinja -ngl 99
MODEL_TIER=local docker compose up -d
```

Defaults line up: the island looks for `http://host.docker.internal:8080/v1` and asks for the model id `gemma-4-26b-a4b-qat-q4`; override with `LOCAL_MODEL_URL` and `LOCAL_MODEL_ID` if your server differs. The engine's health check probes the model server, and the game refuses to open while it is down, so a dead brain shows up at the door instead of as strange answers.

To fill a world with sample memories and verify the whole loop (tells, grounded asks, a dream with its knowledge graph):

```
python3 scripts/demo_world.py http://localhost:8000 demo --verify
```

## Sample island

`samples/hector-island.json` is a whole island exported from this game: the author's own memories, told to five keepers through the real tell flow on the local tier (career, studies, repos, literature with two books told chapter by chapter, and Cronenberg films), loose remarks on every shelf, the ridge dreamed from what recurs across them, and the conversations behind every book. Load it with the HUD's Import island button (it lands on a fresh island id of its own, never on yours), then ask a keeper something, open a book, send her a remark, talk to the ridge, or run Dreaming.

To build an island from your own memories, write them as the seeder's JSON (keepers with `memories`, optional `remarks` sent through the router, and an `ask` to verify) and run:

```
python3 scripts/demo_world.py http://localhost:8000 mine --verify --memories my_memories.json
```

Export island then saves it back as one file.

## Stack

Google products, official names:

- Gemini 3.5 Flash on Vertex AI (global endpoint): keeper replies, synthesis, dream prose
- Agent Development Kit (Python) and Google GenAI SDK: monument root, one AgentTool per keeper (call-and-return), ridge keepers, dream agents
- Cloud Run: one service, engine plus the three.js island
- Firestore: the only store (worlds, keepers, books, sessions, dream runs)
- Pub/Sub and Cloud Scheduler: nightly dream sweep and tired-keeper events
- Cloud Text-to-Speech and Cloud Speech-to-Text: keeper voice and hold T
- Gemma open weights: local tier, same code, `MODEL_TIER=local`
- Cloud Build, Artifact Registry, Cloud Logging, Cloud Billing: deploy, image, logs, spend cap

Keeper lookup tools (not Google): YouTube and podcast transcripts, song facts (MusicBrainz) and lyrics (LRCLIB), book facts (Gutendex), movie facts and plots (OMDb, Wikidata, Wikipedia). `resolve_date` turns "tomorrow" or "in two weeks" into the calendar date before anything is written.

three.js frontend (no build step), FastAPI engine, Docker.

## Architecture

The project is a set of isolated boxes, each one folder with a `CONTRACT.md`; the contract alone is enough to use the box. Box map and dependency edges: [docs/INDEX.md](docs/INDEX.md).

| box | what |
|---|---|
| `frontend/` | three.js SPA, no build step |
| `engine/` | FastAPI surface, world scoping, meters, jobs |
| `agents/` | ADK: monument root agent, keeper agents (tell, ask, talk, notes), ridge keepers, dream agents |
| `library/` | Firestore store: worlds, keepers, books, sessions, dream runs |
| `models/` | model gateway: cloud / local / fake tiers |
| `dreaming/` | consolidation: linking pass and dark side writer |
| `voice/` | Cloud TTS / STT router |
| `lookups/` | keeper tools: transcripts, lyrics, movie facts |
| `samples/` | a whole island to import: the author's memories |

The decisions that shape it:

- **Keepers are AgentTool, not agent transfer.** Transfer moves control into one keeper and keeps it there. Call-and-return lets the monument fan one question out across every shelf and synthesize one answer; the root itself holds no corpus.
- **One switch picks the model.** The `models` gateway is the only place a provider exists: Gemini on Vertex, Gemma on llama.cpp, or a deterministic fake for tests. Engine, agents, and dreaming never learn which tier runs.
- **Firestore owns everything durable**: worlds, keepers, books, sessions, dream runs. Locally the official emulator runs the identical code path.
- **Dreaming is infrastructure, not a thread.** Cloud Scheduler posts nightly, tired keepers publish events, and a Pub/Sub push subscription delivers both into the consolidation run. A deterministic linking pass builds the graph with zero model calls; the model only sorts human patterns from technical noise and writes the prose.
- **Runs are bounded and failure-tolerant.** One run is at most 12 model calls, stops on a repeated tool call, and every flow carries a deterministic fallback, so a bad model answer never breaks the game.
- **Guarded by default.** An island key gates the API, internal routes need a deploy token, and a budget event can detach billing at a hard line.

## Deploy to Google Cloud

Three ways, same result. Every step is also a Console click.

**Let an agent do it.** [`AGENTS.md`](AGENTS.md) tells any shell-capable agent what to check (gcloud, git, login, billing), what to write (`.env`), what to run, and how to validate the result. With [Gemini CLI](https://github.com/google-gemini/gemini-cli) (`GEMINI.md` points it there):

```
npm install -g @google/gemini-cli
git clone https://github.com/hec-ovi/memory-keepers && cd memory-keepers
gemini
> Deploy this repo to Google Cloud following AGENTS.md. Ask me for anything only I can do.
```

**Run the script yourself.** With `gcloud` logged in, a project with billing linked, and `INTERNAL_TOKEN` in `.env`:

```
./deploy.sh PROJECT_ID
```

**Click through the Console.** Every click is on video: [youtu.be/-5D4t0W_PBM](https://youtu.be/-5D4t0W_PBM) (7 minutes, empty project to live island). The written walkthrough is [docs/cloud-shell.md](docs/cloud-shell.md) (the Cloud Shell button below opens it as a tutorial) and [docs/console-dive.html](docs/console-dive.html) shows every click with screenshots:

[![Open in Cloud Shell](https://gstatic.com/cloudssh/images/open-btn.png)](https://ssh.cloud.google.com/cloudshell/open?cloudshell_git_repo=https://github.com/hec-ovi/memory-keepers&cloudshell_tutorial=docs/cloud-shell.md)

1. Create a project and link billing.
2. Enable Cloud Run, Firestore, Pub/Sub, Agent Platform API (the former Vertex AI API), Cloud Text-to-Speech, Cloud Speech-to-Text, Cloud Scheduler, Cloud Build, Artifact Registry.
3. Grant the default Compute Engine service account Cloud Run Builder, Cloud Build Builder, and Storage Object Viewer, plus Storage Object Admin on the `run-sources-PROJECT-REGION` bucket (new projects do not give Cloud Build those rights).
4. Create a Firestore Native database.
5. `gcloud run deploy memory-keepers --source .`, allow unauthenticated, one warm instance. Env: `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION=global`, `GOOGLE_GENAI_USE_VERTEXAI=TRUE`, `MODEL_TIER=cloud`, `DREAM_DISPATCH=pubsub`, `DREAM_TOPIC=dream-runs`, `INTERNAL_TOKEN` (required). Optional: `ACCESS_CODE` (island key gate), `OMDB_KEY`.
6. Pub/Sub topic `dream-runs` with a push subscription to `/internal/dream-run?token=...`, and Cloud Scheduler job `nightly-dream` (`0 3 * * *`) posting `/internal/nightly?token=...`.

Open the URL `gcloud` prints; with an island key, add `/?key=` to it. Inside a company organization with hardened defaults, also grant the service account `roles/datastore.user` and `roles/aiplatform.user`. `scripts/deploy_billing_cap.sh` adds the hard spend stop: a budget event detaches billing at the line.

## Hackathon requirements

All Things Agentic, track The Collaborative Partner. How the project meets the published rules:

- **Gemini 3.5 or newer:** Gemini 3.5 Flash through Vertex AI on the global endpoint, serving every reply on the hosted island.
- **Google Agent Framework:** ADK plus GenAI SDK, one required and both present. The monument, every keeper, the ridge, and the dream writers are ADK agents.
- **Google Cloud infrastructure:** Cloud Run, Firestore, and Pub/Sub, one required and three in production, with Scheduler, both speech APIs, and Cloud Build on top.
- **The track's twist, synthesize rather than read:** keepers turn messy streams (transcripts, lyrics, film plots, spoken words) into authored books, and dreaming mutates the whole library into a knowledge graph and dark keepers.
- **Asks, takes notes, adapts:** grounded answers end with a follow-up question, passing remarks land in each keeper's notes book, and ridge keepers reflect and ask one real question back.
- **Innovation (40%):** books instead of chat logs, grounded ask, nightly consolidation, dark keepers born from what returns.
- **Architecture (30%):** contract boxes, AgentTool over transfer, one-switch model gateway, Pub/Sub dreaming, bounded runs with deterministic fallbacks, island key and deploy token, billing kill switch.
- **Demo (30%):** hosted Cloud Run URL, the 3 minute demo video, a 7 minute Console walkthrough, reproducible spin-up above, architecture diagram, 802 contract tests on the real app.
- **Bonus models:** Gemma (the local tier), Cloud Text-to-Speech, Cloud Speech-to-Text. Gemini is the required model, not a bonus.

## Tests

```
docker compose run --rm test            # python boxes (97 tests)
docker compose run --rm test-frontend   # frontend (705 tests)
```

Real FastAPI app, real ADK runner and tools, fake Firestore client (the same suites pass against the emulator when `FIRESTORE_EMULATOR_HOST` is set); frontend on vitest + jsdom + Testing Library + MSW.

## Content and sources

Keepers read sources at capture time and store only what they write: a book holds facts, short quotes, and the user's relationship with the work, never a copy of it. Fetched text (a transcript, lyrics, a plot) lives only in the model's context while the book is written. Sources are chosen by license: MusicBrainz facts (CC0), Wikipedia plots (CC BY-SA, cited in the book), Project Gutenberg full texts only when a book is public domain, and podcast transcripts only when the publisher ships one in the feed.
