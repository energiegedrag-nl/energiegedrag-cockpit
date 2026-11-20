# SPDX-License-Identifier: EUPL-1.2
"""Unit tests for the firmware mirror: python -m unittest discover mirror"""

import hashlib
import urllib.request
import urllib.error
import time
import json
import io
import os
import stat
import struct
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

import mirror


def entry(kind, subtype, offset, size, label):
    return b"\xaa\x50" + bytes([kind, subtype]) + struct.pack("<II", offset, size) + label.encode().ljust(16, b"\0") + b"\0" * 4


TABLE = entry(1, 2, 0x19000, 0x4000, "nvs") + entry(1, 0, 0x1D000, 0x2000, "otadata") + \
    entry(0, 0x10, 0x20000, 0x1F0000, "ota_0") + entry(0, 0x11, 0x210000, 0x1F0000, "ota_1") + b"\xff" * 32


def bootloader(chip_id=0):
    return bytes([0xE9, 3, 2, 0x20]) + b"\0" * 8 + struct.pack("<H", chip_id) + b"\0" * 14


class MirrorTest(unittest.TestCase):
    def test_chip(self):
        self.assertEqual(mirror.chip_of(bootloader(0)), ("ESP32", 0x1000))
        self.assertEqual(mirror.chip_of(bootloader(9)), ("ESP32-S3", 0))
        with self.assertRaises(mirror.Refused):
            mirror.chip_of(b"\0" * 32)

    def test_layout_uses_sdkconfig_offset(self):
        images = {"bootloader.bin": bootloader(), "partitions.bin": TABLE, "ota_data_initial.bin": b"\xff" * 8192,
                  "firmware.bin": b"\xe9" + b"\0" * 1000}
        offset = mirror.check_sdkconfig(mirror.sdkconfig_values('CONFIG_PARTITION_TABLE_OFFSET=0x18000\n# CONFIG_SECURE_BOOT is not set\n'))
        family, parts = mirror.layout(images, offset)
        self.assertEqual(family, "ESP32")
        self.assertEqual([(p["path"], p["offset"]) for p in parts],
                         [("bootloader.bin", 0x1000), ("partitions.bin", 0x18000), ("ota_data_initial.bin", 0x1D000), ("firmware.bin", 0x20000)])
        self.assertEqual(len(parts[0]["sha256"]), 64)

    def test_refuses_locking_builds(self):
        for line in ("CONFIG_SECURE_BOOT=y", "CONFIG_FLASH_ENCRYPTION_ENABLED=y", "CONFIG_SECURE_BOOT_V2_ENABLED=y"):
            with self.assertRaises(mirror.Refused):
                mirror.check_sdkconfig(mirror.sdkconfig_values(line))

    def test_refuses_too_large_firmware(self):
        images = {"bootloader.bin": bootloader(), "partitions.bin": TABLE, "firmware.bin": b"\0" * 0x1F0001}
        with self.assertRaises(mirror.Refused):
            mirror.layout(images, 0x18000)

    def test_variant_and_device_type(self):
        self.assertEqual(mirror.variant_of("twomes-p1-reader-firmware_ESP32DEV_PRODUCTION_SERVER_v1.0.0.zip", "x", "v1.0.0"),
                         "ESP32DEV_PRODUCTION_SERVER")
        self.assertEqual(mirror.variant_of("twomes-presence-detector_M5STACK_COREINK_v1.0.0.zip", "x", "v1.0.0"), "M5STACK_COREINK")
        with self.assertRaises(mirror.Refused):
            mirror.variant_of("a_../../etc_v1.zip", "x", "v1")
        self.assertEqual(mirror.device_type_of('constexpr const char *DEVICE_TYPE_NAME = "twomes-p1-reader-firmware";'),
                         "twomes-p1-reader-firmware")

    @unittest.skipIf(os.name == "nt", "POSIX file modes")
    def test_mirrored_variant_is_readable_by_others(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("bootloader.bin", bootloader())
            z.writestr("partitions.bin", TABLE)
            z.writestr("firmware.bin", b"\xe9" + b"\0" * 1000)
        data = buf.getvalue()
        asset = {"name": "lrm_M5STACK_COREINK_PRODUCTION_SERVER_v1.zip", "browser_download_url": "https://example.org/a.zip",
                 "digest": "sha256:" + hashlib.sha256(data).hexdigest()}
        release = {"tag_name": "v1", "prerelease": False, "published_at": "2026-11-18T00:00:00Z"}
        with tempfile.TemporaryDirectory() as d, mock.patch.object(mirror, "get", return_value=data):
            mirror.mirror_asset(Path(d), "org/lrm", release, asset, {}, "device")
            target = Path(d) / "lrm" / "v1" / "M5STACK_COREINK_PRODUCTION_SERVER"
            self.assertTrue(stat.S_IMODE(target.stat().st_mode) & stat.S_IXOTH, oct(target.stat().st_mode))
            self.assertTrue(stat.S_IMODE((target / "manifest.json").stat().st_mode) & stat.S_IROTH)


class TriggerTest(unittest.TestCase):
    """ "Nu ophalen": status.json, queueing during a run, at most one extra run a minute."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.out = Path(self.dir.name)
        self.state = mirror.State(self.out)

    def tearDown(self):
        self.dir.cleanup()

    def status(self):
        return json.loads((self.out / "status.json").read_text())

    def test_run_once_writes_status(self):
        with mock.patch.object(mirror, "run", return_value=(3, ["x: refused: y"])):
            self.state.run_once(["a/b"], 21600)
        s = self.status()
        self.assertFalse(s["running"])
        self.assertTrue(s["ok"])
        self.assertEqual(s["builds"], 3)
        self.assertEqual(s["problems"], ["x: refused: y"])
        self.assertEqual(s["next_run_at"], s["finished_at"] + 21600)

    def test_failed_run(self):
        with mock.patch.object(mirror, "run", side_effect=RuntimeError("boom")):
            self.state.run_once(["a/b"], 0)
        s = self.status()
        self.assertFalse(s["ok"])
        self.assertEqual(s["next_run_at"], 0)

    def test_trigger_when_idle_wakes_the_loop(self):
        code, body = self.state.trigger(now=1000)
        self.assertEqual(code, 202)
        self.assertTrue(self.state.wake.is_set())
        self.assertTrue(self.status()["requested"])

    def test_trigger_right_after_a_run_is_refused(self):
        self.state.finished_at = 1000
        code, body = self.state.trigger(now=1000 + mirror.TRIGGER_MIN_GAP_S - 10)
        self.assertEqual(code, 429)
        self.assertFalse(self.state.wake.is_set())
        code, _ = self.state.trigger(now=1000 + mirror.TRIGGER_MIN_GAP_S + 1)
        self.assertEqual(code, 202)

    def test_trigger_during_a_run_queues_one_more(self):
        seen = []

        def fake_run(out, repos):
            # A trigger arrives while this run is busy.
            seen.append(self.state.trigger(now=time.time()))
            seen.append(self.state.trigger(now=time.time()))
            return 1, []

        with mock.patch.object(mirror, "run", side_effect=fake_run):
            self.state.run_once(["a/b"], 21600)
        self.assertEqual([c for c, _ in seen], [202, 202])
        self.assertEqual(seen[0][1]["message"], "na de huidige ronde")
        self.assertEqual(seen[1][1]["message"], "al aangevraagd")
        # The loop must not sleep: the wake event stays set and status.json shows the request.
        self.assertTrue(self.state.wake.is_set())
        self.assertTrue(self.status()["requested"])

    def test_http_listener(self):
        server = mirror.start_trigger(self.state, "127.0.0.1:0")
        try:
            port = server.server_address[1]
            req = urllib.request.Request(f"http://127.0.0.1:{port}/refresh", method="POST")
            with urllib.request.urlopen(req, timeout=5) as r:
                self.assertEqual(r.status, 202)
            with self.assertRaises(urllib.error.HTTPError) as e:
                urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{port}/other", method="POST"), timeout=5)
            self.assertEqual(e.exception.code, 404)
        finally:
            server.shutdown()
            server.server_close()

    def test_trigger_off(self):
        self.assertIsNone(mirror.start_trigger(self.state, ""))


if __name__ == "__main__":
    unittest.main()
