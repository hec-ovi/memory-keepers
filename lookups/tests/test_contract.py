"""Contract surface of LookupsApi: each lookup, its fallback, and the
never-raises guarantee, all through mock transports."""
import httpx
import pytest

from mk_lookups import LookupsApi

LRCLIB_HIT = [{"trackName": "Yellow", "artistName": "Coldplay",
               "plainLyrics": "Look at the stars\nLook how they shine for you"}]
OMDB_HIT = {"Response": "True", "Title": "Inception", "Year": "2010",
            "Director": "Christopher Nolan", "Actors": "Leonardo DiCaprio, Elliot Page",
            "Plot": "A thief steals secrets through dreams.", "imdbRating": "8.8"}


def api_with(handler, transcript_fetch=None, env=None):
    client = httpx.Client(transport=httpx.MockTransport(handler))
    return LookupsApi(client=client, transcript_fetch=transcript_fetch, env=env or {})


def refuse(request):
    raise AssertionError(f"unexpected request: {request.url}")


# -- youtube_transcript -------------------------------------------------------

def test_transcript_from_watch_url():
    api = api_with(refuse, transcript_fetch=lambda vid: f"words of {vid}")
    out = api.youtube_transcript("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    assert out == {"ok": True, "video_id": "dQw4w9WgXcQ", "truncated": False,
                   "text": "words of dQw4w9WgXcQ"}


def test_transcript_bad_url_and_fetch_failure():
    def boom(vid):
        raise RuntimeError("blocked")
    api = api_with(refuse, transcript_fetch=boom)
    assert api.youtube_transcript("not a video")["reason"] == "not_a_youtube_url"
    assert api.youtube_transcript("dQw4w9WgXcQ") == {"ok": False, "reason": "unavailable"}


# -- song_lyrics --------------------------------------------------------------

def test_lyrics_via_lrclib():
    def handler(request):
        assert request.url.host == "lrclib.net"
        assert "memory-keepers" in request.headers.get("user-agent", "")
        return httpx.Response(200, json=LRCLIB_HIT)
    out = api_with(handler).song_lyrics("Yellow", "Coldplay")
    assert out["ok"] and out["source"] == "lrclib"
    assert "shine for you" in out["lyrics"]


def test_lyrics_falls_through_to_ovh():
    def handler(request):
        if request.url.host == "lrclib.net":
            return httpx.Response(200, json=[])
        assert request.url.host == "api.lyrics.ovh"
        return httpx.Response(200, json={"lyrics": "la la la"})
    out = api_with(handler).song_lyrics("Yellow", "Coldplay")
    assert out["ok"] and out["source"] == "lyrics.ovh" and out["lyrics"] == "la la la"


def test_lyrics_not_found_never_raises():
    def handler(request):
        raise httpx.ConnectError("down")
    assert api_with(handler).song_lyrics("Yellow", "Coldplay") == {
        "ok": False, "reason": "not_found"}
    assert api_with(refuse).song_lyrics("") == {"ok": False, "reason": "no_title"}


# -- movie_facts --------------------------------------------------------------

def test_movie_via_omdb_when_key_set():
    def handler(request):
        assert request.url.host == "www.omdbapi.com"
        assert request.url.params["apikey"] == "k"
        return httpx.Response(200, json=OMDB_HIT)
    out = api_with(handler, env={"OMDB_KEY": "k"}).movie_facts("Inception")
    assert out["ok"] and out["source"] == "omdb"
    assert out["director"] == "Christopher Nolan"
    assert out["cast"] == ["Leonardo DiCaprio", "Elliot Page"]
    assert out["imdb_rating"] == "8.8"


def test_movie_via_wikidata_without_key():
    def handler(request):
        assert request.url.host == "www.wikidata.org"
        action = request.url.params["action"]
        if action == "wbsearchentities":
            return httpx.Response(200, json={"search": [
                {"id": "Q25188", "description": "2010 science fiction film"}]})
        ids = request.url.params["ids"]
        if ids == "Q25188":
            return httpx.Response(200, json={"entities": {"Q25188": {
                "labels": {"en": {"value": "Inception"}},
                "descriptions": {"en": {"value": "2010 science fiction film"}},
                "claims": {
                    "P57": [{"mainsnak": {"datavalue": {"value": {"id": "Q25191"}}}}],
                    "P161": [{"mainsnak": {"datavalue": {"value": {"id": "Q38111"}}}}],
                    "P577": [{"mainsnak": {"datavalue": {"value": {"time": "+2010-07-16T00:00:00Z"}}}}],
                }}}})
        return httpx.Response(200, json={"entities": {
            "Q25191": {"labels": {"en": {"value": "Christopher Nolan"}}},
            "Q38111": {"labels": {"en": {"value": "Leonardo DiCaprio"}}}}})
    out = api_with(handler).movie_facts("Inception")
    assert out["ok"] and out["source"] == "wikidata"
    assert out["year"] == "2010"
    assert out["director"] == "Christopher Nolan"
    assert out["cast"] == ["Leonardo DiCaprio"]


def test_movie_not_found_never_raises():
    def handler(request):
        raise httpx.ConnectError("down")
    assert api_with(handler).movie_facts("Nothing") == {"ok": False, "reason": "not_found"}
