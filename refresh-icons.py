"""Copy the five project icons from the sibling repos into img/ and clean them.

PNGs are resized to 80px. SVGs lose editor comments and the XML prolog.
Also writes icon-sources.json (source path and SHA-256). Safe to run repeatedly.
"""
import hashlib
import io
import json
import re
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent
IMG = ROOT / "img"
PNG_SIZE = 80

# Output name in img/ -> source path relative to the repo root.
ICONS = {
    "sidequest.svg": "../Sidequest/assets/sidequest-icon.svg",
    "enclosure-pro.svg": "../enclosure-pro/images/EnclosureProIcon.svg",
    "circuit-scout.svg": "../Circuit Scout/favicon.svg",
    "sentinel.png": "../Sentinel/apple-touch-icon.png",
    "written.png": "prod/wbts_icon.png",
}


def clean_svg(data: bytes) -> bytes:
    text = data.decode("utf-8")
    text = re.sub(r"\A\ufeff?\s*<\?xml.*?\?>\s*", "", text, flags=re.S)
    text = re.sub(r"^[ \t]*<!--.*?-->[ \t]*\r?\n", "", text, flags=re.S | re.M)
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    return text.encode("utf-8")


def resize_png(data: bytes) -> bytes:
    with Image.open(io.BytesIO(data)) as im:
        im = im.convert("RGBA") if im.mode not in ("RGB", "RGBA") else im
        im = im.resize((PNG_SIZE, PNG_SIZE), Image.LANCZOS)
        out = io.BytesIO()
        im.save(out, "PNG", optimize=True)
    return out.getvalue()


def main() -> int:
    missing = [s for s in ICONS.values() if not (ROOT / s).is_file()]
    if missing:
        print("Missing source files (are the sibling repos checked out?):")
        for s in missing:
            print("  " + s)
        return 1

    sources = {}
    for name, rel in ICONS.items():
        raw = (ROOT / rel).read_bytes()
        sources[name] = {"source": rel.replace("\\", "/"), "sha256": hashlib.sha256(raw).hexdigest()}
        out = resize_png(raw) if name.endswith(".png") else clean_svg(raw)
        dest = IMG / name
        if dest.is_file() and dest.read_bytes() == out:
            print("unchanged  " + name)
        else:
            dest.write_bytes(out)
            print("updated    %s (%d bytes)" % (name, len(out)))

    manifest = json.dumps(sources, indent=2, sort_keys=True) + "\n"
    dest = ROOT / "icon-sources.json"
    if dest.is_file() and dest.read_text(encoding="utf-8") == manifest:
        print("unchanged  icon-sources.json")
    else:
        dest.write_text(manifest, encoding="utf-8", newline="\n")
        print("updated    icon-sources.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
