# Changelog

0.4: voice end to end: hold T push to talk in every dialog (Cloud STT, latest_short model) and spoken replies per keeper kind (Cloud TTS); dream runs carry a run_id from POST /dream so the graph movie plays when consolidation lands; internal routes require the deploy token; hosted on Cloud Run (Vertex Gemini on the global endpoint) behind the island key gate (ACCESS_CODE), with a hard billing cap (budget -> Pub/Sub -> detach function) and free-tier scale-to-zero deploys. 53 backend + 723 frontend tests.

0.3: the full game frontend: overworld island with day and night districts, walking keepers with chatter, interiors with the 24-slot bookcase and reader, holo UI kit with voice states, cinematic join, dream graph movie, minimap, onboarding. 708 frontend tests; the engine serves it at /.

0.2: full backend: library (Firestore), models (cloud/local/fake tiers), agents (monument, keepers, dream prose on ADK), dreaming (linking + dark side), voice (TTS/STT), engine (REST surface, sleep, meters, Pub/Sub dreaming). Docker-only dev with official emulators; 49 contract tests; Cloud Run deploy script.

0.1: architecture: seven box contracts and the box map.
