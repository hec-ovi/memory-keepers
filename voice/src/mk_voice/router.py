"""Speech in and out: one FastAPI router the engine mounts under /voice.
Clients are injected in tests; missing credentials degrade to 503 and the
frontend falls back to text-only dialogs."""
import os

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

VOICES = {
    "light": os.environ.get("VOICE_LIGHT", "en-US-Neural2-F"),
    "dark": os.environ.get("VOICE_DARK", "en-US-Neural2-D"),
    "monument": os.environ.get("VOICE_MONUMENT", "en-US-Neural2-J"),
}


def _unavailable() -> JSONResponse:
    return JSONResponse(status_code=503, content={
        "error": {"code": "VOICE_UNAVAILABLE",
                  "message": "speech services are not configured"}})


def create_voice_router(tts_client=None, stt_client=None) -> APIRouter:
    router = APIRouter()
    clients = {"tts": tts_client, "stt": stt_client}

    def _tts():
        if clients["tts"] is None:
            from google.cloud import texttospeech
            clients["tts"] = texttospeech.TextToSpeechClient()
        return clients["tts"]

    def _stt():
        if clients["stt"] is None:
            from google.cloud import speech
            clients["stt"] = speech.SpeechClient()
        return clients["stt"]

    @router.post("/voice/tts")
    async def tts(body: dict):
        from google.cloud import texttospeech
        text = str(body.get("text", "")).strip()
        if not text:
            return JSONResponse(status_code=422, content={
                "error": {"code": "VALIDATION", "message": "text is required"}})
        voice = VOICES.get(body.get("kind", "light"), VOICES["light"])
        try:
            result = _tts().synthesize_speech(
                input=texttospeech.SynthesisInput(text=text),
                voice=texttospeech.VoiceSelectionParams(
                    language_code="-".join(voice.split("-")[:2]), name=voice),
                audio_config=texttospeech.AudioConfig(
                    audio_encoding=texttospeech.AudioEncoding.OGG_OPUS),
            )
        except Exception:
            return _unavailable()
        return Response(content=result.audio_content, media_type="audio/ogg")

    @router.post("/voice/stt")
    async def stt(request: Request):
        from google.cloud import speech
        audio = await request.body()
        if not audio:
            return JSONResponse(status_code=422, content={
                "error": {"code": "VALIDATION", "message": "audio body is required"}})
        config = dict(encoding=speech.RecognitionConfig.AudioEncoding.WEBM_OPUS,
                      language_code=os.environ.get("VOICE_LANGUAGE", "en-US"),
                      model=os.environ.get("VOICE_STT_MODEL", "latest_short"),
                      enable_automatic_punctuation=True)
        if "ogg" in request.headers.get("content-type", ""):
            config.update(encoding=speech.RecognitionConfig.AudioEncoding.OGG_OPUS,
                          sample_rate_hertz=48000)
        try:
            result = _stt().recognize(
                config=speech.RecognitionConfig(**config),
                audio=speech.RecognitionAudio(content=audio),
            )
        except Exception:
            return _unavailable()
        text = " ".join(r.alternatives[0].transcript
                        for r in result.results if r.alternatives).strip()
        return {"text": text}

    return router


def unavailable_router() -> APIRouter:
    """Mounted when voice is disabled, so the surface stays stable."""
    router = APIRouter()

    @router.post("/voice/tts")
    @router.post("/voice/stt")
    async def off():
        return _unavailable()

    return router
