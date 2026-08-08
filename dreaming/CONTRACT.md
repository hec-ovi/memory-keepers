# dreaming

Purpose: the consolidation run. Reads every light library in a world, finds what connects, writes the dark side: dark keepers, their dream books, the knowledge graph and a short narrative.

## Trigger

Pub/Sub topic `dream-runs`, message `{world_id, reason}`. Two producers, both autonomous:

- nightly: Cloud Scheduler publishes the sweep
- tired keeper: the engine publishes when a keeper crosses `needs_sleep`

Delivery is a Pub/Sub push subscription to the engine's `/internal/dream-run` route, which calls `run_dream` in-request (CPU stays allocated). Dev and tests call `run_dream` directly, same function, no Pub/Sub needed.

## Public API

`async run_dream(library, agents_api, world_id, reason) -> dream run doc` (status `done` or `failed`, never hangs; failures are recorded on the run).

## Run (one world)

1. Deterministic linking (`linking.py`, zero model calls): entity/tag co-occurrence across light books; elements cited by 2+ books become graph nodes; elements spanning 2+ keepers become themes, ranked by citation count. Archetype per theme by keyword lexicon (`desire | fear | ambition | obsession`).
2. Per theme: `agents.dream_write` prose; the dark keeper is created on first need (theme key is her topic) and her dream book lands citing `keeper/slug` evidence links, with `derived_from` edges in the graph.
3. `agents.dream_narrative` closes the run; the frontend plays the graph back as the dream movie.

## Invariants

- Caps: never a 9th dark keeper, never an over-full bookcase (`library.make_room` digests old books first); blocked themes land in `skipped_themes`.
- Idempotent on unchanged sources: a theme whose evidence is already linked by an existing dream book writes nothing; deleting a dark book or keeper lets the next run recreate it while its sources still support the theme.
- The deterministic layer alone produces a complete run; the model only adds prose.

## How to test

`docker compose run --rm test /opt/venv/bin/pytest dreaming -q`
