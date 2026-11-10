// SPDX-License-Identifier: EUPL-1.2
import type { AccountState, CampaignState, SourceState } from "./types";

export const campaignStateLabel: Record<CampaignState, string> = {
  planned: "Gepland",
  running: "Loopt",
  ended: "Afgelopen",
};

export const accountStateLabel: Record<AccountState, string> = {
  invited: "Uitgenodigd",
  active: "Actief",
  incomplete: "Onvolledig",
  attention: "Aandacht nodig",
};

export const sourceStateLabel: Record<SourceState, string> = {
  missing: "Niet gekoppeld",
  waiting: "Wacht op eerste data",
  ok: "Op tijd",
  late: "Te laat",
};

export const categoryLabel: Record<string, string> = {
  device_type: "Meetapparaat",
  energy_query_type: "Vragenlijst",
  cloud_feed_type: "Cloudkoppeling",
};

const dateFormat = new Intl.DateTimeFormat("nl-NL", { day: "numeric", month: "short", year: "numeric" });
const dateTimeFormat = new Intl.DateTimeFormat("nl-NL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function formatDate(unix: number | null | undefined): string {
  return unix ? dateFormat.format(new Date(unix * 1000)) : "–";
}

export function formatDateTime(unix: number | null | undefined): string {
  return unix ? dateTimeFormat.format(new Date(unix * 1000)) : "–";
}

/** "5 min geleden", "3 uur geleden", "2 dagen geleden"; "–" without a time. */
export function ago(unix: number | null | undefined, now: number = Date.now() / 1000): string {
  if (!unix) return "–";
  const s = Math.max(0, Math.round(now - unix));
  if (s < 90) return "zojuist";
  const min = Math.round(s / 60);
  if (min < 90) return `${min} min geleden`;
  const hours = Math.round(s / 3600);
  if (hours < 36) return `${hours} uur geleden`;
  const days = Math.round(s / 86400);
  return days === 1 ? "1 dag geleden" : `${days} dagen geleden`;
}

/** ISO 8601 duration ("P1D", "PT12H") in words; the raw text if it cannot be read. */
export function durationLabel(iso: string): string {
  if (!iso) return "geen";
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(iso);
  if (!m || iso === "P" || iso === "PT") return iso;
  const parts: string[] = [];
  if (m[1]) parts.push(m[1] === "1" ? "1 dag" : `${m[1]} dagen`);
  if (m[2]) parts.push(`${m[2]} uur`);
  if (m[3]) parts.push(`${m[3]} min`);
  return parts.join(" ");
}

/** Value for <input type="date"> from Unix seconds (local date). */
export function toDateInput(unix: number | null | undefined): string {
  if (!unix) return "";
  const d = new Date(unix * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Unix seconds of local midnight of an <input type="date"> value; undefined when empty or invalid. */
export function fromDateInput(value: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? undefined : Math.floor(d.getTime() / 1000);
}
