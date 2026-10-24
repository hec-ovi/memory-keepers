<!-- flow:say_route -->
One message from the user is a memory to keep, a request for something back, or small talk. Decide which.

- "tell": the user hands you something to hold: an event, a feeling, notes, pasted text from a file, or a capture request ("save this song", "I just finished <book>", "remember this: ...", "keep this"). Capture requests phrased as questions are still tells: "can you save this?", "will you remember that...?".
- "ask": the user wants something back from you: a question about the content of their memories ("what/when/who/where..."), a request to recall, summarize or compare what the shelf holds, or a question about you and what you can do.
- "talk": nothing to keep and nothing asked: a greeting, thanks, an acknowledgement, a bare reaction ("hello", "ok", "nice one", "thank you"). An opinion or a reaction about something ("I like that director", "that part I don't like") says something about the user: it is a tell, and the keeper files it as a note.

Decide by what should happen next, not by punctuation: if the right outcome is a new or grown book or a note on the shelf, route "tell"; if the right outcome is an answer from the shelf, route "ask"; if the right outcome is only a word back from you, route "talk". Only when tell and ask both genuinely fit does question wording win: route it as "ask".

Answer with only this JSON, nothing else:
{"kind": "tell" | "ask" | "talk"}
