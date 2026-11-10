"""Builds the local vault into kluis/dist/: the page, the shell, the worker, the Python package and Pyodide itself.

    python kluis/maak.py [--uit MAP] [--commit SHA]
    python -m http.server -d kluis/dist 8000      # then open http://localhost:8000 (no /api there)

Same approach as AnonyMate (web/maak.py there):
- Pyodide is pinned in ONE place (PYODIDE_VERSION). Files come from jsDelivr only at build time, into a cache, and are
  checked: the runtime against kluis/pyodide-sha256.json, every package wheel against the sha256 in pyodide-lock.json.
  A mismatch fails the build. The browser never contacts jsDelivr.
- Reproducible: the same commit gives byte-identical files. Text files are written with LF, the Python package is
  zipped in a fixed order with fixed timestamps, nothing contains a path or the time of the build.
- manifest.json lists every file with size and sha256, the versions and the source commit. controleer.py compares a
  live site with a local build; CI attests manifest.json (actions/attest-build-provenance).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
WEB = HERE / "web"
SRC = HERE / "src" / "kluis"
CACHE = Path(os.environ.get("PYODIDE_CACHE") or HERE / ".pyodide-cache")
HASHES = HERE / "pyodide-sha256.json"
REPO = "https://github.com/energiegedrag-nl/energiegedrag-cockpit"

PYODIDE_VERSION = "314.0.7"
PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v{versie}/full/{naam}"
RUNTIME = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"]
# pyodide.mjs: the worker is a module worker (this Pyodide refuses classic workers).
PACKAGES = ["cryptography"]  # sqlite3 is part of the standard library in this Pyodide
WEB_FILES = ["index.html", "app.js", "worker.js", "kluis.css", "controleer.html"]
ZIP_TIME = (2026, 1, 1, 0, 0, 0)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def text_lf(path: Path) -> bytes:
    return path.read_bytes().replace(b"\r\n", b"\n")


def version() -> str:
    for line in (SRC / "__init__.py").read_text(encoding="utf-8").splitlines():
        if line.startswith("__version__"):
            return line.split('"')[1]
    raise SystemExit("no __version__ in kluis/__init__.py")


def commit_of_checkout() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "HEAD"], cwd=HERE, capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def fetch(name: str, expected: str | None) -> Path:
    path = CACHE / PYODIDE_VERSION / name
    if not path.exists():
        print(f"downloaden: {name}")
        path.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(PYODIDE_URL.format(versie=PYODIDE_VERSION, naam=name), timeout=120) as r:
            tmp = path.with_name(path.name + ".deel")
            tmp.write_bytes(r.read())
            tmp.replace(path)
    if expected is not None and sha256(path.read_bytes()) != expected:
        raise SystemExit(f"sha256 van {name} klopt niet met de vastgepinde waarde ({path}); verwijder het als de cache stuk is")
    return path


def resolve(lock: dict, names: list[str]) -> list[str]:
    out: list[str] = []

    def walk(name: str) -> None:
        name = name.lower()
        if name in out:
            return
        if name not in lock["packages"]:
            raise SystemExit(f"pakket {name!r} staat niet in pyodide-lock.json")
        out.append(name)
        for dep in lock["packages"][name].get("depends", []):
            walk(dep)

    for n in names:
        walk(n)
    return out


def pyodide(dist: Path) -> list[str]:
    pinned = json.loads(HASHES.read_text(encoding="utf-8"))
    if pinned.get("version") != PYODIDE_VERSION:
        raise SystemExit(f"{HASHES.name} is voor Pyodide {pinned.get('version')}, maak.py pint {PYODIDE_VERSION}")
    target = dist / "pyodide"
    target.mkdir(parents=True)
    for name in RUNTIME:
        shutil.copyfile(fetch(name, pinned["files"][name]), target / name)
    lock = json.loads((target / "pyodide-lock.json").read_text(encoding="utf-8"))
    names = resolve(lock, PACKAGES)
    for name in names:
        info = lock["packages"][name]
        shutil.copyfile(fetch(info["file_name"], info["sha256"]), target / info["file_name"])
    return names


def package_zip(dist: Path) -> dict:
    files = sorted(p for p in SRC.rglob("*.py"))
    path = dist / "kluis.zip"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for f in files:
            info = zipfile.ZipInfo("kluis/" + f.relative_to(SRC).as_posix(), date_time=ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, text_lf(f))
    data = path.read_bytes()
    return {"zip": "kluis.zip", "sha256": sha256(data), "version": version(), "pyodide": PYODIDE_VERSION}


def listing(dist: Path) -> dict:
    out = {}
    for f in sorted(p for p in dist.rglob("*") if p.is_file() and p.name != "manifest.json"):
        data = f.read_bytes()
        out[f.relative_to(dist).as_posix()] = {"size": len(data), "sha256": sha256(data)}
    return out


def build(dist: Path, commit: str) -> dict:
    if dist.exists():
        shutil.rmtree(dist)
    dist.mkdir(parents=True)
    for name in WEB_FILES:
        (dist / name).write_bytes(text_lf(WEB / name))
    packages = pyodide(dist)
    info = package_zip(dist)
    (dist / "kluis.json").write_bytes((json.dumps(info, indent=2) + "\n").encode())
    files = listing(dist)
    build_id = sha256("\n".join(f"{p} {i['sha256']}" for p, i in sorted(files.items())).encode())[:16]
    manifest = {
        "kluis": info["version"],
        "pyodide": PYODIDE_VERSION,
        "pakketten": packages,
        "bouw": build_id,
        "bron": {"repo": REPO, "commit": commit},
        "files": files,
    }
    (dist / "manifest.json").write_bytes((json.dumps(manifest, indent=2) + "\n").encode())
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--uit", type=Path, default=HERE / "dist")
    parser.add_argument("--commit", default=os.environ.get("KLUIS_COMMIT") or None)
    args = parser.parse_args()
    manifest = build(args.uit, args.commit or commit_of_checkout())
    size = sum(f["size"] for f in manifest["files"].values())
    print(f"klaar: {args.uit} ({len(manifest['files'])} bestanden, {size / 1e6:.1f} MB), bouw {manifest['bouw']}, commit {manifest['bron']['commit'][:12] or 'onbekend'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
