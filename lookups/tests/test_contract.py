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


# -- song_facts ---------------------------------------------------------------

def test_song_facts_filters_bootlegs_to_the_official_original():
    def handler(request):
        assert request.url.host == "musicbrainz.org"
        return httpx.Response(200, json={"recordings": [
            {"title": "Bohemian Rhapsody", "score": 100,
             "first-release-date": "1991-05-01",
             "artist-credit": [{"name": "Queen"}],
             "releases": [{"status": "Bootleg", "title": "Live in Fukuoka"}]},
            {"title": "Bohemian Rhapsody", "score": 100,
             "first-release-date": "1975-10-31",
             "artist-credit": [{"name": "Queen"}],
             "releases": [{"status": "Official", "title": "A Night at the Opera"}]},
        ]})
    out = api_with(handler).song_facts("Bohemian Rhapsody", "Queen")
    assert out["ok"] and out["source"] == "musicbrainz"
    assert out["year"] == "1975" and out["album"] == "A Night at the Opera"


# -- book_facts ---------------------------------------------------------------

def test_book_facts_returns_public_domain_text_url():
    def handler(request):
        assert request.url.host == "gutendex.com"
        return httpx.Response(200, json={"results": [{
            "title": "Adventures of Huckleberry Finn", "copyright": False,
            "authors": [{"name": "Twain, Mark", "birth_year": 1835, "death_year": 1910}],
            "subjects": ["Mississippi River", "Boys", "Humorous stories", "Race relations", "More"],
            "formats": {"text/plain; charset=utf-8": "https://www.gutenberg.org/ebooks/76.txt.utf-8"},
        }]})
    out = api_with(handler).book_facts("huckleberry finn")
    assert out["ok"] and out["public_domain"] is True
    assert out["author"] == "Twain, Mark" and len(out["subjects"]) == 4
    assert out["text_url"].endswith("76.txt.utf-8")


# -- podcast_transcript -------------------------------------------------------

RSS = """<?xml version="1.0"?>
<rss xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel>
<item><title>Ep 2: The Heist</title>
  <podcast:transcript url="https://cdn.example/2.vtt" type="text/vtt"/></item>
<item><title>Ep 1: Origins</title></item>
</channel></rss>"""
VTT = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nwe begin at night\n\n2\n00:00:04.000 --> 00:00:08.000\nwe begin at night\nwith a plan\n"


def test_podcast_transcript_via_feed_vtt():
    def handler(request):
        if request.url.host == "itunes.apple.com":
            return httpx.Response(200, json={"results": [
                {"collectionName": "Darknet Diaries", "feedUrl": "https://feeds.example/dd"}]})
        if request.url.host == "feeds.example":
            return httpx.Response(200, text=RSS)
        assert request.url.host == "cdn.example"
        return httpx.Response(200, text=VTT)
    out = api_with(handler).podcast_transcript("darknet diaries", "heist")
    assert out["ok"] and out["episode"] == "Ep 2: The Heist"
    assert out["text"] == "we begin at night with a plan"


def test_podcast_without_transcript_tag_is_a_first_class_answer():
    def handler(request):
        if request.url.host == "itunes.apple.com":
            return httpx.Response(200, json={"results": [
                {"collectionName": "Darknet Diaries", "feedUrl": "https://feeds.example/dd"}]})
        return httpx.Response(200, text=RSS)
    out = api_with(handler).podcast_transcript("darknet diaries", "origins")
    assert out == {"ok": False, "reason": "no_transcript", "show": "Darknet Diaries",
                   "episode": "Ep 1: Origins"}


# -- movie_plot ---------------------------------------------------------------

def test_movie_plot_from_wikipedia_plot_section():
    plot_html = "<p>" + "A thief who steals corporate secrets through dream-sharing technology is given the inverse task of planting an idea. " * 5 + "</p>"

    def handler(request):
        if "/api/rest_v1/page/summary/" in str(request.url):
            if "Inception_(film)" in str(request.url):
                return httpx.Response(404)
            return httpx.Response(200, json={
                "titles": {"canonical": "Inception"},
                "extract": "Inception is a 2010 science fiction film.",
                "content_urls": {"desktop": {"page": "https://en.wikipedia.org/wiki/Inception"}}})
        action = request.url.params["action"]
        assert action == "parse"
        if request.url.params["prop"] == "sections":
            return httpx.Response(200, json={"parse": {"sections": [
                {"line": "Plot", "index": "1"}, {"line": "Cast", "index": "2"}]}})
        assert request.url.params["section"] == "1"
        return httpx.Response(200, json={"parse": {"text": {"*": plot_html}}})
    out = api_with(handler).movie_plot("Inception")
    assert out["ok"] and out["source"] == "wikipedia"
    assert out["license"] == "CC BY-SA 4.0" and out["url"].endswith("/Inception")
    assert "dream-sharing" in out["plot"] and len(out["plot"]) >= 400
    assert out["summary"].startswith("Inception is a 2010")
