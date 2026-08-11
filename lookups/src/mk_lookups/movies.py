"""Movie facts: OMDb when OMDB_KEY is set (free key, 1,000/day, IMDb ratings),
keyless Wikidata otherwise. TMDB is not used: its API terms prohibit use in
connection with LLMs without written authorization.

Movie plots come from Wikipedia (CC BY-SA 4.0, attribution URL returned with
the text): the article's Plot section when it exists, the lede otherwise."""
import re
from urllib.parse import quote

import httpx

OMDB = "https://www.omdbapi.com/"
WIKIDATA = "https://www.wikidata.org/w/api.php"
WIKI_SUMMARY = "https://en.wikipedia.org/api/rest_v1/page/summary/"
WIKI_ACTION = "https://en.wikipedia.org/w/api.php"
PLOT_HEADINGS = {"plot", "plot summary", "synopsis", "premise"}
PLOT_CAP = 8000
PLOT_MIN = 400
TAG_RE = re.compile(r"<[^>]+>")
REF_RE = re.compile(r"\[\s*\d+\s*\]|\[\s*edit\s*\]")
CAST_CAP = 5


class MovieLookup:
    def __init__(self, client: httpx.Client, env):
        self._client = client
        self._env = env

    def facts(self, title: str, year: str = "") -> dict:
        title, year = (title or "").strip(), str(year or "").strip()
        if not title:
            return {"ok": False, "reason": "no_title"}
        found = None
        if self._env.get("OMDB_KEY"):
            found = self._omdb(title, year)
        if not found:
            found = self._wikidata(title)
        if not found:
            return {"ok": False, "reason": "not_found"}
        return {"ok": True, **found}

    def plot(self, title: str, year: str = "") -> dict:
        title, year = (title or "").strip(), str(year or "").strip()
        if not title:
            return {"ok": False, "reason": "no_title"}
        try:
            page = self._wiki_page(title, year)
            if not page:
                return {"ok": False, "reason": "not_found"}
            canonical, summary, url = page
            plot = self._wiki_plot(canonical)
        except Exception:
            return {"ok": False, "reason": "unavailable"}
        if not plot and not summary:
            return {"ok": False, "reason": "not_found"}
        return {"ok": True, "source": "wikipedia", "title": canonical.replace("_", " "),
                "summary": summary, "plot": plot, "url": url,
                "license": "CC BY-SA 4.0"}

    def _wiki_page(self, title: str, year: str) -> tuple[str, str, str] | None:
        candidates = ([f"{title} ({year} film)"] if year else []) + [f"{title} (film)", title]
        for candidate in candidates:
            res = self._client.get(WIKI_SUMMARY + quote(candidate.replace(" ", "_"), safe=""))
            if res.status_code != 200:
                continue
            data = res.json()
            extract = (data.get("extract") or "").strip()
            canonical = (data.get("titles") or {}).get("canonical") or candidate
            url = ((data.get("content_urls") or {}).get("desktop") or {}).get("page") or ""
            if extract:
                return canonical, extract, url
        return None

    def _wiki_plot(self, canonical: str) -> str:
        sections = self._client.get(WIKI_ACTION, params={
            "action": "parse", "page": canonical, "prop": "sections",
            "format": "json"}).json().get("parse", {}).get("sections", [])
        index = next((s["index"] for s in sections
                      if (s.get("line") or "").strip().lower() in PLOT_HEADINGS), None)
        if index is None:
            return ""
        html = self._client.get(WIKI_ACTION, params={
            "action": "parse", "page": canonical, "prop": "text",
            "section": index, "format": "json"}).json() \
            .get("parse", {}).get("text", {}).get("*", "")
        text = re.sub(r"\s+", " ", TAG_RE.sub(" ", html))
        text = REF_RE.sub("", text).strip()
        for heading in PLOT_HEADINGS:
            if text.lower().startswith(heading):
                text = text[len(heading):].lstrip(" .:")
                break
        return text[:PLOT_CAP] if len(text) >= PLOT_MIN else ""

    def _omdb(self, title: str, year: str) -> dict | None:
        params = {"apikey": self._env.get("OMDB_KEY"), "t": title}
        if year:
            params["y"] = year
        try:
            res = self._client.get(OMDB, params=params)
            data = res.json() if res.status_code == 200 else {}
        except Exception:
            return None
        if data.get("Response") != "True":
            return None
        return {"source": "omdb", "title": data.get("Title") or title,
                "year": data.get("Year") or year,
                "director": data.get("Director") or "",
                "cast": [a.strip() for a in (data.get("Actors") or "").split(",") if a.strip()],
                "plot": data.get("Plot") or "",
                "imdb_rating": data.get("imdbRating") or ""}

    def _wikidata(self, title: str) -> dict | None:
        try:
            entity_id = self._wikidata_film_id(title)
            if not entity_id:
                return None
            entity = self._wikidata_entity(entity_id)
            claims = entity.get("claims", {})
            people = self._claim_ids(claims, "P57") + self._claim_ids(claims, "P161")[:CAST_CAP]
            labels = self._wikidata_labels(people)
            directors = [labels[i] for i in self._claim_ids(claims, "P57") if i in labels]
            cast = [labels[i] for i in self._claim_ids(claims, "P161")[:CAST_CAP] if i in labels]
            date = self._first_time(claims, "P577")
            return {"source": "wikidata",
                    "title": entity.get("labels", {}).get("en", {}).get("value") or title,
                    "year": date[:4] if date else "",
                    "director": ", ".join(directors),
                    "cast": cast,
                    "plot": entity.get("descriptions", {}).get("en", {}).get("value") or "",
                    "imdb_rating": ""}
        except Exception:
            return None

    def _get(self, params: dict) -> dict:
        res = self._client.get(WIKIDATA, params={**params, "format": "json"})
        return res.json() if res.status_code == 200 else {}

    def _wikidata_film_id(self, title: str) -> str | None:
        data = self._get({"action": "wbsearchentities", "search": title,
                          "language": "en", "type": "item", "limit": 5})
        hits = data.get("search", [])
        for hit in hits:
            if "film" in (hit.get("description") or "").lower():
                return hit["id"]
        return hits[0]["id"] if hits else None

    def _wikidata_entity(self, entity_id: str) -> dict:
        data = self._get({"action": "wbgetentities", "ids": entity_id,
                          "props": "claims|labels|descriptions", "languages": "en"})
        return data.get("entities", {}).get(entity_id, {})

    def _wikidata_labels(self, ids: list[str]) -> dict:
        if not ids:
            return {}
        data = self._get({"action": "wbgetentities", "ids": "|".join(dict.fromkeys(ids)),
                          "props": "labels", "languages": "en"})
        return {i: e.get("labels", {}).get("en", {}).get("value", "")
                for i, e in data.get("entities", {}).items()}

    @staticmethod
    def _claim_ids(claims: dict, prop: str) -> list[str]:
        out = []
        for claim in claims.get(prop, []):
            value = claim.get("mainsnak", {}).get("datavalue", {}).get("value", {})
            if isinstance(value, dict) and value.get("id"):
                out.append(value["id"])
        return out

    @staticmethod
    def _first_time(claims: dict, prop: str) -> str:
        for claim in claims.get(prop, []):
            value = claim.get("mainsnak", {}).get("datavalue", {}).get("value", {})
            time = value.get("time") if isinstance(value, dict) else None
            if time:
                return time.lstrip("+")
        return ""
