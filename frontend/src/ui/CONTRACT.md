# frontend / ui

Purpose: DOM overlays. The holo kit is the single modal system; nothing else creates panels.

- `holo.js`: `holoPanel({title, root, onClose})` -> `{el, header, body, close}`; materialize/dissolve animations, scan lines, ESC closes. `toast(message)`.
- `dialog.js` `Dialog`: the one chat component (world and interior, keepers and monument). Tell/ask modes for light keepers, ask-only for dark; grounded answers show glowing book chips that open the reader; NEEDS_SLEEP offers the sleep action and polls the job; mic button records to `/voice/stt`, replies can speak via `/voice/tts` (ring while listening, orb while speaking); a `VOICE_UNAVAILABLE` reply hides voice and the dialog stays fully usable as text.
- `reader.js` `openReader(book, {onDelete})`: metadata, body, destroy action.
- `hud.js` `Hud`: dream trigger with polling, new-keeper panel, back-to-island.
- `bubbles.js` `BubbleLayer`: chatter bubbles projected over walkers.
- `minimap.js` `Minimap`: island silhouette, plots, live keepers, camera jump on click.

Test: `docker compose run --rm test-frontend` (tests/dialog.test.js).
