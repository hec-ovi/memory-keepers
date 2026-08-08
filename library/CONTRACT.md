# library

Purpose: the only store. Firestore holds every world, keeper, book, session and dream run; nothing else persists anything.

## Data model (Firestore)

```
worlds/{world_id}                     meta: created_at, seeded
  keepers/{keeper_id}                 profile: name, topic, side, archetype, persona,
                                      palette, created_at, book_count, session meter
    books/{slug}                      title, date, tags, entities, source, one_liner,
                                      links, tier, body_md
    session/current                   summary blocks (standing facts, constraints,
                                      open threads, recent topics) + capped turn log
  dreams/{run_id}                     status, narrative, graph, created keepers/books
```

- `side`: `light` (user-created) or `dark` (dreaming-created only).
- `archetype` (dark only): `desire | fear | ambition | obsession`.
- `source` of a book: `told | dream | seed | sleep`.
- `tier` by body length: `small | medium | big | large` (the 3D spine size).
- slug: `YYYY-MM-DD-<kebab-title>`, deduped with `-2`, `-3`.

## Public API (Python class `Library`)

| method | in | out |
|---|---|---|
| `ensure_world(world_id)` | id from the engine | world meta; seeds demo content on first touch |
| `create_keeper / get / list / delete` | profile fields | keeper doc; errors below |
| `write_book / get_book / list_books / delete_book` | keeper, book fields | book doc, newest first listing |
| `index_rows(keeper)` | | compact rows (slug, title, date, tags, entities, one_liner) for prompts |
| `session_read / session_append / session_replace` | turns or full blocks | session doc |
| `meter_add / meter_reset` | token counts | session meter `{tokens_used, budget, status}` |
| `dream_start / dream_update / dream_get / dream_latest` | run fields | dream run doc |

## Errors (closed set)

`WORLD_NOT_FOUND`, `KEEPER_NOT_FOUND`, `KEEPER_EXISTS`, `KEEPERS_FULL`,
`BOOK_NOT_FOUND`, `LIBRARY_FULL`, `DREAM_NOT_FOUND`.

## Invariants

- Caps: 16 light keepers, 8 dark keepers, 24 books per library (one bookcase). Defined once here, imported everywhere.
- Every read and write is scoped to one world; no cross-world query exists.
- Dark keepers and `dream` books are written only by the dreaming box.
- Level is derived, never stored: `1 + isqrt(book_count)`.
- Dev and tests run against the Firestore emulator (`FIRESTORE_EMULATOR_HOST`); the code path is identical to production.
