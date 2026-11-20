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

/** status.json of the mirror (mirror/mirror.py, State.write). */
export interface MirrorStatus {
  running: boolean;
  requested: boolean;
  started_at: number;
  finished_at: number;
  ok: boolean | null;
  builds: number;
  problems: string[];
  next_run_at: number;
}

/** null: no status yet (older mirror, or it has not run). */
export async function loadMirrorStatus(): Promise<MirrorStatus | null> {
  const response = await fetch(BASE + "status.json", { cache: "no-cache" });
  if (response.status === 404) return null;
  if (!response.ok) throw new FirmwareError(`Status van de firmwarespiegel niet te laden (HTTP ${response.status}).`);
  return (await response.json()) as MirrorStatus;
}

/** Ask the mirror to fetch the releases now. Throws ApiError-like errors with a Dutch message. */
export async function refreshMirror(token: string | null): Promise<string> {
  const response = await fetch("/firmware-mirror/refresh", {
    method: "POST",
    headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  let message = "";
  try {
    message = String(((await response.json()) as { message?: unknown }).message ?? "");
  } catch {
    // not JSON (nginx error page)
  }
  if (response.status === 202) return message;
  if (response.status === 401 || response.status === 403) throw new FirmwareError("De server accepteert dit beheertoken niet. Log opnieuw in.");
  if (response.status === 429) throw new FirmwareError(`De spiegel heeft net opgehaald: ${message || "probeer het over een minuut opnieuw"}.`);
  if (response.status === 404 || response.status === 405)
    throw new FirmwareError("Deze Cockpit kent \u2018Nu ophalen\u2019 nog niet (nieuwer image nodig).");
  if (response.status === 502 || response.status === 503 || response.status === 504)
    throw new FirmwareError("De firmwarespiegel is niet bereikbaar (draait de service firmware-mirror, met MIRROR_TRIGGER?).");
  throw new FirmwareError(`Nu ophalen mislukt (HTTP ${response.status}).`);
}

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
