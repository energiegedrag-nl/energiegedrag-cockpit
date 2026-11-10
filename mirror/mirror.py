"""Firmware mirror for the Cockpit flash station (docs/22, section 6).

Fetches the GitHub releases of the NeedForHeat firmware repositories, checks every zip against the SHA-256 digest
GitHub reports, unpacks the images and writes a manifest in the ESP Web Tools format with the flash offsets and a
SHA-256 per part. The Cockpit serves the result under /firmware/, so the browser flashes from its own origin.

Offsets: the bootloader offset follows from the chip (read from the bootloader image header), the partition table
offset from CONFIG_PARTITION_TABLE_OFFSET in the repository's sdkconfig at the release tag, otadata and the app from
the partition table itself.

Builds that enable secure boot or flash encryption are refused: their bootloader would burn eFuses on first boot,
which cannot be undone. Without a readable sdkconfig a release is refused as well.

Standard library only. Configuration through environment variables:
  FIRMWARE_REPOS   comma-separated owner/repo list
  FIRMWARE_DIR     output directory (default /firmware)
  MIRROR_INTERVAL  seconds between runs; 0 = run once (default 21600)
  GITHUB_TOKEN     optional, raises the GitHub API rate limit
"""

import hashlib
import io
import json
import os
import re
import shutil
import struct
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

DEFAULT_REPOS = ",".join(
    "energiegedrag-nl/needforheat-" + name
    for name in ["p1-reader-firmware", "living-room-module-firmware", "presence-detector-firmware", "boiler-monitor-firmware"]
)
PARTS = ["bootloader.bin", "partitions.bin", "ota_data_initial.bin", "firmware.bin"]

# Chip ID in the extended image header -> (ESP Web Tools chipFamily, bootloader offset).
CHIPS = {
    0: ("ESP32", 0x1000),
    2: ("ESP32-S2", 0x1000),
    5: ("ESP32-C3", 0x0),
    9: ("ESP32-S3", 0x0),
    12: ("ESP32-C2", 0x0),
    13: ("ESP32-C6", 0x0),
    16: ("ESP32-H2", 0x0),
}

SAFE_NAME = re.compile(r"^[A-Za-z0-9._-]+$")


class Refused(Exception):
    """A release that must not be offered for flashing."""


def chip_of(bootloader: bytes) -> tuple[str, int]:
    """Chip family and bootloader offset from an ESP image header (magic 0xE9, chip ID at byte 12)."""
    if len(bootloader) < 24 or bootloader[0] != 0xE9:
        raise Refused("bootloader.bin is not an ESP image")
    chip_id = struct.unpack_from("<H", bootloader, 12)[0]
    if chip_id not in CHIPS:
        raise Refused(f"unknown chip ID {chip_id}")
    return CHIPS[chip_id]


def partitions_of(table: bytes) -> list[dict]:
    """Entries of a binary partition table (32 bytes each, magic 0x50AA)."""
    out = []
    for pos in range(0, len(table) - 31, 32):
        entry = table[pos : pos + 32]
        if entry[:2] != b"\xaa\x50":
            break
        kind, subtype, offset, size = entry[2], entry[3], *struct.unpack_from("<II", entry, 4)
        label = entry[12:28].split(b"\0", 1)[0].decode("ascii", "replace")
        out.append({"type": kind, "subtype": subtype, "offset": offset, "size": size, "label": label})
    return out


def sdkconfig_values(text: str) -> dict[str, str]:
    values = {}
    for line in text.splitlines():
        m = re.match(r"^(CONFIG_[A-Z0-9_]+)=(.*)$", line.strip())
        if m:
            values[m.group(1)] = m.group(2).strip().strip('"')
    return values


def check_sdkconfig(values: dict[str, str]) -> int:
    """Refuse builds that would lock the chip; return the partition table offset."""
    for key in ("CONFIG_SECURE_BOOT", "CONFIG_SECURE_BOOT_V1_ENABLED", "CONFIG_SECURE_BOOT_V2_ENABLED",
                "CONFIG_FLASH_ENCRYPTION_ENABLED", "CONFIG_SECURE_FLASH_ENC_ENABLED"):
        if values.get(key) == "y":
            raise Refused(f"{key}=y: this bootloader would burn eFuses")
    return int(values.get("CONFIG_PARTITION_TABLE_OFFSET", "0x8000"), 0)


def layout(images: dict[str, bytes], table_offset: int) -> tuple[str, list[dict]]:
    """Chip family and the parts with their offsets."""
    family, boot_offset = chip_of(images["bootloader.bin"])
    table = partitions_of(images["partitions.bin"])
    otadata = next((p for p in table if p["type"] == 1 and p["subtype"] == 0), None)
    apps = [p for p in table if p["type"] == 0]
    app = next((p for p in apps if p["subtype"] == 0x10), None) or next((p for p in apps if p["subtype"] == 0), None)
    if app is None:
        raise Refused("no ota_0 or factory partition")
    if len(images["firmware.bin"]) > app["size"]:
        raise Refused("firmware.bin does not fit its partition")
    if table_offset < boot_offset + len(images["bootloader.bin"]):
        raise Refused("partition table would overwrite the bootloader")
    parts = [
        {"path": "bootloader.bin", "offset": boot_offset},
        {"path": "partitions.bin", "offset": table_offset},
    ]
    if otadata is not None and "ota_data_initial.bin" in images:
        parts.append({"path": "ota_data_initial.bin", "offset": otadata["offset"]})
    parts.append({"path": "firmware.bin", "offset": app["offset"]})
    for part in parts:
        part["sha256"] = hashlib.sha256(images[part["path"]]).hexdigest()
        part["size"] = len(images[part["path"]])
    return family, parts


def variant_of(asset_name: str, repo_name: str, tag: str) -> str:
    """'twomes-p1-reader-firmware_ESP32DEV_PRODUCTION_SERVER_v1.0.0.zip' -> 'ESP32DEV_PRODUCTION_SERVER'."""
    stem = asset_name[:-4] if asset_name.endswith(".zip") else asset_name
    if stem.endswith("_" + tag):
        stem = stem[: -len(tag) - 1]
    head, sep, rest = stem.partition("_")
    variant = rest if sep else stem
    if not SAFE_NAME.match(variant):
        raise Refused(f"unexpected asset name {asset_name}")
    return variant


def device_type_of(main_cpp: str) -> str:
    m = re.search(r'DEVICE_TYPE_NAME\s*=\s*"([^"]+)"', main_cpp)
    return m.group(1) if m else ""


# ---- network -------------------------------------------------------------------------------------------------------

def get(url: str, api: bool = False) -> bytes:
    headers = {"User-Agent": "energiegedrag-cockpit-firmware-mirror"}
    if api:
        headers["Accept"] = "application/vnd.github+json"
        if os.environ.get("GITHUB_TOKEN"):
            headers["Authorization"] = "Bearer " + os.environ["GITHUB_TOKEN"]
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=120) as response:
        return response.read()


def get_optional(url: str) -> str | None:
    try:
        return get(url).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def mirror_asset(out: Path, repo: str, release: dict, asset: dict, sdkconfig: dict[str, str], device_type: str) -> dict:
    tag = release["tag_name"]
    variant = variant_of(asset["name"], repo.split("/")[1], tag)
    target = out / repo.split("/")[1] / tag / variant
    if (target / "manifest.json").is_file():
        return json.loads((target / "manifest.json").read_text())

    digest = asset.get("digest") or ""
    if not digest.startswith("sha256:"):
        raise Refused(f"{asset['name']}: GitHub reports no SHA-256 digest")
    data = get(asset["browser_download_url"])
    if hashlib.sha256(data).hexdigest() != digest[7:]:
        raise Refused(f"{asset['name']}: SHA-256 does not match the digest GitHub reports")

    with zipfile.ZipFile(io.BytesIO(data)) as z:
        names = set(z.namelist())
        missing = [p for p in ("bootloader.bin", "partitions.bin", "firmware.bin") if p not in names]
        if missing:
            raise Refused(f"{asset['name']}: missing {', '.join(missing)}")
        images = {p: z.read(p) for p in PARTS if p in names}

    family, parts = layout(images, check_sdkconfig(sdkconfig))
    manifest = {
        "name": f"{repo.split('/')[1]} {variant}",
        "version": tag,
        "new_install_prompt_erase": True,
        "builds": [{"chipFamily": family, "parts": [{k: v for k, v in p.items()} for p in parts]}],
        "nfh": {
            "repo": repo,
            "tag": tag,
            "variant": variant,
            "device_type": device_type,
            "prerelease": bool(release.get("prerelease")),
            "published_at": release.get("published_at"),
            "source": asset["browser_download_url"],
            "source_sha256": digest[7:],
            "partition_table_offset": parts[1]["offset"],
        },
    }
    tmp = Path(tempfile.mkdtemp(dir=out, prefix=".tmp-"))
    try:
        for part in parts:
            (tmp / part["path"]).write_bytes(images[part["path"]])
        (tmp / "manifest.json").write_text(json.dumps(manifest, indent=2))
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(tmp, target)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return manifest


def run(out: Path, repos: list[str]) -> None:
    out.mkdir(parents=True, exist_ok=True)
    entries = []
    for repo in repos:
        try:
            releases = json.loads(get(f"https://api.github.com/repos/{repo}/releases?per_page=20", api=True))
        except Exception as e:  # keep mirroring the other repositories
            print(f"{repo}: {e}", file=sys.stderr)
            continue
        for release in releases:
            if release.get("draft"):
                continue
            tag = release["tag_name"]
            zips = [a for a in release.get("assets", []) if a["name"].endswith(".zip")]
            if not zips or not SAFE_NAME.match(tag):
                continue
            raw = f"https://raw.githubusercontent.com/{repo}/{tag}"
            try:
                text = get_optional(f"{raw}/sdkconfig")
                if text is None:
                    raise Refused("no sdkconfig at this tag")
                sdkconfig = sdkconfig_values(text)
                device_type = device_type_of(get_optional(f"{raw}/src/main.cpp") or "")
            except Refused as e:
                print(f"{repo} {tag}: refused: {e}", file=sys.stderr)
                continue
            except Exception as e:
                print(f"{repo} {tag}: {e}", file=sys.stderr)
                continue
            for asset in zips:
                try:
                    manifest = mirror_asset(out, repo, release, asset, sdkconfig, device_type)
                except Refused as e:
                    print(f"{repo} {tag}: refused: {e}", file=sys.stderr)
                    continue
                except Exception as e:
                    print(f"{repo} {tag} {asset['name']}: {e}", file=sys.stderr)
                    continue
                nfh = manifest["nfh"]
                entries.append({
                    "repo": nfh["repo"], "tag": nfh["tag"], "variant": nfh["variant"], "device_type": nfh["device_type"],
                    "chip_family": manifest["builds"][0]["chipFamily"], "prerelease": nfh["prerelease"],
                    "published_at": nfh["published_at"],
                    "manifest": f"{repo.split('/')[1]}/{nfh['tag']}/{nfh['variant']}/manifest.json",
                })
    index = {"generated_at": int(time.time()), "firmware": entries}
    tmp = out / ".index.json.tmp"
    tmp.write_text(json.dumps(index, indent=2))
    os.replace(tmp, out / "index.json")
    print(f"mirrored {len(entries)} builds")


def main() -> None:
    out = Path(os.environ.get("FIRMWARE_DIR", "/firmware"))
    repos = [r.strip() for r in os.environ.get("FIRMWARE_REPOS", DEFAULT_REPOS).split(",") if r.strip()]
    interval = int(os.environ.get("MIRROR_INTERVAL", "21600"))
    while True:
        try:
            run(out, repos)
        except Exception as e:
            print(f"mirror run failed: {e}", file=sys.stderr)
        if interval <= 0:
            return
        time.sleep(interval)


if __name__ == "__main__":
    main()
