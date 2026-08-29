#!/usr/bin/env python3
"""Build the hedgehog sprite and embed it into the game as a data URI.

The sprite used to be pasted into the HTML by hand, which silently introduced
whitespace into the base64 payload and left the browser rendering a half-decoded
image. Generating and injecting it here keeps the sprite reproducible from the
source photo and lets us assert the embedded payload actually decodes.

Usage:
    python3 tools/build_sprite.py
"""

import base64
import io
import re
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

REPO = Path(__file__).resolve().parent.parent
SOURCE = REPO / "assets" / "hedgehog-source.jpg"
SPRITE = REPO / "assets" / "hedgehog-sprite.png"
TARGETS = [REPO / "index.html", REPO / "game" / "hedgehog-skiing.html"]

# A pixel counts as backdrop when it is bright and close to neutral grey.
BRIGHTNESS_MIN = 200
NEUTRAL_TOLERANCE = 34
# Upscale before masking so the cut-out edge survives the later downscale.
WORK_SCALE = 4
OUTPUT_MAX_EDGE = 240
PADDING = 2


def background_mask(rgb: np.ndarray) -> np.ndarray:
    """Flood fill the backdrop inward from the border.

    Seeding from the border matters: the muzzle and face have bright patches
    that a plain brightness threshold would punch holes through.
    """
    height, width, _ = rgb.shape
    brightness = rgb.max(axis=2).astype(np.int16)
    neutral = (rgb.max(axis=2).astype(np.int16) - rgb.min(axis=2).astype(np.int16))
    backdrop_like = (brightness >= BRIGHTNESS_MIN) & (neutral <= NEUTRAL_TOLERANCE)

    mask = np.zeros((height, width), dtype=bool)
    queue = deque()

    for x in range(width):
        for y in (0, height - 1):
            if backdrop_like[y, x] and not mask[y, x]:
                mask[y, x] = True
                queue.append((y, x))
    for y in range(height):
        for x in (0, width - 1):
            if backdrop_like[y, x] and not mask[y, x]:
                mask[y, x] = True
                queue.append((y, x))

    while queue:
        y, x = queue.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < height and 0 <= nx < width:
                if backdrop_like[ny, nx] and not mask[ny, nx]:
                    mask[ny, nx] = True
                    queue.append((ny, nx))

    return mask


def build_sprite() -> Image.Image:
    source = Image.open(SOURCE).convert("RGB")
    work = source.resize(
        (source.width * WORK_SCALE, source.height * WORK_SCALE), Image.LANCZOS
    )

    rgb = np.asarray(work)
    mask = background_mask(rgb)

    alpha = np.where(mask, 0, 255).astype(np.uint8)
    sprite = Image.fromarray(np.dstack([rgb, alpha]), mode="RGBA")

    # Soften the cut line so the sprite does not read as a hard paper cut-out.
    smoothed = sprite.getchannel("A").filter(ImageFilter.GaussianBlur(WORK_SCALE * 0.6))
    sprite.putalpha(smoothed)

    bbox = sprite.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    if bbox is None:
        sys.exit("background removal erased the whole image")

    left = max(0, bbox[0] - PADDING * WORK_SCALE)
    top = max(0, bbox[1] - PADDING * WORK_SCALE)
    right = min(sprite.width, bbox[2] + PADDING * WORK_SCALE)
    bottom = min(sprite.height, bbox[3] + PADDING * WORK_SCALE)
    sprite = sprite.crop((left, top, right, bottom))

    scale = OUTPUT_MAX_EDGE / max(sprite.size)
    if scale < 1:
        sprite = sprite.resize(
            (round(sprite.width * scale), round(sprite.height * scale)), Image.LANCZOS
        )

    return sprite


def to_data_uri(sprite: Image.Image) -> str:
    buffer = io.BytesIO()
    sprite.save(buffer, format="PNG", optimize=True)
    payload = base64.b64encode(buffer.getvalue()).decode("ascii")
    assert "\n" not in payload and " " not in payload
    return "data:image/png;base64," + payload


def inject(uri: str) -> None:
    pattern = re.compile(r"(hedgehogImg\.src = ')[^']*(')")
    for target in TARGETS:
        if not target.exists():
            continue
        html = target.read_text(encoding="utf-8")
        updated, count = pattern.subn(lambda m: m.group(1) + uri + m.group(2), html)
        if count != 1:
            sys.exit(f"expected exactly one sprite assignment in {target.name}, found {count}")
        target.write_text(updated, encoding="utf-8")
        print(f"  embedded sprite into {target.relative_to(REPO)}")


def verify() -> None:
    """Re-read the written HTML and prove the embedded payload decodes."""
    alphabet = set(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
    )
    for target in TARGETS:
        if not target.exists():
            continue
        html = target.read_text(encoding="utf-8")
        payload = re.search(r"hedgehogImg\.src = 'data:image/png;base64,([^']*)'", html)
        if not payload:
            sys.exit(f"no PNG data URI found in {target.name}")
        b64 = payload.group(1)

        illegal = [i for i, c in enumerate(b64) if c not in alphabet]
        if illegal:
            sys.exit(f"{target.name}: illegal base64 characters at {illegal[:5]}")

        image = Image.open(io.BytesIO(base64.b64decode(b64)))
        image.load()
        transparent = (np.asarray(image.getchannel("A")) == 0).mean()
        print(
            f"  {target.relative_to(REPO)}: decodes {image.size} {image.mode}, "
            f"{transparent * 100:.0f}% transparent, {len(b64) / 1024:.0f} KB base64"
        )


def main() -> None:
    print("building sprite from", SOURCE.relative_to(REPO))
    sprite = build_sprite()
    SPRITE.parent.mkdir(parents=True, exist_ok=True)
    sprite.save(SPRITE, format="PNG", optimize=True)
    print(f"  sprite: {sprite.size} -> {SPRITE.relative_to(REPO)}")

    inject(to_data_uri(sprite))
    print("verifying embedded payload")
    verify()
    print("done")


if __name__ == "__main__":
    main()
