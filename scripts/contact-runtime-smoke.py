"""Exercise the packaged Docling OCR and Rust graph without persistent data."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from contact_worker.parser import parse


def check_ocr(directory: Path) -> None:
    card = directory / "card.png"
    image = Image.new("RGB", (1200, 420), "white")
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.truetype("DejaVuSans.ttf", 72)
    except OSError:
        font = ImageFont.load_default(size=72)
    draw.text((65, 70), "ROBIN VALE", fill="black", font=font)
    draw.text((65, 200), "SAMPLE STUDIO", fill="black", font=font)
    image.save(card)
    blocks = parse(card, "png", "package-smoke")
    text = " ".join(block["text"] for block in blocks).upper()
    if any(word not in text for word in ("ROBIN", "VALE", "SAMPLE", "STUDIO")):
        raise AssertionError(f"Docling OCR missed synthetic card text: {text[:200]!r}")


def check_graph(directory: Path) -> None:
    graph_bin = os.environ.get("CONTACT_GRAPH_BIN", "/usr/local/bin/contact-graph")
    env = {**os.environ, "CONTACT_GRAPH_SQLITE_PATH": str(directory / "graph.sqlite")}
    frames = [
        {"version": 1, "request_id": "save", "op": "save_contact", "payload": {
            "operation_id": "package-smoke-save", "actor": "package-smoke", "label": "Person",
            "set_properties": {"name": "Robin Vale"},
            "evidence": [{"field_path": "properties.name", "value": "Robin Vale",
                          "source_type": "manual", "locator_status": "not_applicable",
                          "collected_at": "2026-01-01T00:00:00Z"}],
        }},
    ]
    first = subprocess.run([graph_bin], input="\n".join(map(json.dumps, frames)) + "\n",
                           text=True, capture_output=True, check=True, env=env, timeout=30)
    saved = json.loads(first.stdout.strip())
    if not saved.get("ok") or not saved.get("result", {}).get("entity_id"):
        raise AssertionError(f"Graph insert failed: {saved}")
    entity_id = saved["result"]["entity_id"]
    request = {"version": 1, "request_id": "read", "op": "get_contact",
               "payload": {"entity_id": entity_id}}
    second = subprocess.run([graph_bin], input=json.dumps(request) + "\n", text=True,
                            capture_output=True, check=True, env=env, timeout=30)
    read = json.loads(second.stdout.strip())
    if not read.get("ok") or read.get("result", {}).get("entity", {}).get("properties", {}).get("name") != "Robin Vale":
        raise AssertionError(f"Graph read failed: {read}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ocr-only", action="store_true", help="populate Docling OCR model cache")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="contact-package-smoke-") as scratch:
        directory = Path(scratch)
        check_ocr(directory)
        if not args.ocr_only:
            check_graph(directory)
    print("contact package smoke: ok")


if __name__ == "__main__":
    main()
