import type {
  CampaignMail,
  CampaignStatus,
  CampaignUpdate,
  Campaign,
  FlashReport,
  InventoryChange,
  InventoryDevice,
  Invitation,
  NewCampaign,
  Overview,
} from "./types";

// The Cockpit talks to needforheat-server-api through `/api` on its own origin (nginx or the Vite dev server proxies it).
const BASE = "/api";

// The local vault with participant data runs on its own origin (docs/26), so this page cannot reach its storage.
export const KLUIS_URL: string = import.meta.env.VITE_KLUIS_URL ?? "https://kluis.energiegedrag.nl/";
const TOKEN_KEY = "cockpit.adminToken";

// The admin token lives in sessionStorage only: it is gone when the tab closes (design docs/22, phase 1).
export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage blocked: the token then lasts until the page reloads.
  }
  memoryToken = token;
}

let memoryToken: string | null = null;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, token = getToken() ?? memoryToken): Promise<T> {
  const response = await fetch(BASE + path, {
    method,
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const message =
      typeof data === "object" && data !== null && "message" in data ? String((data as { message: unknown }).message) : response.statusText;
    throw new ApiError(response.status, message || `HTTP ${response.status}`);
  }
  return data as T;
}

export const api = {
  overview: (token?: string) => request<Overview>("GET", "/admin/overview", undefined, token),
  campaignStatus: (id: number) => request<CampaignStatus>("GET", `/admin/campaigns/${id}/status`),
  updateCampaign: (id: number, update: CampaignUpdate) => request<Campaign>("PATCH", `/admin/campaigns/${id}`, update),
  createCampaign: (campaign: NewCampaign) => request<{ id: number }>("POST", "/campaign", campaign),
  invite: (campaignId: number, count: number) => request<Invitation[]>("POST", `/admin/campaigns/${campaignId}/accounts`, { count }),
  newInvitation: (accountId: number) => request<Invitation>("POST", `/admin/accounts/${accountId}/invitation`),
  campaignMail: (id: number) => request<CampaignMail>("GET", `/admin/campaigns/${id}/mail`),
  setCampaignMail: (id: number, m: CampaignMail) => request<CampaignMail>("PUT", `/admin/campaigns/${id}/mail`, m),
  inventory: () => request<InventoryDevice[]>("GET", "/admin/inventory"),
  inventoryDevice: (id: number) => request<InventoryDevice>("GET", `/admin/inventory/${id}`),
  inventoryByMac: (mac: string) => request<InventoryDevice>("GET", `/admin/inventory/mac/${mac.replace(/:/g, "")}`),
  recordFlash: (report: FlashReport) => request<InventoryDevice>("POST", "/admin/inventory/flash", report),
  inventoryEvent: (id: number, change: InventoryChange) => request<InventoryDevice>("POST", `/admin/inventory/${id}/events`, change),
};

export function explain(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) return "De server accepteert dit beheertoken niet. Log opnieuw in met een geldig token.";
    if (error.status === 404) return "Niet gevonden. Misschien is het onderdeel verwijderd.";
    if (error.status === 502 || error.status === 503 || error.status === 504) return "De server-API is niet bereikbaar. Probeer het later opnieuw.";
    return `De server meldt: ${error.message} (HTTP ${error.status}).`;
  }
  if (error instanceof TypeError) return "Geen verbinding met de server. Controleer je netwerk of WireGuard.";
  return error instanceof Error ? error.message : String(error);
}
