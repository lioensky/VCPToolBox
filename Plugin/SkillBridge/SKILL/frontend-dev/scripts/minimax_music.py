#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""
MiniMax Music Generation (HTTP)
Self-contained: no external dependencies beyond `requests`.

Usage:
  python minimax_music.py --prompt "Indie folk, melancholic" --lyrics "[verse]\nStreetlights flicker" -o song.mp3
  python minimax_music.py --prompt "Upbeat pop, energetic" --auto-lyrics -o pop.mp3
  python minimax_music.py --prompt "Jazz piano, smooth, relaxing" --instrumental -o jazz.mp3
  python minimax_music.py --model music-cover --prompt "Lo-fi bedroom pop rework" --audio-url https://host/ref.mp3 -o cover.mp3

Env: MINIMAX_API_KEY (required)
     MINIMAX_REGION (optional: global_en | cn_zh, default global_en)
     MINIMAX_API_BASE (optional: full base URL override, e.g. a gateway)
"""

import base64
import os
import sys
import json
import argparse
import requests

API_KEY = os.getenv("MINIMAX_API_KEY")

# The music API is served from two regional hosts with identical request shapes.
# Pick one by region name instead of pasting a host into every call site.
REGION_BASES = {
    "global_en": "https://api.minimax.io/v1",
    "cn_zh": "https://api.minimaxi.com/v1",
}
DEFAULT_REGION = "global_en"

# Text-to-music models take prompt/lyrics; cover models rework a reference track.
COVER_MODELS = ("music-cover", "music-cover-free")
MUSIC_MODELS = (
    "music-3.0",
    "music-2.6",
    "music-cover",
    "music-3.0-free",
    "music-2.6-free",
    "music-cover-free",
)
DEFAULT_MODEL = "music-3.0"


def resolve_api_base(region: str = "") -> str:
    """Resolve the API base URL. Explicit region wins, then MINIMAX_API_BASE, then MINIMAX_REGION."""
    if region:
        if region not in REGION_BASES:
            raise SystemExit(
                f"ERROR: unknown region '{region}'. Choose one of: {', '.join(REGION_BASES)}"
            )
        return REGION_BASES[region]

    override = (os.getenv("MINIMAX_API_BASE") or "").strip()
    if override:
        return override.rstrip("/")

    env_region = (os.getenv("MINIMAX_REGION") or "").strip()
    if env_region:
        if env_region not in REGION_BASES:
            raise SystemExit(
                f"ERROR: unknown MINIMAX_REGION '{env_region}'. Choose one of: {', '.join(REGION_BASES)}"
            )
        return REGION_BASES[env_region]

    return REGION_BASES[DEFAULT_REGION]


# Kept for backwards compatibility with callers that import API_BASE directly.
API_BASE = resolve_api_base()


def generate_music(
    prompt: str = "",
    lyrics: str = "",
    model: str = DEFAULT_MODEL,
    is_instrumental: bool = False,
    lyrics_optimizer: bool = False,
    audio_url: str = "",
    audio_base64: str = "",
    cover_feature_id: str = "",
    region: str = "",
    sample_rate: int = 44100,
    bitrate: int = 256000,
    fmt: str = "mp3",
    output_format: str = "hex",
    timeout: int = 600,
) -> dict:
    """Synchronous HTTP music generation. Returns dict with audio bytes and metadata."""
    if not API_KEY:
        raise SystemExit("ERROR: MINIMAX_API_KEY is not set.\n  export MINIMAX_API_KEY='your-key'")

    if model not in MUSIC_MODELS:
        raise SystemExit(f"ERROR: unknown model '{model}'. Choose one of: {', '.join(MUSIC_MODELS)}")

    is_cover = model in COVER_MODELS
    references = [bool(audio_url), bool(audio_base64), bool(cover_feature_id)]

    if is_cover:
        if sum(references) != 1:
            raise SystemExit(
                "ERROR: cover models need exactly one reference: --audio-url, --audio-file or --cover-feature-id."
            )
        if not prompt:
            raise SystemExit("ERROR: cover models require --prompt describing the target style.")
        if cover_feature_id and not lyrics:
            raise SystemExit("ERROR: --cover-feature-id requires lyrics.")
        if is_instrumental or lyrics_optimizer:
            raise SystemExit(
                "ERROR: --instrumental and --auto-lyrics are only supported by the text-to-music models."
            )
    elif any(references):
        raise SystemExit(
            "ERROR: reference audio and --cover-feature-id are only supported by the cover models."
        )

    payload = {
        "model": model,
        "audio_setting": {
            "sample_rate": sample_rate,
            "bitrate": bitrate,
            "format": fmt,
        },
        "output_format": output_format,
    }

    if prompt:
        payload["prompt"] = prompt
    if lyrics:
        payload["lyrics"] = lyrics
    if is_instrumental:
        payload["is_instrumental"] = True
    if lyrics_optimizer:
        payload["lyrics_optimizer"] = True
    if audio_url:
        payload["audio_url"] = audio_url
    if audio_base64:
        payload["audio_base64"] = audio_base64
    if cover_feature_id:
        payload["cover_feature_id"] = cover_feature_id

    resp = requests.post(
        f"{resolve_api_base(region)}/music_generation",
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=timeout,
    )
    resp.raise_for_status()
    data = resp.json()

    # Check API-level error
    base_resp = data.get("base_resp", {})
    if base_resp.get("status_code", 0) != 0:
        raise SystemExit(f"API Error [{base_resp.get('status_code')}]: {base_resp.get('status_msg')}")

    status = data.get("data", {}).get("status")
    if status != 2:
        raise SystemExit(f"Generation incomplete (status={status}): {json.dumps(data, indent=2)}")

    audio_data = data.get("data", {}).get("audio", "")
    if not audio_data:
        raise SystemExit(f"No audio in response: {json.dumps(data, indent=2)}")

    extra = data.get("extra_info", {})

    if output_format == "hex":
        audio_bytes = bytes.fromhex(audio_data)
    else:
        # URL mode — audio_data is a URL string
        audio_bytes = None

    return {
        "audio_bytes": audio_bytes,
        "audio_url": audio_data if output_format == "url" else None,
        "duration": extra.get("music_duration"),
        "sample_rate": extra.get("music_sample_rate"),
        "channels": extra.get("music_channel"),
        "bitrate": extra.get("bitrate"),
        "size": extra.get("music_size"),
    }


def main():
    p = argparse.ArgumentParser(description="MiniMax Music Generation (HTTP)")
    p.add_argument("-o", "--output", required=True, help="Output file path")
    p.add_argument("--prompt", default="", help="Music description: style, mood, scenario (max 2000 chars)")
    p.add_argument("--lyrics", default="", help="Song lyrics with structure tags (max 3500 chars)")
    p.add_argument("--lyrics-file", default="", help="Read lyrics from file instead of --lyrics")
    p.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        choices=list(MUSIC_MODELS),
        help=f"Model (default: {DEFAULT_MODEL})",
    )
    p.add_argument(
        "--region",
        default="",
        choices=list(REGION_BASES),
        help=f"Regional endpoint (default: MINIMAX_API_BASE / MINIMAX_REGION, else {DEFAULT_REGION})",
    )
    p.add_argument("--instrumental", action="store_true", help="Generate instrumental only (no vocals, text-to-music models only)")
    p.add_argument("--auto-lyrics", action="store_true", help="Auto-generate lyrics from prompt (text-to-music models only)")
    p.add_argument("--audio-url", default="", help="Reference track URL for the cover models")
    p.add_argument("--audio-file", default="", help="Local reference track for the cover models (sent as base64)")
    p.add_argument("--cover-feature-id", default="", help="Reference feature id from the cover preprocess step")
    p.add_argument("--format", default="mp3", dest="fmt", choices=["mp3", "wav", "pcm"], help="Audio format (default: mp3)")
    p.add_argument("--sample-rate", type=int, default=44100, choices=[16000, 24000, 32000, 44100], help="Sample rate (default: 44100)")
    p.add_argument("--bitrate", type=int, default=256000, choices=[32000, 64000, 128000, 256000], help="Bitrate (default: 256000)")
    args = p.parse_args()

    lyrics = args.lyrics
    if args.lyrics_file:
        with open(args.lyrics_file, "r") as f:
            lyrics = f.read()

    audio_base64 = ""
    if args.audio_file:
        with open(args.audio_file, "rb") as f:
            audio_base64 = base64.b64encode(f.read()).decode("ascii")

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)

    result = generate_music(
        prompt=args.prompt,
        lyrics=lyrics,
        model=args.model,
        is_instrumental=args.instrumental,
        lyrics_optimizer=args.auto_lyrics,
        audio_url=args.audio_url,
        audio_base64=audio_base64,
        cover_feature_id=args.cover_feature_id,
        region=args.region,
        sample_rate=args.sample_rate,
        bitrate=args.bitrate,
        fmt=args.fmt,
    )

    if result["audio_bytes"]:
        with open(args.output, "wb") as f:
            f.write(result["audio_bytes"])
        size = len(result["audio_bytes"])
    else:
        # URL mode — download
        r = requests.get(result["audio_url"], timeout=120)
        r.raise_for_status()
        with open(args.output, "wb") as f:
            f.write(r.content)
        size = len(r.content)

    duration = result.get("duration", "?")
    print(f"OK: {size} bytes -> {args.output} (duration: {duration}s)")


if __name__ == "__main__":
    main()
