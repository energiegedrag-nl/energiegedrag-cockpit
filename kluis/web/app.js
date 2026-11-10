// SPDX-License-Identifier: EUPL-1.2
// Local vault: the shell. Screens, storage (OPFS) and the few server requests. All handling of personal data and keys
// happens in the worker (Python); this file only passes JSON along. Server requests carry no personal data:
//   GET  /api/admin/overview                        campaigns (names, ids)
//   POST /api/admin/campaigns/{id}/accounts         {count}: n new accounts, answer: account numbers + links
//   GET  /api/admin/campaigns/{id}/mail             mail settings of the campaign (enabled by the admin, helpdesk alias)
//   GET/PUT /api/admin/vaults/{kluis_id}            the vault, age-encrypted (the server cannot read it)
"use strict";

// ---- small helpers -------------------------------------------------------------------------------------------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const $ = (id) => document.getElementById(id);
const b64ToBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function bytesToB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const when = (unix) => (unix ? new Date(unix * 1000).toLocaleString("nl-NL", { dateStyle: "medium", timeStyle: "short" }) : "–");

// ---- worker ----------------------------------------------------------------------------------------------------------

let worker = null;
let seq = 0;
const pending = new Map();

function failAll(message) {
  for (const p of pending.values()) p.reject(new Error(message));
  pending.clear();
}

/** Starts the worker and shows its progress; resolves with the versions, rejects with a readable error. */
function startWorker() {
  const started = Date.now();
  const line = h("p", { class: "muted" }, "Python wordt gestart in je browser…");
  const clock = h("p", { class: "small muted" });
  const bar = h("progress", {});
  $("main").replaceChildren(line, bar, clock);
  const tick = setInterval(() => {
    const s = Math.round((Date.now() - started) / 1000);
    clock.textContent = `${s} s` + (s > 60 ? " · duurt lang: kijk in de console van de browser (F12) als er niets meer gebeurt" : "");
  }, 1000);

  worker = new Worker("worker.js", { type: "module" }); // this Pyodide only runs in a module worker
  worker.onmessage = (e) => {
    if (e.data.type === "status") {
      line.textContent = e.data.text;
      return;
    }
    const p = pending.get(e.data.id);
    pending.delete(e.data.id);
    if (p) e.data.ok ? p.resolve(e.data.result) : p.reject(new Error(e.data.error));
  };
  // An error outside a request (the script does not load, or something throws in the worker) reaches whoever waits,
  // instead of a message that never changes.
  worker.onerror = (e) => {
    e.preventDefault();
    console.error("kluis-worker:", e.message, e.filename, e.lineno);
    failAll(`Fout in de Python-worker: ${e.message || "onbekend"}${e.filename ? ` (${e.filename.split("/").pop()}:${e.lineno})` : ""}`);
  };
  worker.onmessageerror = () => failAll("Een antwoord van de Python-worker kwam niet aan.");
  const ready = py("start");
  ready.finally(() => clearInterval(tick)).catch(() => {});
  return ready;
}
function py(name, args) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, name, args });
  });
}

// ---- local storage (OPFS) --------------------------------------------------------------------------------------------
// sleutel.age  the secret key, encrypted with the passphrase (age scrypt)
// kluis.age    the vault, encrypted to all its keys (age X25519)
// kluis.json   not secret: vault id, own public key, server version, last save

async function dir() {
  return navigator.storage.getDirectory();
}
async function readFile(name) {
  try {
    const f = await (await (await dir()).getFileHandle(name)).getFile();
    return new Uint8Array(await f.arrayBuffer());
  } catch {
    return null;
  }
}
async function writeFile(name, data) {
  const handle = await (await dir()).getFileHandle(name, { create: true });
  const w = await handle.createWritable();
  await w.write(data);
  await w.close();
}
async function readMeta() {
  const raw = await readFile("kluis.json");
  return raw ? JSON.parse(new TextDecoder().decode(raw)) : null;
}
const writeMeta = (meta) => writeFile("kluis.json", new TextEncoder().encode(JSON.stringify(meta, null, 2)));

// ---- server ----------------------------------------------------------------------------------------------------------

const TOKEN_KEY = "kluis.adminToken";
const token = () => {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return state.memoryToken;
  }
};
async function api(method, path, body, headers = {}) {
  const t = token();
  if (!t) throw new Error("Geen verbinding met de server: vul eerst het beheertoken in (tab Server en back-up).");
  const isBytes = body instanceof Uint8Array;
  const r = await fetch("/api" + path, {
    method,
    headers: { Authorization: "Bearer " + t, ...(body && !isBytes ? { "Content-Type": "application/json" } : {}), ...(isBytes ? { "Content-Type": "application/octet-stream" } : {}), ...headers },
    body: body === undefined ? undefined : isBytes ? body : JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = r.statusText;
    try {
      msg = (await r.json()).message || msg;
    } catch {}
    const err = new Error(`Server: ${msg} (HTTP ${r.status})`);
    err.status = r.status;
    throw err;
  }
  return r;
}

// ---- state -----------------------------------------------------------------------------------------------------------

const state = {
  versions: null,
  info: null, // vault info from Python
  meta: null, // kluis.json
  participants: [],
  campaigns: [],
  tab: "deelnemers",
  selected: new Set(),
  dirty: false,
  savedLocal: null,
  savedServer: null,
  serverError: null,
  online: navigator.onLine,
  memoryToken: null,
  lastMails: null,
};

function status() {
  const s = $("status");
  s.replaceChildren(
    h("span", { class: "chip " + (state.versions ? "ok" : "warn") }, state.versions ? `Python ${state.versions.python} draait lokaal` : "Python start…"),
    h("span", { class: "chip " + (state.info ? "ok" : "") }, state.info ? `Kluis open · ${state.info.ontvangers.length} sleutel${state.info.ontvangers.length === 1 ? "" : "s"}` : "Kluis vergrendeld"),
    state.info && h("span", { class: "chip " + (state.dirty ? "warn" : "ok") }, state.dirty ? "Niet opgeslagen wijzigingen" : `Lokaal opgeslagen ${state.savedLocal ? when(state.savedLocal) : ""}`),
    state.info && h("span", { class: "chip " + (state.serverError ? "bad" : state.savedServer ? "ok" : "") }, state.serverError ? "Back-up op server mislukt" : state.savedServer ? `Back-up op server ${when(state.savedServer)}` : "Geen back-up op server"),
    h("span", { class: "chip " + (state.online ? "" : "warn") }, state.online ? "Online" : "Offline: lokaal werken kan"),
  );
}
window.addEventListener("online", () => ((state.online = true), status()));
window.addEventListener("offline", () => ((state.online = false), status()));

function show(...children) {
  $("main").replaceChildren(...children);
  status();
}
function errorBox(e) {
  return h("p", { class: "error", role: "alert" }, e instanceof Error ? e.message : String(e));
}
async function guarded(button, fn) {
  const box = button.closest(".panel") || $("main");
  box.querySelectorAll(".error").forEach((x) => x.remove());
  button.disabled = true;
  try {
    await fn();
  } catch (e) {
    box.append(errorBox(e));
  } finally {
    button.disabled = false;
  }
}

// ---- start -----------------------------------------------------------------------------------------------------------

// Cockpit and vault each have their own named tab. Following a link between them activates that tab if it is open,
// instead of loading the page again: leaving the vault page stops Python and locks the vault (on purpose), and
// starting again takes seconds.
const OWN_TAB = "energiegedrag-kluis";
const COCKPIT_TAB = "energiegedrag-cockpit";
function openTab(url, name) {
  const w = window.open("", name);
  if (!w) return true; // blocked: let the link do its normal work
  let fresh = false;
  try {
    fresh = w.location.href === "about:blank"; // readable only while it is a new, empty tab
  } catch {
    fresh = false; // cross-origin: the other app is already open there
  }
  if (fresh) w.location.href = url;
  w.focus();
  return false;
}

/** The Cockpit lives on another origin: config.json (from nginx, COCKPIT_URL) or derived kluis.x -> cockpit.x. */
async function cockpitLink() {
  let url = null;
  try {
    const r = await fetch("config.json", { cache: "no-cache" });
    if (r.ok) url = (await r.json()).cockpit_url || null;
  } catch {}
  if (!url && location.hostname.startsWith("kluis.")) url = `${location.protocol}//cockpit.${location.hostname.slice(6)}/`;
  const a = $("cockpit-link");
  if (url) {
    a.href = url;
    a.target = COCKPIT_TAB;
    a.onclick = (e) => {
      if (!openTab(url, COCKPIT_TAB)) e.preventDefault();
    };
    a.classList.remove("hidden");
  } else {
    a.parentElement.classList.add("hidden");
  }
}

async function boot() {
  window.name = OWN_TAB;
  window.opener = null; // opened from the Cockpit: no handle back to that page
  cockpitLink();
  $("csp").textContent = document.querySelector('meta[http-equiv="Content-Security-Policy"]').content.split("; ").join(";\n");
  try {
    const m = await (await fetch("manifest.json", { cache: "no-cache" })).json();
    $("build").replaceChildren(
      `Kluis ${m.kluis} · Pyodide ${m.pyodide} · commit `,
      h("a", { href: `${m.bron.repo}/commit/${m.bron.commit}` }, (m.bron.commit || "onbekend").slice(0, 12)),
      ` · bouw ${m.bouw} · `,
      h("a", { href: "manifest.json", target: "_blank", rel: "noopener" }, "manifest.json"),
    );
  } catch {
    $("build").textContent = "Geen manifest.json (ontwikkelversie).";
  }
  if (!("storage" in navigator) || !navigator.storage.getDirectory) {
    show(errorBox("Deze browser heeft geen lokale bestandsopslag (OPFS). Gebruik een recente Chrome, Edge of Firefox."));
    return;
  }
  navigator.storage.persist?.();
  try {
    state.versions = await startWorker();
  } catch (e) {
    show(errorBox(`Python kon niet starten: ${e.message}`));
    return;
  }
  state.meta = await readMeta();
  startScreen();
}

function startScreen() {
  const hasLocal = state.meta && state.meta.kluis_id;
  const pass = h("input", { type: "password", autocomplete: "current-password", id: "pass" });
  const open = h("button", { class: "primary", type: "button" }, "Ontgrendelen");
  open.onclick = () =>
    guarded(open, async () => {
      const key = await readFile("sleutel.age");
      if (!key) throw new Error("Op dit apparaat staat geen sleutel. Open met je herstelsleutel.");
      await py("sleutel_ontgrendelen", { bestand: bytesToB64(key), wachtwoordzin: pass.value });
      pass.value = "";
      await openLocal();
    });
  pass.addEventListener("keydown", (e) => e.key === "Enter" && open.click());

  show(
    h("div", {},
      h("h1", {}, "Lokale kluis van proefpersonen"),
      h("p", { class: "muted" }, "Hier houd je bij wie achter welk NeedForHeat-accountnummer zit, en maak je uitnodigingen. Deze gegevens blijven versleuteld op dit apparaat; de NeedForHeat-server kent alleen accountnummers."),
    ),
    h("div", { class: "grid2" },
      hasLocal &&
        h("section", { class: "panel" },
          h("h2", {}, "Kluis op dit apparaat"),
          h("p", { class: "small muted" }, `Kluis ${state.meta.kluis_id.slice(0, 8)}… · laatst opgeslagen ${when(state.meta.opgeslagen)}`),
          h("label", { for: "pass" }, "Wachtwoordzin"),
          pass,
          h("div", { class: "row" }, open),
        ),
      h("section", { class: "panel" },
        h("h2", {}, "Openen met je herstelsleutel"),
        h("p", { class: "small muted" }, "Op een nieuw apparaat, of als je de wachtwoordzin kwijt bent. De kluis komt van de server (back-up) of uit een bestand."),
        recoveryForm(),
      ),
      h("section", { class: "panel" },
        h("h2", {}, "Nieuwe kluis"),
        h("p", { class: "small muted" }, "Je maakt een eigen sleutelpaar. Alleen jij (en wie je later toevoegt) kan de kluis openen; ook de beheerder van de server niet."),
        h("button", { class: hasLocal ? "" : "primary", type: "button", onclick: newKeyScreen }, "Nieuwe kluis maken"),
        hasLocal && h("p", { class: "small notice" }, "Let op: er staat al een kluis op dit apparaat. Een nieuwe vervangt die hier (de back-up op de server blijft bestaan)."),
      ),
    ),
  );
  if (hasLocal) pass.focus();
}

function recoveryForm() {
  const key = h("textarea", { id: "herstel", placeholder: "AGE-SECRET-KEY-1…", spellcheck: "false", autocomplete: "off" });
  const file = h("input", { type: "file", accept: ".txt,.key" });
  file.onchange = async () => (key.value = await file.files[0].text());
  const id = h("input", { id: "kid", placeholder: "kluis-ID (staat op je herstelblad)", value: state.meta?.kluis_id || "" });
  const vaultFile = h("input", { type: "file", accept: ".age" });
  const tokenInput = h("input", { type: "password", placeholder: "beheertoken", autocomplete: "off" });
  const go = h("button", { class: "primary", type: "button" }, "Openen");
  go.onclick = () =>
    guarded(go, async () => {
      await py("sleutel_laden", { herstelsleutel: key.value });
      key.value = "";
      let data;
      if (vaultFile.files[0]) {
        data = new Uint8Array(await vaultFile.files[0].arrayBuffer());
      } else {
        if (tokenInput.value) setToken(tokenInput.value);
        const r = await api("GET", `/admin/vaults/${encodeURIComponent(id.value.trim())}`);
        data = new Uint8Array(await r.arrayBuffer());
        state.serverVersion = Number(r.headers.get("X-Vault-Version"));
      }
      state.info = await py("kluis_openen", { bestand: bytesToB64(data) });
      state.meta = { kluis_id: state.info.kluis_id, publieke_sleutel: state.info.eigen_sleutel, server_versie: state.serverVersion || 0, opgeslagen: null };
      await writeFile("kluis.age", data);
      await writeMeta(state.meta);
      newPassphraseScreen("Kies een wachtwoordzin voor dagelijks gebruik op dit apparaat.");
    });
  return h("div", {},
    h("label", { for: "herstel" }, "Herstelsleutel"), key, h("div", { class: "row" }, h("span", { class: "small muted" }, "of uit bestand:"), file),
    h("label", { for: "kid" }, "Kluis van de server"), id,
    !token() && tokenInput,
    h("label", {}, "…of een kluisbestand (.age)"), vaultFile,
    h("div", { class: "row" }, go),
  );
}

function setToken(t) {
  try {
    sessionStorage.setItem(TOKEN_KEY, t);
  } catch {
    state.memoryToken = t;
  }
}

// ---- new key ---------------------------------------------------------------------------------------------------------

async function newKeyScreen() {
  const key = await py("sleutel_maken");
  const confirm = h("input", { id: "bevestig", autocomplete: "off", placeholder: "laatste 6 tekens" });
  const kept = h("input", { type: "checkbox" });
  const next = h("button", { class: "primary", type: "button" }, "Verder");
  const tail = key.herstelsleutel.trim().split("\n").pop().slice(-6);
  next.onclick = () =>
    guarded(next, async () => {
      if (!kept.checked || confirm.value.trim().toUpperCase() !== tail) throw new Error("Bewaar eerst de herstelsleutel en typ ter controle de laatste 6 tekens over.");
      state.info = await py("kluis_nieuw");
      state.meta = { kluis_id: state.info.kluis_id, publieke_sleutel: key.publieke_sleutel, server_versie: 0, opgeslagen: null };
      newPassphraseScreen("Kies een wachtwoordzin voor dagelijks gebruik.");
    });
  show(
    h("h1", {}, "1. Je herstelsleutel"),
    h("section", { class: "panel" },
      h("p", {}, "Dit is de geheime sleutel van je kluis. Hij is zojuist in deze browser gemaakt en is nergens anders bekend. ",
        h("strong", {}, "Bewaar hem offline"), ": print hem of zet hem op een USB-stick in een kluis. Zonder deze sleutel (of je wachtwoordzin op dit apparaat) is de kluis niet meer te openen, ook niet door de beheerder van de server."),
      h("div", { class: "key" }, key.herstelsleutel),
      h("p", { class: "small muted" }, "Publieke sleutel (niet geheim; geef deze aan wie jou toegang tot een andere kluis wil geven): ", h("code", {}, key.publieke_sleutel)),
      h("div", { class: "row" },
        h("button", { type: "button", onclick: () => download("kluis-herstelsleutel.txt", key.herstelsleutel, "text/plain") }, "Download als bestand"),
        h("button", { type: "button", onclick: () => window.print() }, "Printen"),
      ),
      h("p", { class: "small muted" }, "Het bestand werkt ook met de standaard age-tool: ", h("code", {}, "age -d -i kluis-herstelsleutel.txt kluis.age > kluis.sqlite")),
      h("label", { class: "check" }, kept, "Ik heb de herstelsleutel offline bewaard."),
      h("label", { for: "bevestig" }, "Controle: typ de laatste 6 tekens van de sleutel"),
      confirm,
      h("div", { class: "row" }, next),
    ),
  );
}

function suggestPassphrase() {
  // 5 groups of 5 characters from a 32-letter alphabet: 125 bits. Easy to type, no similar letters.
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(25));
  return Array.from({ length: 5 }, (_, g) => Array.from(bytes.subarray(g * 5, g * 5 + 5), (b) => alphabet[b % alphabet.length]).join("")).join("-");
}

function newPassphraseScreen(intro) {
  const p1 = h("input", { type: "password", id: "p1", autocomplete: "new-password" });
  const p2 = h("input", { type: "password", id: "p2", autocomplete: "new-password" });
  const shown = h("p", { class: "key hidden" });
  const go = h("button", { class: "primary", type: "button" }, "Kluis opslaan en openen");
  go.onclick = () =>
    guarded(go, async () => {
      if (p1.value !== p2.value) throw new Error("De twee wachtwoordzinnen zijn niet gelijk.");
      go.textContent = "Sleutel versleutelen (scrypt, een paar seconden)…";
      try {
        const protectedKey = await py("sleutel_beschermen", { wachtwoordzin: p1.value });
        await writeFile("sleutel.age", b64ToBytes(protectedKey.bestand));
      } finally {
        go.textContent = "Kluis opslaan en openen";
      }
      p1.value = p2.value = "";
      state.dirty = true;
      await save();
      await mainScreen();
    });
  show(
    h("h1", {}, "2. Wachtwoordzin voor dit apparaat"),
    h("section", { class: "panel" },
      h("p", {}, intro, " Hiermee wordt je geheime sleutel op dit apparaat versleuteld (age, scrypt). Minstens 12 tekens; een zin van vier of meer woorden is sterk en goed te onthouden."),
      h("label", { for: "p1" }, "Wachtwoordzin"), p1,
      h("label", { for: "p2" }, "Nog een keer"), p2,
      h("div", { class: "row" },
        h("button", { type: "button", onclick: () => { const s = suggestPassphrase(); p1.value = p2.value = s; shown.textContent = s; shown.classList.remove("hidden"); } }, "Maak er een voor mij"),
        go,
      ),
      shown,
    ),
  );
  p1.focus();
}

// ---- open and save ---------------------------------------------------------------------------------------------------

async function openLocal() {
  const data = await readFile("kluis.age");
  if (!data) throw new Error("Geen kluis op dit apparaat.");
  state.info = await py("kluis_openen", { bestand: bytesToB64(data) });
  state.savedLocal = state.meta?.opgeslagen || null;
  await mainScreen();
}

async function save() {
  const out = await py("kluis_opslaan");
  const bytes = b64ToBytes(out.bestand);
  await writeFile("kluis.age", bytes);
  state.savedLocal = Math.floor(Date.now() / 1000);
  state.meta = { ...(state.meta || {}), kluis_id: out.kluis_id, publieke_sleutel: state.info.eigen_sleutel, opgeslagen: state.savedLocal };
  await writeMeta(state.meta);
  state.dirty = false;
  state.serverError = null;
  if (token()) {
    try {
      const r = await api("PUT", `/admin/vaults/${out.kluis_id}`, bytes, { "X-Vault-Base-Version": String(state.meta.server_versie || 0) });
      state.meta.server_versie = (await r.json()).version;
      state.savedServer = state.savedLocal;
      await writeMeta(state.meta);
    } catch (e) {
      state.serverError = e.status === 409 ? "Op de server staat een nieuwere versie (iemand anders heeft de kluis gewijzigd). Laad die eerst (tab Server en back-up)." : e.message;
    }
  }
  status();
}

async function changed(fn) {
  const result = await fn();
  state.dirty = true;
  await save();
  await refresh();
  return result;
}

async function refresh() {
  state.info = await py("info");
  state.participants = await py("deelnemers");
  for (const id of [...state.selected]) if (!state.participants.some((p) => p.id === id)) state.selected.delete(id);
  render();
}

function lock() {
  worker.terminate(); // discards the key and the database from memory
  pending.clear();
  state.info = null;
  state.participants = [];
  state.selected.clear();
  state.versions = null;
  show(h("p", { class: "muted" }, "Vergrendeld. Python wordt opnieuw gestart…"));
  startWorker().then((v) => {
    state.versions = v;
    startScreen();
  });
}

// ---- main screen -----------------------------------------------------------------------------------------------------

const TABS = [
  ["deelnemers", "Deelnemers"],
  ["uitnodigen", "Uitnodigen"],
  ["mail", "Mailen"],
  ["sleutels", "Sleutels"],
  ["server", "Server en back-up"],
  ["logboek", "Logboek"],
];

async function mainScreen() {
  await refresh();
  if (token()) loadCampaigns().catch(() => {});
}

async function loadCampaigns() {
  const overview = await (await api("GET", "/admin/overview")).json();
  state.campaigns = overview.campaigns;
  render();
}

function render() {
  const tabs = h("div", { class: "tabs", role: "tablist" },
    TABS.map(([key, label]) => h("button", { type: "button", role: "tab", "aria-selected": String(state.tab === key), onclick: () => ((state.tab = key), render()) }, label)),
    h("span", { class: "spacer" }),
    h("button", { type: "button", onclick: lock }, "Vergrendelen"),
  );
  const body = { deelnemers: participantsTab, uitnodigen: inviteTab, mail: mailTab, sleutels: keysTab, server: serverTab, logboek: logTab }[state.tab]();
  const counts = state.info.per_status;
  show(
    h("div", {},
      h("h1", {}, "Proefpersonen"),
      h("p", { class: "muted small" }, `${state.info.deelnemers} in de kluis · ${counts.nieuw || 0} nieuw · ${counts.uitgenodigd || 0} uitgenodigd · ${counts.gemaild || 0} gemaild · ${counts.gestopt || 0} gestopt`),
    ),
    tabs,
    body,
  );
}

const campaignName = (id) => state.campaigns.find((c) => c.id === id)?.name || (id ? `campagne ${id}` : "–");

function participantsTable(rows, selectable) {
  const all = h("input", { type: "checkbox", "aria-label": "Alles selecteren" });
  all.checked = rows.length > 0 && rows.every((r) => state.selected.has(r.id));
  all.onchange = () => {
    rows.forEach((r) => (all.checked ? state.selected.add(r.id) : state.selected.delete(r.id)));
    render();
  };
  return h("div", { class: "table-wrap" },
    h("table", {},
      h("thead", {}, h("tr", {}, selectable && h("th", {}, all), h("th", {}, "#"), h("th", {}, "Naam"), h("th", {}, "E-mail"), h("th", {}, "Telefoon"), h("th", {}, "Plaats"), h("th", {}, "Campagne"), h("th", {}, "Account"), h("th", {}, "Status"), h("th", {}, ""))),
      h("tbody", {},
        rows.map((p) => {
          const box = h("input", { type: "checkbox", "aria-label": `Selecteer ${p.naam}` });
          box.checked = state.selected.has(p.id);
          box.onchange = () => (box.checked ? state.selected.add(p.id) : state.selected.delete(p.id));
          return h("tr", {},
            selectable && h("td", { class: "sel" }, box),
            h("td", {}, p.id), h("td", {}, p.naam), h("td", {}, p.email), h("td", {}, p.telefoon), h("td", {}, p.plaats),
            h("td", {}, campaignName(p.campagne_id)), h("td", { class: "mono" }, p.account_id || "–"),
            h("td", {}, h("span", { class: `st st-${p.status}` }, p.status)),
            h("td", {}, h("button", { type: "button", class: "link", onclick: () => editDialog(p) }, "Bewerken")),
          );
        }),
      ),
    ),
  );
}

function participantsTab() {
  const fields = ["naam", "email", "telefoon", "adres", "postcode", "plaats", "notities"];
  const inputs = Object.fromEntries(fields.map((f) => [f, h("input", { id: "n-" + f, autocomplete: "off" })]));
  const add = h("button", { class: "primary", type: "button" }, "Toevoegen");
  add.onclick = () => guarded(add, () => changed(() => py("toevoegen", { velden: Object.fromEntries(fields.map((f) => [f, inputs[f].value])) })));
  const csvFile = h("input", { type: "file", accept: ".csv,.txt" });
  const imp = h("button", { type: "button" }, "Importeren");
  imp.onclick = () =>
    guarded(imp, async () => {
      if (!csvFile.files[0]) throw new Error("Kies eerst een CSV-bestand.");
      const r = await changed(async () => py("importeer_csv", { tekst: await csvFile.files[0].text() }));
      imp.closest(".panel").append(h("p", { class: "success" }, `${r.toegevoegd} toegevoegd, ${r.overgeslagen} overgeslagen (dubbel of leeg).`));
    });
  return h("div", {},
    participantsTable(state.participants, true),
    h("div", { class: "grid2 gap-top" },
      h("section", { class: "panel" }, h("h2", {}, "Proefpersoon toevoegen"),
        fields.map((f) => [h("label", { for: "n-" + f }, f[0].toUpperCase() + f.slice(1)), inputs[f]]), h("div", { class: "row" }, add)),
      h("section", { class: "panel" }, h("h2", {}, "Lijst importeren of exporteren"),
        h("p", { class: "small muted" }, "CSV met een kopregel, gescheiden door komma of puntkomma. Kolommen: naam, email, telefoon, adres, postcode, plaats, apparaat, notities. Dubbele e-mailadressen worden overgeslagen."),
        csvFile, h("div", { class: "row" }, imp),
        h("p", { class: "small notice" }, "Een export is onversleuteld. Bewaar hem alleen waar je ook andere persoonsgegevens van het onderzoek bewaart, en verwijder hem daarna."),
        h("div", { class: "row" }, h("button", { type: "button", onclick: async () => download("proefpersonen.csv", (await py("exporteer_csv")).tekst, "text/csv") }, "Exporteren als CSV")),
      ),
    ),
  );
}

function editDialog(p) {
  const fields = ["naam", "email", "telefoon", "adres", "postcode", "plaats", "apparaat", "notities"];
  const inputs = Object.fromEntries(fields.map((f) => [f, h("input", { id: "e-" + f, value: p[f] || "" })]));
  const saveBtn = h("button", { class: "primary", type: "button" }, "Opslaan");
  saveBtn.onclick = () => guarded(saveBtn, async () => { await changed(() => py("wijzigen", { id: p.id, velden: Object.fromEntries(fields.map((f) => [f, inputs[f].value])) })); });
  const del = h("button", { class: "danger", type: "button" }, p.account_id ? "Markeer als gestopt" : "Verwijderen");
  del.onclick = () => guarded(del, () => changed(() => (p.account_id ? py("stoppen", { id: p.id }) : py("verwijderen", { id: p.id }))));
  show(
    h("h1", {}, `Proefpersoon ${p.id}`),
    h("section", { class: "panel" },
      p.account_id && h("p", { class: "small muted" }, `NeedForHeat-account ${p.account_id} in ${campaignName(p.campagne_id)} · uitgenodigd ${when(p.uitgenodigd_op)} · gemaild ${when(p.gemaild_op)}`),
      fields.map((f) => [h("label", { for: "e-" + f }, f[0].toUpperCase() + f.slice(1)), inputs[f]]),
      h("div", { class: "row" }, saveBtn, del, h("button", { type: "button", onclick: render }, "Terug")),
    ),
  );
}

function campaignSelect(id) {
  return h("select", { id }, h("option", { value: "" }, state.campaigns.length ? "Kies een campagne…" : "Geen campagnes (vul het beheertoken in)"),
    state.campaigns.filter((c) => c.state !== "ended").map((c) => h("option", { value: c.id }, c.name)));
}

function inviteTab() {
  const candidates = state.participants.filter((p) => !p.account_id && !p.gestopt_op);
  const chosen = candidates.filter((p) => state.selected.has(p.id));
  const select = campaignSelect("camp");
  const go = h("button", { class: "primary", type: "button", disabled: chosen.length === 0 }, `Maak ${chosen.length} uitnodiging${chosen.length === 1 ? "" : "en"}`);
  go.onclick = () =>
    guarded(go, async () => {
      const campaign = Number(select.value);
      if (!campaign) throw new Error("Kies een campagne.");
      // Only the number goes to the server. The answer (account numbers and links) is linked to the people here.
      const invitations = await (await api("POST", `/admin/campaigns/${campaign}/accounts`, { count: chosen.length })).json();
      await changed(() => py("uitnodigingen_vastleggen", {
        campagne_id: campaign,
        uitnodigingen: invitations.map((inv, i) => ({ deelnemer_id: chosen[i].id, account_id: inv.account_id, url: inv.invitation_url })),
      }));
      state.selected.clear();
      state.tab = "mail";
      render();
    });
  return h("div", { class: "grid2" },
    h("section", { class: "panel" },
      h("h2", {}, "Uitnodigingen maken"),
      h("p", {}, "Selecteer op de tab Deelnemers wie je wilt uitnodigen. De server maakt dan evenveel nieuwe accounts en geeft accountnummers en persoonlijke links terug; ", h("strong", {}, "de server krijgt alleen het aantal"), ". De koppeling tussen persoon en accountnummer bestaat alleen in deze kluis."),
      h("p", { class: "small muted" }, `${chosen.length} geselecteerd van ${candidates.length} nog niet uitgenodigde proefpersonen.`),
      h("label", { for: "camp" }, "Campagne"), select,
      h("div", { class: "row" }, go),
    ),
    h("section", { class: "panel" }, h("h2", {}, "Geselecteerd"), chosen.length ? h("ul", {}, chosen.map((p) => h("li", {}, `${p.naam} `, h("span", { class: "muted small" }, p.email)))) : h("p", { class: "muted" }, "Niemand.")),
  );
}

function mailTab() {
  const invited = state.participants.filter((p) => p.account_id && p.email && !p.gestopt_op);
  const camps = [...new Set(invited.map((p) => p.campagne_id))];
  const select = h("select", { id: "mcamp" }, camps.map((c) => h("option", { value: c }, campaignName(c))));
  const onlyNew = h("input", { type: "checkbox", checked: true });
  const t = state.info.sjabloon;
  const subject = h("input", { id: "ond", value: t.onderwerp });
  const text = h("textarea", { id: "tekst", rows: 12 }, t.tekst);
  const sender = h("input", { id: "afz", value: t.afzender, placeholder: "bijv. het onderzoeksteam van …" });
  const reply = h("input", { id: "antw", value: t.antwoordadres, placeholder: "adres voor vragen" });
  const settingsBox = h("div", {});
  const out = h("div", {});

  const ids = () => invited.filter((p) => String(p.campagne_id) === select.value && (!onlyNew.checked || !p.gemaild_op)).map((p) => p.id);
  let mailSettings = null;
  async function loadSettings() {
    mailSettings = null;
    settingsBox.replaceChildren();
    if (!select.value || !token()) return;
    try {
      mailSettings = await (await api("GET", `/admin/campaigns/${select.value}/mail`)).json();
    } catch {
      return;
    }
    settingsBox.replaceChildren(
      mailSettings.enabled
        ? h("p", { class: "notice small" }, "De beheerder heeft de mailfaciliteit van energiegedrag.nl voor deze campagne aangezet", mailSettings.helpdesk_alias ? [" met helpdeskadres ", h("code", {}, mailSettings.helpdesk_alias)] : "", ". Versturen vanaf de server komt in een volgende versie; gebruik voorlopig je eigen mailprogramma. Het helpdeskadres wordt al in de mails gezet.")
        : h("p", { class: "small muted" }, "De mailfaciliteit van energiegedrag.nl staat voor deze campagne uit (de beheerder zet hem per campagne aan). Je verstuurt met je eigen mailprogramma; daarvoor zijn geen wachtwoorden in de Cockpit nodig."),
    );
  }
  select.onchange = loadSettings;
  loadSettings();
  const helpdesk = () => mailSettings?.enabled && mailSettings.helpdesk_alias ? mailSettings.helpdesk_alias : reply.value;

  const saveTemplate = () => py("sjabloon_opslaan", { onderwerp: subject.value, tekst: text.value, afzender: sender.value, antwoordadres: reply.value });
  const mk = (label, fn) => {
    const b = h("button", { type: "button" }, label);
    b.onclick = () => guarded(b, async () => { await saveTemplate(); state.dirty = true; await fn(); });
    return b;
  };
  const campaign = () => campaignName(Number(select.value));

  return h("div", { class: "grid2" },
    h("section", { class: "panel" },
      h("h2", {}, "Tekst"),
      h("p", { class: "small muted" }, "Invulvelden: ${naam}, ${campagne}, ${link}, ${helpdesk}, ${afzender}, ${account}."),
      h("label", { for: "ond" }, "Onderwerp"), subject,
      h("label", { for: "tekst" }, "Tekst"), text,
      h("label", { for: "afz" }, "Afzender (ondertekening)"), sender,
      h("label", { for: "antw" }, "Adres voor vragen"), reply,
    ),
    h("section", { class: "panel" },
      h("h2", {}, "Versturen met je eigen mailprogramma"),
      invited.length === 0 ? h("p", { class: "muted" }, "Nog niemand uitgenodigd met een e-mailadres.") : [
        h("label", { for: "mcamp" }, "Campagne"), select,
        h("label", { class: "check" }, onlyNew, "Alleen wie nog niet gemaild is"),
        settingsBox,
        h("div", { class: "row" },
          mk("Links per persoon", async () => {
            const mails = await py("mails", { ids: ids(), campagne: campaign(), helpdesk: helpdesk() });
            out.replaceChildren(h("ul", { class: "mail-list" }, mails.map((m) => {
              const mark = h("button", { type: "button", class: "link" }, "gemaild");
              mark.onclick = () => guarded(mark, () => changed(() => py("gemaild", { ids: [m.id], hoe: "mailto" })));
              return h("li", {}, h("a", { class: "button", href: m.mailto }, `Mail ${m.naam || m.email}`), h("span", { class: "small muted" }, m.email), mark);
            })));
          }),
          mk("Concepten (.eml) downloaden", async () => {
            const z = await py("eml_zip", { ids: ids(), campagne: campaign(), helpdesk: helpdesk() });
            download("uitnodigingen.zip", b64ToBytes(z.bestand), "application/zip");
            const mark = h("button", { type: "button" }, `Markeer ${z.aantal} als gemaild`);
            mark.onclick = () => guarded(mark, () => changed(() => py("gemaild", { ids: ids(), hoe: "eml" })));
            out.replaceChildren(h("p", { class: "small" }, `${z.aantal} concepten. Open ze in Outlook of Thunderbird en verstuur ze. Verwijder de zip daarna: hij is niet versleuteld.`), mark);
          }),
          mk("Samenvoeg-CSV", async () => {
            const c = await py("samenvoeg_csv", { ids: ids(), campagne: campaign(), helpdesk: helpdesk() });
            download("samenvoegen.csv", c.tekst, "text/csv");
            out.replaceChildren(h("p", { class: "small" }, "Voor afdruk samenvoegen in Word/Outlook of je eigen mailtool. Verwijder het bestand daarna: het is niet versleuteld."));
          }),
        ),
        out,
      ],
    ),
  );
}

function keysTab() {
  const add = h("input", { id: "nieuwe", placeholder: "age1…" });
  const addBtn = h("button", { type: "button" }, "Toevoegen");
  addBtn.onclick = () => guarded(addBtn, () => changed(() => py("ontvanger_toevoegen", { publieke_sleutel: add.value })));
  return h("div", { class: "grid2" },
    h("section", { class: "panel" },
      h("h2", {}, "Wie deze kluis kan openen"),
      h("ul", { class: "mail-list" }, state.info.ontvangers.map((r) => h("li", {}, h("code", { class: "small" }, r),
        r === state.info.eigen_sleutel ? h("span", { class: "small muted" }, "(jij)") : h("button", { type: "button", class: "link", onclick: (e) => guarded(e.target, () => changed(() => py("ontvanger_verwijderen", { publieke_sleutel: r }))) }, "verwijderen")))),
      h("p", { class: "small muted" }, "Na verwijderen kan die sleutel nieuwe versies niet meer openen, maar oudere kopieën die hij al had wel. Verwijder dus ook back-ups die hij kon lezen als dat nodig is."),
      h("label", { for: "nieuwe" }, "Collega toegang geven (zijn of haar publieke sleutel)"), add, h("div", { class: "row" }, addBtn),
    ),
    h("section", { class: "panel" },
      h("h2", {}, "Je eigen sleutel"),
      h("p", { class: "small" }, "Publieke sleutel: ", h("code", {}, state.info.eigen_sleutel)),
      h("p", { class: "small muted" }, `Kluis-ID: ${state.info.kluis_id} (zet dit bij je herstelsleutel: daarmee haal je de back-up van de server).`),
      h("div", { class: "row" },
        h("button", { type: "button", onclick: async () => download("kluis.age", await readFile("kluis.age"), "application/octet-stream") }, "Versleutelde kluis downloaden (.age)"),
        h("button", { type: "button", onclick: () => newPassphraseScreen("Kies een nieuwe wachtwoordzin.") }, "Wachtwoordzin wijzigen"),
      ),
    ),
  );
}

function serverTab() {
  const tokenInput = h("input", { type: "password", id: "tok", autocomplete: "off", placeholder: token() ? "ingevuld" : "beheertoken" });
  const connect = h("button", { type: "button", class: "primary" }, "Verbinden");
  connect.onclick = () => guarded(connect, async () => { setToken(tokenInput.value); await loadCampaigns(); await save(); });
  const pull = h("button", { type: "button", class: "danger" }, "Serverversie laden (lokale wijzigingen vervallen)");
  pull.onclick = () =>
    guarded(pull, async () => {
      const r = await api("GET", `/admin/vaults/${state.info.kluis_id}`);
      const data = new Uint8Array(await r.arrayBuffer());
      state.info = await py("kluis_openen", { bestand: bytesToB64(data) });
      await writeFile("kluis.age", data);
      state.meta.server_versie = Number(r.headers.get("X-Vault-Version"));
      await writeMeta(state.meta);
      state.serverError = null;
      await refresh();
    });
  return h("div", { class: "grid2" },
    h("section", { class: "panel" },
      h("h2", {}, "Server"),
      h("p", { class: "small muted" }, "Voor campagnes, uitnodigingen en de back-up. Het token blijft alleen in dit tabblad (sessionStorage van deze kluispagina; de Cockpit-pagina kan er niet bij)."),
      h("label", { for: "tok" }, "Beheertoken"), tokenInput, h("div", { class: "row" }, connect),
      state.serverError && h("p", { class: "error" }, state.serverError),
    ),
    h("section", { class: "panel" },
      h("h2", {}, "Back-up op de server"),
      h("p", { class: "small" }, "Na elke wijziging gaat de versleutelde kluis naar de server (de laatste versies worden bewaard). De server ziet alleen de grootte en het tijdstip; openen kan alleen met een van de sleutels hierboven."),
      h("p", { class: "small muted" }, `Serverversie ${state.meta?.server_versie || "–"}. Werken twee mensen tegelijk, dan weigert de server de tweede opslag; laad dan de serverversie en doe de wijziging opnieuw.`),
      h("div", { class: "row" }, pull),
    ),
  );
}

function logTab() {
  const box = h("div", {}, h("p", { class: "muted" }, "Laden…"));
  py("logboek").then((rows) => box.replaceChildren(h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {}, h("th", {}, "Wanneer"), h("th", {}, "Proefpersoon"), h("th", {}, "Wat"), h("th", {}, "Details"))),
    h("tbody", {}, rows.map((r) => h("tr", {}, h("td", {}, when(r.op)), h("td", {}, r.deelnemer_id ?? ""), h("td", {}, r.actie), h("td", { class: "small muted" }, r.details))))))));
  return h("section", { class: "panel" }, h("h2", {}, "Logboek (in de kluis)"), box);
}

boot();
