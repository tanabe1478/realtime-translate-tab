from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import parse_qs, urlsplit


YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be"}


def is_youtube_url(source: str) -> bool:
    url = urlsplit(source)
    if url.scheme not in {"https", "http"} or url.hostname not in YOUTUBE_HOSTS:
        return False
    parts = url.path.strip("/").split("/")
    if url.hostname in {"youtu.be", "www.youtu.be"}:
        return len(parts) == 1 and bool(parts[0])
    if parts == ["watch"]:
        return bool(parse_qs(url.query).get("v"))
    return len(parts) == 2 and parts[0] in {"shorts", "live", "embed"} and bool(parts[1])


def download_audio(url: str, directory: str) -> Path:
    result = subprocess.run(
        [sys.executable, "-m", "yt_dlp", "--ignore-config", "--no-playlist", "--no-progress",
         "--js-runtimes", "node", "-f", "bestaudio/best", "--no-simulate",
         "--print", "after_move:filepath", "-o", str(Path(directory) / "audio.%(ext)s"), "--", url],
        stdout=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
    )
    if result.returncode:
        raise RuntimeError("yt-dlp could not download the audio. See the error above.")
    paths = result.stdout.splitlines()
    if len(paths) != 1 or not Path(paths[0]).is_file():
        raise RuntimeError("Expected one downloaded file. Pass a link to a single YouTube video.")
    return Path(paths[0])


def main() -> int:
    parser = argparse.ArgumentParser(description="Transcribe a local audio/video file or YouTube video with faster-whisper.")
    parser.add_argument("source", help="Local file path or YouTube video URL")
    parser.add_argument("--language", help="Source language, e.g. ja (default: auto-detect)")
    parser.add_argument("--json", action="store_true", help="Output transcription and metadata as JSON")
    args = parser.parse_args()
    path = Path(args.source)
    try:
        youtube = not path.is_file() and is_youtube_url(args.source)
    except ValueError:
        parser.error("invalid source URL")
    if not youtube and not path.is_file():
        parser.error(f"expected a local file or YouTube video URL: {args.source}")

    try:
        from recognition import load_model, run_transcription

        language = args.language.split("-")[0] if args.language else None
        if youtube:
            with TemporaryDirectory(prefix="whisper-youtube-") as directory:
                audio = download_audio(args.source, directory)
                result = run_transcription(load_model(), str(audio), language)
        else:
            result = run_transcription(load_model(), str(path), language)
    except Exception as error:
        print(f"Transcription failed: {error}", file=sys.stderr)
        return 1

    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False) if args.json else result["text"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
