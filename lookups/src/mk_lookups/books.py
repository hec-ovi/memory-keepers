"""Book facts through Gutendex (keyless Project Gutenberg mirror). When the
work is public domain the direct plain-text URL comes back too, so a keeper
can hold not just the memory of a book but the book itself."""
import httpx

GUTENDEX = "https://gutendex.com/books"


class BookFacts:
    def __init__(self, client: httpx.Client):
        self._client = client

    def facts(self, title: str) -> dict:
        title = (title or "").strip()
        if not title:
            return {"ok": False, "reason": "no_title"}
        try:
            res = self._client.get(GUTENDEX, params={"search": title})
            hits = res.json().get("results", []) if res.status_code == 200 else []
        except Exception:
            return {"ok": False, "reason": "unavailable"}
        if not hits:
            return {"ok": False, "reason": "not_found"}
        book = hits[0]
        author = next(iter(book.get("authors", [])), {})
        text_url = next((url for mime, url in (book.get("formats") or {}).items()
                         if mime.startswith("text/plain")), "")
        public_domain = book.get("copyright") is False
        return {"ok": True, "source": "gutendex",
                "title": book.get("title") or title,
                "author": author.get("name") or "",
                "author_years": f"{author.get('birth_year') or '?'}-{author.get('death_year') or '?'}",
                "subjects": (book.get("subjects") or [])[:4],
                "public_domain": public_domain,
                "text_url": text_url if public_domain else ""}
