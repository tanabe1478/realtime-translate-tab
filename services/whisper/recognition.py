from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from faster_whisper import WhisperModel

load_dotenv(Path(__file__).resolve().parents[2] / ".env")

MODEL_NAME = os.getenv("WHISPER_MODEL", "small")
DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")


def load_model() -> WhisperModel:
    return WhisperModel(
        MODEL_NAME,
        device=DEVICE,
        compute_type=COMPUTE_TYPE,
        cpu_threads=max(1, int(os.getenv("WHISPER_CPU_THREADS", "4"))),
        num_workers=1,
    )


def run_transcription(
    model: WhisperModel, path: str, language: str | None, initial_prompt: str | None = None
) -> dict[str, Any]:
    segments, info = model.transcribe(
        path,
        language=language,
        initial_prompt=initial_prompt,
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
