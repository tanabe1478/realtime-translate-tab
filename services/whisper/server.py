from __future__ import annotations

import asyncio
import os
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from faster_whisper import WhisperModel
import uvicorn

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")

MODEL_NAME = os.getenv("WHISPER_MODEL", "small")
DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
HOST = os.getenv("WHISPER_HOST", "127.0.0.1")
PORT = int(os.getenv("WHISPER_PORT", "8790"))
MAX_AUDIO_BYTES = 25 * 1024 * 1024

model: WhisperModel | None = None
model_lock = asyncio.Lock()


@asynccontextmanager
async def lifespan(_: FastAPI):
    global model
    print(f"Loading faster-whisper model={MODEL_NAME} device={DEVICE} compute_type={COMPUTE_TYPE}")
    model = await asyncio.to_thread(
        WhisperModel,
        MODEL_NAME,
        device=DEVICE,
        compute_type=COMPUTE_TYPE,
        cpu_threads=max(1, int(os.getenv("WHISPER_CPU_THREADS", "4"))),
        num_workers=1,
    )
    print("Local Whisper is ready")
    yield
    model = None


app = FastAPI(title="Realtime Translate Local Whisper", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": model is not None,
        "model": MODEL_NAME,
        "device": DEVICE,
        "computeType": COMPUTE_TYPE,
    }


@app.post("/transcribe")
async def transcribe(request: Request) -> dict[str, Any]:
    if model is None:
        raise HTTPException(status_code=503, detail="Whisper model is not loaded")

    audio = await request.body()
    if not audio:
        raise HTTPException(status_code=400, detail="Audio body is empty")
    if len(audio) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="Audio exceeds the 25 MB limit")

    file_name = unquote(request.headers.get("x-file-name", "audio.wav"))
    suffix = safe_suffix(file_name, request.headers.get("content-type", ""))
    language_header = request.headers.get("x-source-language")
    language = language_header.split("-")[0] if language_header else None

    path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temporary:
            temporary.write(audio)
            path = temporary.name
        async with model_lock:
            result = await asyncio.to_thread(run_transcription, path, language)
        return result
    finally:
        if path:
            Path(path).unlink(missing_ok=True)


def run_transcription(path: str, language: str | None) -> dict[str, Any]:
    assert model is not None
    segments, info = model.transcribe(
        path,
        language=language,
        beam_size=1,
        best_of=1,
        vad_filter=True,
        condition_on_previous_text=False,
        word_timestamps=False,
    )
    text = " ".join(segment.text.strip() for segment in segments if segment.text.strip()).strip()
    return {
        "text": text,
        "language": info.language,
        "languageProbability": info.language_probability,
        "duration": info.duration,
        "model": MODEL_NAME,
    }


def safe_suffix(file_name: str, content_type: str) -> str:
    suffix = Path(file_name).suffix.lower()
    if suffix in {".wav", ".webm", ".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".ogg"}:
        return suffix
    if "wav" in content_type:
        return ".wav"
    if "webm" in content_type:
        return ".webm"
    if "mpeg" in content_type:
        return ".mp3"
    if "mp4" in content_type:
        return ".mp4"
    return ".bin"


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
