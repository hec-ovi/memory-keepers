# library

Purpose: the only store. One SQLite file holds every world, keeper, book, session and dream run; nothing else persists anything.

## Data model (documents)

```
worlds/{world_id}                     meta: created_at, seeded, dream_counter, latest_run_id
  keepers/{keeper_id}                 profile: name, topic, side, archetype, persona,
                                      palette, created_at, book_count, session meter,
                                      chatter lines (from her books, set by dreaming)
    books/{slug}                      title, date, tags, entities, source, one_liner,
                                      links, tier, body_md
    session/current                   summary blocks (constraints, recent topics)
                                      + capped turn log
  dreams/{run_id}                     status, narrative, graph, created keepers/books
```

- `side`: `light` (user-created) or `dark` (dreaming-created only).
- `archetype` (dark only): `desire | fear | ambition | obsession`.
- `source` of a book: `told | dream | seed | sleep | notes` (one `notes` book per keeper, slug `notes`: passing remarks as dated entries, its `links` the slugs they are about; never bound away by `make_room`).
- `tier` by body length: `small | medium | big | large` (the 3D spine size).
- slug: `YYYY-MM-DD-<kebab-title>`, deduped with `-2`, `-3`.

## Public API (Python class `Library`)

Class `Library(db=None, seed=None)`: `db` is the SQLite file path (default env `LIBRARY_DB`, else `.data/memory-keepers.db`; parent folders are created; `":memory:"` for tests), `seed` is a callable `(library, world_id)` applied on first world touch (the engine passes `mk_library.seed.apply`).

| method | in | out |
|---|---|---|
| `ensure_world(world_id)` | id from the engine | world meta; seeds demo content on first touch |
| `world_meta / list_worlds / delete_world` | | meta dict / world ids (the nightly dream sweep) / removes a world and all it holds |
| `create_keeper / get_keeper / list_keepers / update_keeper / delete_keeper` | profile fields | `Keeper` record; `payload(budget)` is the API shape (`budget=None` omits the session block, for report contexts) |
| `write_book / get_book / list_books / delete_book` | book fields; `enforce_cap=False` only for sleep and dreaming digest writes | `Book` record, newest first listing |
| `append_to_book(world, keeper, slug, note_md, date)` | a dated follow-up section | the grown `Book`: body extended, tier re-derived, count unchanged |
| `append_note(world, keeper, note_md, date, tags?, about?)` | a passing remark, the slugs it is about | the keeper's notes book, born on the first entry (counts once, `LIBRARY_FULL` when no slot is left), entry appended under its date, tags and links merged, date set to the entry's |
| `index_rows(world, keeper)` | | compact rows (slug, title, date, tags, entities, one_liner, tier) for prompts |
| `session_read / session_append / session_replace` | `Turn` list (`t, role, text, book?`: a user turn names the slug its tell wrote or grew) + verbatim constraints / full `Session` | `Session` record |
| `meter_add / meter_reset` | token counts | running total (meter lives on the keeper doc) |
| `make_room(world, keeper, incoming)` | slots needed | `(digests_written, fits)`: binds the two oldest `told`/`sleep` books into one digest per merge until `incoming` fit plus one spare; nothing a merged book held is lost |
| `dream_start / dream_update / dream_get / dream_latest / list_dreams` | run fields; `dream_start(world, reason, status="running")` can pre-queue with `status="queued"` | `DreamRun` record; `list_dreams` all runs oldest first |
| `export_world(world)` | | the whole world as one portable dict: `{format, version, exported_at, meta, keepers: [{...keeper, books, session}], dreams}` |
| `import_world(world, data)` | an export dict; target world must not exist | `{keepers, books}` written; caps enforced, records re-parsed, sleep jobs cleared |

## Errors (closed set)

`WORLD_NOT_FOUND`, `KEEPER_NOT_FOUND`, `KEEPER_EXISTS`, `KEEPERS_FULL`,
`BOOK_NOT_FOUND`, `LIBRARY_FULL`, `DREAM_NOT_FOUND`, `IMPORT_INVALID`.

## Invariants

- Caps: 16 light keepers, 8 dark keepers, 24 books per library (one bookcase). Defined once here, imported everywhere.
- Every read and write is scoped to one world; no cross-world query exists.
- By convention of the callers, dark keepers and `dream` books come only from the dreaming box; the library itself does not enforce it.
- Level is derived, never stored: `1 + isqrt(book_count)`.
- Storage is `docstore.DocStore`: documents as JSON rows keyed by their slash path (`worlds/{id}/keepers/{id}/books/{slug}`), listed by parent collection in id order, merge writes update top-level fields. One connection behind a lock (WAL on files), so tool calls from worker threads are safe. Tests run the same code on `":memory:"`.
