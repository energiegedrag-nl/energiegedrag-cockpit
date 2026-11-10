"""Unit tests for the firmware mirror: python -m unittest discover mirror"""

import struct
import unittest

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


if __name__ == "__main__":
    unittest.main()
