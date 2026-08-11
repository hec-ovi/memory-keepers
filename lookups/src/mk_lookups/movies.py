"""Movie facts: OMDb when OMDB_KEY is set (free key, 1,000/day, IMDb ratings),
keyless Wikidata otherwise. TMDB is not used: its API terms prohibit use in
connection with LLMs without written authorization."""
import httpx

OMDB = "https://www.omdbapi.com/"
WIKIDATA = "https://www.wikidata.org/w/api.php"
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
