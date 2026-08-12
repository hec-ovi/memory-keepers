"""Pins voice/CONTRACT.md with injected fake Google clients."""
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from mk_voice import create_voice_router, unavailable_router
from mk_voice.router import VOICES


class FakeTts:
    def __init__(self):
        self.voice = None

    def synthesize_speech(self, input, voice, audio_config):
        self.voice = voice
        return SimpleNamespace(audio_content=b"OggS-fake-audio")


class FakeStt:
    def __init__(self):
        self.config = None

    def recognize(self, config, audio):
        assert audio.content
        self.config = config
        alt = SimpleNamespace(transcript="what did I dream")
        return SimpleNamespace(results=[SimpleNamespace(alternatives=[alt])])


def _client(router):
    app = FastAPI()
    app.include_router(router)
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://t")


@pytest.mark.asyncio
async def test_tts_returns_audio():
    tts = FakeTts()
    async with _client(create_voice_router(tts_client=tts)) as client:
        r = await client.post("/voice/tts", json={"text": "hello", "kind": "dark"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/ogg" and r.content.startswith(b"OggS")
    assert tts.voice.name == VOICES["dark"] and tts.voice.language_code == "en-US"


@pytest.mark.asyncio
async def test_tts_validates_text():
    async with _client(create_voice_router(tts_client=FakeTts())) as client:
        r = await client.post("/voice/tts", json={})
    assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION"


@pytest.mark.asyncio
async def test_stt_transcribes():
    from google.cloud import speech
    stt = FakeStt()
    async with _client(create_voice_router(stt_client=stt)) as client:
        r = await client.post("/voice/stt", content=b"webm-bytes")
    assert r.status_code == 200 and r.json()["text"] == "what did I dream"
    assert stt.config.encoding == speech.RecognitionConfig.AudioEncoding.WEBM_OPUS


@pytest.mark.asyncio
async def test_stt_ogg_body_picks_the_ogg_decoder():
    from google.cloud import speech
    stt = FakeStt()
    async with _client(create_voice_router(stt_client=stt)) as client:
        r = await client.post("/voice/stt", content=b"ogg-bytes",
                              headers={"content-type": "audio/ogg"})
    assert r.status_code == 200
    assert stt.config.encoding == speech.RecognitionConfig.AudioEncoding.OGG_OPUS


@pytest.mark.asyncio
async def test_unconfigured_voice_degrades_to_503():
    async with _client(unavailable_router()) as client:
        for path in ("/voice/tts", "/voice/stt"):
            r = await client.post(path, json={"text": "x"})
            assert r.status_code == 503
            assert r.json()["error"]["code"] == "VOICE_UNAVAILABLE"
