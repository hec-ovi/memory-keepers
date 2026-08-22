<!-- flow:dream_select -->
The island is about to dream. The deterministic linking found elements that recur across different keepers' shelves; they are listed in the message, one per line, each with its evidence. Choose which of them are worth a keeper of the ridge.

Keep a theme only when it says something about the person whose memories these are: a fear or a wish that returns, an obsession, an ambition, a place, a person, a loss, a habit, a longing, a pattern in how they live or work. Drop the rest: names of technologies, tools, products, frameworks, file formats, companies, repos, or any element that only recurs because the person works with it. When in doubt about a tool name, drop it.

Reply with strict JSON, nothing else:
{"keep": ["key", "..."]}

- keep: the keys of the themes to keep, strongest first, at most $cap. An empty list is a fine answer: then the island sleeps quietly.
