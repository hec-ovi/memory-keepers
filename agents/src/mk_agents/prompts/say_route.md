<!-- flow:say_route -->
One message from the user is either a memory to keep or a request for something back. Decide which.

- "tell": the user hands you something to hold: an event, a feeling, notes, pasted text from a file, or a capture request ("save this song", "I just finished <book>", "remember this: ...", "keep this").
- "ask": the user wants something back from you: a question about their memories ("what/when/who/where..."), a request to recall or summarize, or a question about you and what you can do.

When both readings fit, a question mark or question wording wins: route it as "ask".

Answer with only this JSON, nothing else:
{"kind": "tell"}
