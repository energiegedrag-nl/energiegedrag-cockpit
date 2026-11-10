// SPDX-License-Identifier: EUPL-1.2
// Firmware from the mirror on the Cockpit's own origin (/firmware/, written by mirror/mirror.py).
// Every part is checked against the SHA-256 in the manifest before it may be flashed (docs/ontwerp.md, section 8).

export interface FirmwareEntry {
  repo: string;
  tag: string;
  variant: string;
  device_type: string;
  chip_family: string;
  prerelease: boolean;
  published_at: string | null;
  manifest: string; // relative to /firmware/
}

export interface FirmwareIndex {
  generated_at: number;
  firmware: FirmwareEntry[];
}

export interface ManifestPart {
  path: string;
  offset: number;
  sha256: string;
  size: number;
}

export interface Manifest {
  name: string;
  version: string;
  builds: { chipFamily: string; parts: ManifestPart[] }[];
  nfh: { repo: string; tag: string; variant: string; device_type: string; partition_table_offset: number };
}

export interface FlashImage {
  path: string;
  offset: number;
  data: Uint8Array;
}

const BASE = "/firmware/";

export class FirmwareError extends Error {}

export async function loadIndex(): Promise<FirmwareIndex> {
  const response = await fetch(BASE + "index.json", { cache: "no-cache" });
  if (response.status === 404) return { generated_at: 0, firmware: [] };
  if (!response.ok) throw new FirmwareError(`Firmware-index niet te laden (HTTP ${response.status}).`);
  return (await response.json()) as FirmwareIndex;
}

export async function sha256(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const safePath = (p: string) => /^[A-Za-z0-9._-]+$/.test(p);

/** Downloads the parts of one firmware build and checks size, SHA-256 and that no parts overlap. */
export async function loadImages(entry: FirmwareEntry, chipFamily: string): Promise<{ manifest: Manifest; images: FlashImage[] }> {
  const manifestUrl = BASE + entry.manifest;
  const response = await fetch(manifestUrl, { cache: "no-cache" });
  if (!response.ok) throw new FirmwareError(`Manifest niet te laden (HTTP ${response.status}).`);
  const manifest = (await response.json()) as Manifest;
  const build = manifest.builds.find((b) => b.chipFamily === chipFamily);
  if (!build) throw new FirmwareError(`Deze firmware is voor ${manifest.builds.map((b) => b.chipFamily).join(", ")}, het apparaat is een ${chipFamily}.`);

  const dir = manifestUrl.slice(0, manifestUrl.lastIndexOf("/") + 1);
  const images: FlashImage[] = [];
  for (const part of build.parts) {
    if (!safePath(part.path)) throw new FirmwareError(`Onverwacht bestand in het manifest: ${part.path}`);
    const r = await fetch(dir + part.path);
    if (!r.ok) throw new FirmwareError(`${part.path} niet te laden (HTTP ${r.status}).`);
    const data = new Uint8Array(await r.arrayBuffer());
    if (data.length !== part.size) throw new FirmwareError(`${part.path}: grootte klopt niet met het manifest.`);
    if ((await sha256(data)) !== part.sha256) throw new FirmwareError(`${part.path}: SHA-256 klopt niet met het manifest. Niet flashen.`);
    images.push({ path: part.path, offset: part.offset, data });
  }
  const sorted = [...images].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i - 1].offset + sorted[i - 1].data.length > sorted[i].offset) {
      throw new FirmwareError(`${sorted[i - 1].path} en ${sorted[i].path} overlappen. Niet flashen.`);
    }
  }
  return { manifest, images };
}

/** Newest first; releases before prereleases of the same moment. */
export function sortFirmware(list: FirmwareEntry[]): FirmwareEntry[] {
  return [...list].sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? "") || Number(a.prerelease) - Number(b.prerelease));
}
