#!/usr/bin/env python3
"""Overlay semantic ids and meanings from a uitest layout + bridge snapshot."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONT = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"


def parse_bounds(value: str) -> tuple[int, int, int, int] | None:
    match = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", value or "")
    if not match:
        return None
    return tuple(int(part) for part in match.groups())  # type: ignore[return-value]


def flatten_layout(node: dict, output: list[dict]) -> None:
    attributes = node.get("attributes", {})
    if attributes.get("id", "").startswith("sem."):
        output.append(attributes)
    for child in node.get("children", []):
        flatten_layout(child, output)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--layout", required=True)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--title", default="")
    args = parser.parse_args()

    image = Image.open(args.image).convert("RGBA")
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    font = ImageFont.truetype(FONT, 22)
    small = ImageFont.truetype(FONT, 18)

    snapshot = json.loads(Path(args.snapshot).read_text(encoding="utf-8"))
    semantics = {node.get("id"): node for node in snapshot.get("nodes", [])}
    layout = json.loads(Path(args.layout).read_text(encoding="utf-8"))
    nodes: list[dict] = []
    flatten_layout(layout, nodes)

    drawn = 0
    seen: set[str] = set()
    for attributes in nodes:
        node_id = attributes.get("id", "")
        if node_id in seen:
            continue
        if attributes.get("visible") == "false":
            continue
        bounds = parse_bounds(attributes.get("bounds", ""))
        if not bounds:
            continue
        left, top, right, bottom = bounds
        if right <= left or bottom <= top:
            continue
        semantic = semantics.get(node_id, {})
        meaning = semantic.get("meaning", "")
        label = node_id + (" | " + meaning if meaning else "")
        label = label[:70]
        draw.rectangle(bounds, fill=(255, 44, 44, 36), outline=(220, 20, 60, 255), width=3)
        text_width = draw.textlength(label, font=small)
        text_height = 24
        label_top = max(0, top - text_height - 4)
        draw.rectangle(
            (left, label_top, left + min(int(text_width) + 10, image.width - left), label_top + text_height),
            fill=(220, 20, 60, 220),
        )
        draw.text((left + 5, label_top + 1), label, font=small, fill=(255, 255, 255, 255))
        seen.add(node_id)
        drawn += 1

    if args.title:
        draw.rectangle((0, 0, image.width, 60), fill=(0, 0, 0, 150))
        draw.text((20, 12), args.title, font=font, fill=(255, 255, 255, 255))

    composed = Image.alpha_composite(image, overlay).convert("RGB")
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    composed.save(args.out, quality=92)
    print(json.dumps({"out": args.out, "annotatedNodes": drawn, "semanticNodes": len(semantics)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
