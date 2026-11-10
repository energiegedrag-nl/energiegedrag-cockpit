# SPDX-License-Identifier: EUPL-1.2
"""Check that a live vault serves exactly what this checkout builds.

    python kluis/controleer.py https://kluis.energiegedrag.nl/ [--geen-bouw DIST]

Builds the vault (kluis/maak.py) from the current checkout, with the commit of the checkout, then fetches
manifest.json and every listed file from the site and compares sizes and SHA-256. Check out the commit that the live
manifest.json names first. Read-only: it only downloads.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tempfile
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import maak  # noqa: E402


def get(url: str) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers={"Cache-Control": "no-cache"}), timeout=120) as r:
        return r.read()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("site")
    parser.add_argument("--geen-bouw", type=Path, help="compare with an existing build directory instead of building")
    args = parser.parse_args()
    site = args.site.rstrip("/") + "/"

    live = json.loads(get(site + "manifest.json"))
    if args.geen_bouw:
        local = json.loads((args.geen_bouw / "manifest.json").read_text(encoding="utf-8"))
    else:
        out = Path(tempfile.mkdtemp(prefix="kluis-controle-"))
        local = maak.build(out / "dist", maak.commit_of_checkout())

    problems = []
    if live["bron"]["commit"] != local["bron"]["commit"]:
        problems.append(f"commit: live {live['bron']['commit']}, lokaal {local['bron']['commit']} (check de live commit uit)")
    if live["files"] != local["files"]:
        for name in sorted(set(live["files"]) | set(local["files"])):
            if live["files"].get(name) != local["files"].get(name):
                problems.append(f"manifest verschilt voor {name}")
    for name, info in sorted(live["files"].items()):
        data = get(site + name)
        if len(data) != info["size"] or hashlib.sha256(data).hexdigest() != info["sha256"]:
            problems.append(f"{name}: de server levert iets anders dan zijn eigen manifest")
    if problems:
        print("NIET GELIJK:")
        for p in problems:
            print("  - " + p)
        return 1
    print(f"Gelijk: {len(live['files'])} bestanden van {site} zijn byte voor byte de build van commit {live['bron']['commit']}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
