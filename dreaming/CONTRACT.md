# dreaming

Purpose: the consolidation job. Reads every library in a world, finds what connects, writes the dark side: dark keepers, their books, the knowledge graph and a short narrative.

## Trigger

Pub/Sub topic `dream-runs`, message `{world_id, reason}`. Two producers, both autonomous:

- nightly: Cloud Scheduler publishes one message per world active in the last 7 days
- tired keeper: the engine publishes when a keeper crosses `needs_sleep`

The subscriber is a Cloud Run Job. Dev mode runs the same function inline as a background task, no Pub/Sub needed.

## Run (one world)

1. Deterministic linking: scan all light books, build entity/tag co-occurrence; elements shared by 2+ books become graph nodes and edges.
2. `agents.dream_pass` per keeper (parallel fan-out), then `agents.dream_synthesis` over all passes.
3. Themes map to archetypes (`desire | fear | ambition | obsession`); each strong theme births or feeds a dark keeper and writes one `dream` book citing its source slugs.
4. Persist the run: graph, narrative, created keepers and books, skipped themes. The frontend plays the graph back as the dream movie.

## Public API

| method | in | out |
|---|---|---|
| `run_dream(world_id, reason)` | | dream run doc (status `done` or `failed`, never hangs) |

## Errors (closed set)

`DREAM_RUNNING` (one run per world at a time).

## Invariants

- Caps respected: never a 9th dark keeper (theme skipped and listed), never a 25th book (oldest mergeable books digest down first; nothing mergeable means the theme book is skipped).
- Every dark book cites real source slugs; deleting a dark keeper or book is allowed and the next run may recreate it while its sources still support the theme.
- The deterministic linking layer works with zero model calls; the model only writes prose on top. A model failure still produces a complete run.
