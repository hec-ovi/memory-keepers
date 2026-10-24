"""The deterministic half of dreaming: co-occurrence linking and archetypes.
Zero model calls; prose is layered on top by the agents box."""
from collections import defaultdict

ARCHETYPE_LEXICON = {
    "desire": ("want", "wish", "love", "miss", "hope", "someday", "warm"),
    "fear": ("fear", "afraid", "worry", "worried", "dark", "cold", "lost", "scared"),
    "ambition": ("launch", "plan", "build", "goal", "mission", "schedule", "climb",
                 "finish", "deliver", "demo"),
    "obsession": ("again", "always", "keeps", "returning", "loop", "every", "same"),
}


def link(keepers_books: dict[str, list]) -> tuple[dict, list[dict]]:
    """keepers_books: keeper_id -> [Book] (light side only).
    Returns (graph, themes). A theme is an element shared by books of at least
    two different keepers; weight = number of citing books."""
    nodes, edges = {}, []
    element_books = defaultdict(list)  # (kind, element) -> [(kid, book)]

    for kid, books in keepers_books.items():
        nodes[f"keeper:{kid}"] = {"id": f"keeper:{kid}", "kind": "keeper",
                                  "label": kid, "keeper_id": kid,
                                  "weight": max(1, len(books))}
        for book in books:
            if book.source == "sleep":
                continue  # bookkeeping, never a theme
            bid = f"book:{kid}/{book.slug}"
            nodes[bid] = {"id": bid, "kind": "book", "label": book.title,
                          "keeper_id": kid, "weight": 1}
            edges.append({"source": f"keeper:{kid}", "target": bid,
                          "kind": "shelf", "weight": 1})
            for kind, values in (("entity", book.entities), ("tag", book.tags)):
                for value in dict.fromkeys(values):  # one citation per book
                    element_books[(kind, value)].append((kid, book))

    themes = []
    for (kind, value), citing in sorted(element_books.items()):
        if len(citing) < 2:
            continue
        eid = f"{kind}:{value}"
        nodes[eid] = {"id": eid, "kind": kind, "label": value, "weight": len(citing)}
        for kid, book in citing:
            edges.append({"source": f"book:{kid}/{book.slug}", "target": eid,
                          "kind": "mentions", "weight": 1})
        keeper_span = {kid for kid, _ in citing}
        if len(keeper_span) >= 2:
            themes.append({
                "key": value.lower().replace(" ", "-"), "element": value,
                "kind": kind, "weight": len(citing),
                "keepers": sorted(keeper_span),
                "evidence": [{"keeper_id": kid, "slug": b.slug, "title": b.title,
                              "body_md": b.body_md} for kid, b in citing],
            })

    themes.sort(key=lambda t: (-t["weight"], t["key"]))
    for theme in themes:
        theme["archetype"] = _archetype(theme)
    return {"nodes": list(nodes.values()), "edges": edges}, themes


def _archetype(theme: dict) -> str:
    text = " ".join(e["body_md"] for e in theme["evidence"]).lower()
    scores = {a: sum(text.count(w) for w in words)
              for a, words in ARCHETYPE_LEXICON.items()}
    return max(scores.items(), key=lambda p: (p[1], p[0]))[0]
