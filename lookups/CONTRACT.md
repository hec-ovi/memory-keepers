# lookups

Purpose: external lookups the keeper agents may call while writing or answering: a YouTube transcript, a song's lyrics, a movie's facts.

## Public API

Class `LookupsApi(client=None, transcript_fetch=None, env=None)`. `client` is an `httpx.Client` (injectable for tests; the default carries the project User-Agent and an 8 s timeout), `transcript_fetch` overrides the YouTube fetcher, `env` defaults to `os.environ`.

| method | in | out |
|---|---|---|
| `youtube_transcript(url_or_id)` | watch/short/embed URL or bare 11-char id | `{ok, video_id, text, truncated}`; text capped at 12,000 chars |
| `song_lyrics(title, artist="")` | title, optional artist | `{ok, source, title, artist, lyrics}`; lyrics capped at 8,000 chars |
| `movie_facts(title, year="")` | title, optional year | `{ok, source, title, year, director, cast, plot, imdb_rating}` |

Failures return `{ok: False, reason}` with a closed reason set: `not_a_youtube_url`, `no_transcript`, `no_title`, `not_found`, `unavailable`. No method ever raises; a dead lookup can never break a keeper flow.

## Sources (researched 2026-08-11, `.research/lookup-apis`)

- Transcript: `youtube-transcript-api` (keyless). YouTube blocks cloud-provider IP ranges, so this succeeds from residential IPs (local tier, demos) and usually degrades to `{ok: False}` on Cloud Run; that degradation is expected and non-fatal.
- Lyrics: LRCLIB search (keyless, full lyrics), lyrics.ovh fallback (needs artist). The client's distinctive User-Agent matters: LRCLIB drops disfavored UAs silently.
- Movies: OMDb when env `OMDB_KEY` is set (free key, 1,000/day, IMDb rating), keyless Wikidata otherwise (no rating, plot = description). TMDB is deliberately not used: its API terms prohibit use in connection with LLMs.

## Invariants

- Outbound HTTP only; no store, no model, no other box.
- Every response is a plain dict sized for a model tool result (text caps above).
- Env keys are optional; keyless operation always works (transcript + LRCLIB + Wikidata).

## How to test

`docker compose run --rm test /opt/venv/bin/pytest lookups -q`: the contract surface through `LookupsApi` with a mock HTTP transport and an injected transcript fetcher; no network.
