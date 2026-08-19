# Changelog

0.8: conversations persist in the keeper's session and replay when her panel opens (GET /keepers/{id}/chat); turns carry the full message, so sleep books hand real conversation to dreaming. Boot gates on the model: /health probes the endpoint and the game refuses while it is down. Books stand alone (the tell prompt bars conversation narration and shelf talk). Dialog: full-height resizable panel, alternating bubbles, the composer locks while she needs to dream, and a late reply never lands in another keeper's panel. Counts read against their caps everywhere (HUD n/16, village and ridge headers, shelves n/24); the keepers list scrolls and stops above the minimap. The plaza hologram is the camera-facing Memory Keeper; the reader pins its title and chips over a scrolling page. 79 backend + 693 frontend tests.

0.7: the session budget defaults to 32000 tokens. Fresh worlds seed three keepers with one real memory each: a dream (the deer in the forest), a book (Hypostasis Simulacri, full text) and a song (Wish You Were Here as facts; lyrics fetch on demand). The say router decides by intended outcome (a new book vs an answer), and ask replies synthesize from opened books instead of retelling them. Local emulator data lives in ./.data/firestore on the host, snapshotted every minute, so it survives docker volume cleanup and hard kills.

0.6.1: model tiers are cloud (Vertex Gemini), local (Gemma on llama.cpp), fake; the frontend suite proves the whole module graph resolves, so the three.js scenes load in every browser. 74 backend + 708 frontend tests.

0.6: worlds travel: Export island saves the whole world (keepers, books, sessions, dream runs) as one JSON file; Import island lands it on a fresh crypto world id, cloud to local and back. Emulator data survives restarts in a compose volume. A lean pass across every box: shared helpers, tighter contracts, the ask prompt names all seven lookup tools. 79 backend + 707 frontend tests.

0.5: keepers author their books: each told memory becomes a full markdown work (short scroll to multi-page volume, sized by the material; spine tiers follow). Keepers list gains a live search filter; ?world= opens a named world and ?key= carries the island key in a shared link. Demo world seeder + verify generator (scripts/demo_world.py) with public-domain memories across ten keepers. 53 backend + 726 frontend tests.

0.4: voice end to end: hold T push to talk in every dialog (Cloud STT, latest_short model) and spoken replies per keeper kind (Cloud TTS); dream runs carry a run_id from POST /dream so the graph movie plays when consolidation lands; internal routes require the deploy token; hosted on Cloud Run (Vertex Gemini on the global endpoint) behind the island key gate (ACCESS_CODE), with a hard billing cap (budget -> Pub/Sub -> detach function) and free-tier scale-to-zero deploys. 53 backend + 723 frontend tests.

0.3: the full game frontend: overworld island with day and night districts, walking keepers with chatter, interiors with the 24-slot bookcase and reader, holo UI kit with voice states, cinematic join, dream graph movie, minimap, onboarding. 708 frontend tests; the engine serves it at /.

0.2: full backend: library (Firestore), models (cloud/local/fake tiers), agents (monument, keepers, dream prose on ADK), dreaming (linking + dark side), voice (TTS/STT), engine (REST surface, sleep, meters, Pub/Sub dreaming). Docker-only dev with official emulators; 49 contract tests; Cloud Run deploy script.

0.1: architecture: seven box contracts and the box map.
