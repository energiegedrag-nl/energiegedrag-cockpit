// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from "vitest";
import { md5 } from "./md5";
import { decodeV2, findProvisioning, nameMatchesMac } from "./provisioning";

const text = (s: string) => new TextEncoder().encode(s);

describe("md5", () => {
  it("matches RFC 1321 test vectors", () => {
    expect(md5(text(""))).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5(text("abc"))).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5(text("12345678901234567890123456789012345678901234567890123456789012345678901234567890"))).toBe(
      "57edf4a22be3c955ac49da2e2107b67a",
    );
  });
});

// Same encoding as ProvisioningCode::Make in the firmware.
function makeV2(hash: number, macTail: number[], pop: bigint): string {
  const bytes = [0x21, hash >> 8, hash & 0xff, ...macTail];
  for (let i = 7; i >= 0; i--) bytes.push(Number((pop >> BigInt(8 * i)) & 0xffn));
  let crc = 0;
  for (const b of bytes) {
    crc ^= b;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  bytes.push(crc);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const b of bytes) {
    buffer = (buffer << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return "NFH:" + out;
}

describe("provisioning payload", () => {
  const v2 = makeV2(0x1a2b, [0xdd, 0xee, 0xff], 1234567890123456789n);

  it("decodes v2 and rejects a damaged code", () => {
    expect(v2).toHaveLength(28);
    expect(decodeV2(v2)).toBe("1A2B-DDEEFF");
    const damaged = v2.slice(0, 10) + (v2[10] === "A" ? "B" : "A") + v2.slice(11);
    expect(decodeV2(damaged)).toBeNull();
  });

  it("finds v2 in coloured ESP-IDF log output", () => {
    const log = `\x1b[0;32mI (812) generic_esp_32: QR Code Payload: \n\n\n${v2}\n\n\x1b[0m\r\n`;
    expect(findProvisioning(log)).toEqual({ payload: v2, name: "1A2B-DDEEFF", format: "v2" });
  });

  it("finds v1 JSON, also across lines, and waits for the closing brace", () => {
    const json = '{\n"ver":"v1",\n"name":"1A2B-DDEEFF",\n"pop":"810471295",\n"transport":"ble"\n}';
    const log = `I (700) generic_esp_32: QR Code Payload: \n\n\n${json}\n\n`;
    expect(findProvisioning(log)?.name).toBe("1A2B-DDEEFF");
    expect(findProvisioning(log)?.payload).toBe(json);
    expect(findProvisioning(log.slice(0, log.indexOf("}")))).toBeNull();
    expect(findProvisioning("I (10) boot: ESP-IDF v4.4")).toBeNull();
  });

  it("checks the name against the MAC address", () => {
    expect(nameMatchesMac("1A2B-DDEEFF", "aa:bb:cc:dd:ee:ff")).toBe(true);
    expect(nameMatchesMac("1A2B-DDEEF0", "AA:BB:CC:DD:EE:FF")).toBe(false);
  });
});
