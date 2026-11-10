// The provisioning QR code a NeedForHeat device logs on its serial console after boot ("QR Code Payload:").
// Two formats exist (needforheat-generic-firmware, include/util/provisioning_code.hpp):
//   v1: JSON {"ver":"v1","name":"1A2B-3C4D5E","pop":"…","transport":"ble"}
//   v2: "NFH:" + Base32 of 15 bytes: 0x21, device type hash (2), last 3 MAC bytes, PoP (8), CRC-8
// The device name is "%04X-%02X%02X%02X": device type hash and the last three bytes of the MAC address.

export interface Provisioning {
  payload: string; // exactly what goes into the QR code on the label
  name: string;
  format: "v1" | "v2";
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function crc8(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

function base32Decode(text: string): Uint8Array | null {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of text) {
    const value = BASE32.indexOf(ch);
    if (value < 0) return null;
    buffer = ((buffer << 5) | value) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

const hex = (bytes: Iterable<number>) => Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, "0")).join("");

/** Name from a v2 payload, or null if the payload is damaged. */
export function decodeV2(payload: string): string | null {
  if (!payload.startsWith("NFH:")) return null;
  const bytes = base32Decode(payload.slice(4));
  if (!bytes || bytes.length < 15 || bytes[0] !== 0x21 || crc8(bytes.subarray(0, 14)) !== bytes[14]) return null;
  return `${hex(bytes.subarray(1, 3))}-${hex(bytes.subarray(3, 6))}`;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Finds the provisioning payload in console output; null while it has not appeared (completely) yet. */
export function findProvisioning(consoleText: string): Provisioning | null {
  const text = consoleText.replace(ANSI, "").replace(/\r/g, "");
  const marker = text.lastIndexOf("QR Code Payload:");
  if (marker < 0) return null;
  const rest = text.slice(marker + "QR Code Payload:".length);

  const v2 = /NFH:[A-Z2-7]{24}/.exec(rest);
  if (v2) {
    const name = decodeV2(v2[0]);
    return name ? { payload: v2[0], name, format: "v2" } : null;
  }

  const start = rest.indexOf("{");
  const end = rest.indexOf("}", start);
  if (start < 0 || end < 0) return null;
  const raw = rest.slice(start, end + 1);
  try {
    const parsed = JSON.parse(raw) as { name?: unknown; pop?: unknown };
    if (typeof parsed.name !== "string" || typeof parsed.pop !== "string") return null;
    return { payload: raw, name: parsed.name, format: "v1" };
  } catch {
    return null;
  }
}

/** Does the name end in the last three bytes of the MAC address (AA:BB:CC:DD:EE:FF)? */
export function nameMatchesMac(name: string, mac: string): boolean {
  return /^[0-9A-F]{4}-[0-9A-F]{6}$/.test(name) && name.slice(5) === mac.toUpperCase().split(":").slice(3).join("");
}
