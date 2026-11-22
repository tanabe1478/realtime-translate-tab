from __future__ import annotations

import asyncio
import os
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from fastapi import FastAPI, HTTPException, Request
from faster_whisper import WhisperModel
import uvicorn

from recognition import COMPUTE_TYPE, DEVICE, MODEL_NAME, load_model, run_transcription

HOST = os.getenv("WHISPER_HOST", "127.0.0.1")
PORT = int(os.getenv("WHISPER_PORT", "8790"))
MAX_AUDIO_BYTES = 25 * 1024 * 1024

model: WhisperModel | None = None
model_lock = asyncio.Lock()


@asynccontextmanager
async def lifespan(_: FastAPI):
    global model
    print(f"Loading faster-whisper model={MODEL_NAME} device={DEVICE} compute_type={COMPUTE_TYPE}")
    model = await asyncio.to_thread(load_model)
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
    initial_prompt_header = request.headers.get("x-initial-prompt")
    initial_prompt = unquote(initial_prompt_header)[-1000:] if initial_prompt_header else None

    path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temporary:
            temporary.write(audio)
            path = temporary.name
        async with model_lock:
            result = await asyncio.to_thread(run_transcription, model, path, language, initial_prompt)
        return result
    finally:
        if path:
            Path(path).unlink(missing_ok=True)


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
