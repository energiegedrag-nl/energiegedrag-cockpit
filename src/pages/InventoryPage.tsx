// SPDX-License-Identifier: EUPL-1.2
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, explain } from "../api";
import { ago, firmwareLabel, formatDateTime, inventoryEventLabel, inventoryStateLabel } from "../format";
import type { InventoryChange, InventoryDevice, InventoryState } from "../types";

const STATES: InventoryState[] = ["flashed", "assigned", "shipped", "returned", "erased"];

export function InventoryPage() {
  const inventory = useQuery({ queryKey: ["inventory"], queryFn: api.inventory });
  const [filter, setFilter] = useState<InventoryState | "in_use" | null>(null);

  if (inventory.isPending) return <p className="muted">Voorraad laden…</p>;
  if (inventory.isError) return <p className="error" role="alert">{explain(inventory.error)}</p>;

  const devices = inventory.data;
  const count = (s: InventoryState) => devices.filter((d) => d.state === s).length;
  const inUse = devices.filter((d) => d.in_use).length;
  const shown = devices.filter((d) => filter === null || (filter === "in_use" ? d.in_use : d.state === filter));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Voorraad</h1>
          <p className="muted">
            {devices.length} apparaat{devices.length === 1 ? "" : "en"} geflasht op het flashstation, waarvan {inUse} in gebruik door een deelnemer.
          </p>
        </div>
        <a className="button primary" href="#/flashstation">
          Flashstation
        </a>
      </div>

      <div className="chips" role="group" aria-label="Filter op status">
        <button type="button" className="chip" aria-pressed={filter === null} onClick={() => setFilter(null)}>
          Alle <span className="chip-count">{devices.length}</span>
        </button>
        <button type="button" className="chip account-active" aria-pressed={filter === "in_use"} onClick={() => setFilter(filter === "in_use" ? null : "in_use")}>
          In gebruik <span className="chip-count">{inUse}</span>
        </button>
        {STATES.map((s) => (
          <button key={s} type="button" className={`chip inv-${s}`} aria-pressed={filter === s} onClick={() => setFilter(filter === s ? null : s)}>
            {inventoryStateLabel[s]} <span className="chip-count">{count(s)}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="muted">Geen apparaten{filter ? " met deze status" : ""}.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Naam</th>
                <th>Firmware</th>
                <th>Status</th>
                <th>Deelnemer</th>
                <th>Gewijzigd</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((d) => (
                <tr key={d.id}>
                  <td>
                    <a href={`#/voorraad/${d.id}`}>#{d.id}</a>
                  </td>
                  <td>
                    <span className="mono">{d.name || "–"}</span>
                    <div className="muted small mono">{d.mac}</div>
                  </td>
                  <td>
                    {firmwareLabel(d.firmware)}
                    <div className="muted small">{d.firmware_version}</div>
                  </td>
                  <td>
                    <span className={`pill inv-${d.state}`}>{inventoryStateLabel[d.state]}</span>
                    {d.in_use && <span className="pill account-active">in gebruik</span>}
                  </td>
                  <td>{participant(d)}</td>
                  <td className="nowrap" title={formatDateTime(d.updated_at)}>
                    {ago(d.updated_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ReleaseByName />
    </>
  );
}

/** For devices that are not in the inventory (flashed before it existed, or with another tool). */
function ReleaseByName() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [confirm, setConfirm] = useState(false);
  const release = useMutation({
    mutationFn: () => api.releaseDevice(name.trim().toUpperCase(), "vrijgegeven op naam in de Cockpit"),
    onSuccess: () => {
      setConfirm(false);
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
  const valid = /^[0-9A-F]{4}-[0-9A-F]{6}$/.test(name.trim().toUpperCase());
  return (
    <section className="panel">
      <h2>Apparaat vrijgeven op naam</h2>
      <p className="hint">
        Voor een apparaat dat niet in de voorraad staat. Vrijgeven ontkoppelt het van de deelnemer: de metingen blijven bij die deelnemer,
        de naam komt vrij voor een andere deelnemer. Reset daarna het apparaat (wifi-reset of volledig wissen) voordat je het opnieuw koppelt.
      </p>
      {release.isError && (
        <p className="error" role="alert">
          {explain(release.error)}
        </p>
      )}
      {release.isSuccess && <p className="ok-text">Vrijgegeven: {release.data.released}.</p>}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) setConfirm(true);
        }}
      >
        <div>
          <label htmlFor="release-name">Apparaatnaam</label>
          <input
            id="release-name"
            className="mono"
            placeholder="FE2E-979798"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setConfirm(false);
              release.reset();
            }}
          />
        </div>
        {!confirm ? (
          <button type="submit" disabled={!valid}>
            Vrijgeven…
          </button>
        ) : (
          <>
            <button type="button" className="danger" onClick={() => release.mutate()} disabled={release.isPending}>
              Ja, {name.trim().toUpperCase()} vrijgeven
            </button>
            <button type="button" onClick={() => setConfirm(false)}>
              Annuleren
            </button>
          </>
        )}
      </form>
    </section>
  );
}

function participant(d: InventoryDevice) {
  if (d.in_use) {
    return (
      <a href={`#/campagne/${d.in_use.campaign_id}`} title="Geactiveerd door de app">
        {d.in_use.account_id}
      </a>
    );
  }
  return d.account_id ?? <span className="muted">–</span>;
}

export function InventoryDevicePage({ id }: { id: number }) {
  const queryClient = useQueryClient();
  const device = useQuery({ queryKey: ["inventory", id], queryFn: () => api.inventoryDevice(id) });
  const [accountId, setAccountId] = useState("");
  const [note, setNote] = useState("");
  const [confirmRelease, setConfirmRelease] = useState(false);
  const change = useMutation({
    mutationFn: (c: InventoryChange) => api.inventoryEvent(id, c),
    onSuccess: (d) => {
      queryClient.setQueryData(["inventory", id], d);
      queryClient.invalidateQueries({ queryKey: ["inventory"], exact: true });
      setNote("");
      setConfirmRelease(false);
    },
  });

  if (device.isPending) return <p className="muted">Apparaat laden…</p>;
  if (device.isError) return <p className="error" role="alert">{explain(device.error)}</p>;
  const d = device.data;
  const can = (s: InventoryState[]) => s.includes(d.state) && !change.isPending;
  // The participant the device belongs to: assigned in the inventory, or else the account that activated it.
  const owner = d.account_id ?? d.in_use?.account_id ?? null;
  const canShipBack = d.state === "returned" && d.account_id !== null && !change.isPending;
  const canRelease = can(["flashed", "assigned", "returned", "erased"]) && (d.in_use !== null || d.account_id !== null);

  return (
    <>
      <a className="back" href="#/voorraad">
        ← Voorraad
      </a>
      <div className="page-head">
        <div>
          <h1>
            Apparaat #{d.id} <span className={`pill inv-${d.state}`}>{inventoryStateLabel[d.state]}</span>
            {d.in_use && <span className="pill account-active">in gebruik</span>}
          </h1>
          <p className="muted">
            <span className="mono">{d.name || "naam onbekend"}</span> · <span className="mono">{d.mac}</span> · {d.chip}
          </p>
        </div>
      </div>

      {change.isError && (
        <p className="error" role="alert">
          {explain(change.error)}
        </p>
      )}

      <section className="two-col">
        <div className="panel">
          <h2>Gegevens</h2>
          <dl className="facts">
            <dt>Firmware</dt>
            <dd>
              {firmwareLabel(d.firmware)} {d.firmware_version}
            </dd>
            <dt>Apparaattype</dt>
            <dd className="mono small">{d.device_type || "–"}</dd>
            <dt>Toegewezen aan</dt>
            <dd>{d.account_id ? `deelnemer ${d.account_id}` : "–"}</dd>
            <dt>In gebruik</dt>
            <dd>
              {d.in_use ? (
                <>
                  deelnemer {d.in_use.account_id} in <a href={`#/campagne/${d.in_use.campaign_id}`}>campagne {d.in_use.campaign_id}</a>
                  {d.in_use.activated_at && <span className="muted small"> · geactiveerd {formatDateTime(d.in_use.activated_at)}</span>}
                </>
              ) : (
                "nee"
              )}
            </dd>
            {d.note && (
              <>
                <dt>Notitie</dt>
                <dd>{d.note}</dd>
              </>
            )}
          </dl>
        </div>

        <div className="panel">
          <h2>Acties</h2>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number(accountId);
              if (Number.isInteger(n) && n > 0) change.mutate({ event: "assign", account_id: n });
            }}
          >
            <div>
              <label htmlFor="account">Toewijzen aan deelnemer (accountnummer)</label>
              <input id="account" inputMode="numeric" pattern="[0-9]+" value={accountId} onChange={(e) => setAccountId(e.target.value)} />
            </div>
            <button type="submit" disabled={!can(["flashed", "assigned"]) || !accountId}>
              Toewijzen
            </button>
          </form>
          <div className="row actions">
            <button type="button" disabled={!can(["assigned"])} onClick={() => change.mutate({ event: "ship" })}>
              Uitgegeven
            </button>
            <button
              type="button"
              disabled={!can(["assigned", "shipped"])}
              onClick={() => change.mutate({ event: "return", details: "ingenomen in het lab" })}
              title="Het apparaat is terug in het lab en blijft van deze deelnemer (bijv. voor reparatie)"
            >
              Innemen
            </button>
            <button
              type="button"
              disabled={!canShipBack}
              onClick={() => change.mutate({ event: "ship", details: "teruggestuurd na reparatie" })}
            >
              Terugsturen{d.state === "returned" && d.account_id ? ` naar deelnemer ${d.account_id}` : ""}
            </button>
            <button type="button" className="danger" disabled={!canRelease || confirmRelease} onClick={() => setConfirmRelease(true)}>
              Vrijgeven…
            </button>
          </div>
          {confirmRelease && (
            <div className="warning">
              <p>
                Vrijgeven voor een andere deelnemer? De koppeling met deelnemer {owner ?? "?"} verdwijnt: de metingen blijven bij die deelnemer,
                de server weigert nieuwe metingen met de oude koppeling (410), en de naam <span className="mono">{d.name}</span> komt vrij.
                Reset het apparaat (wifi-reset of volledig wissen op het flashstation) voordat de volgende deelnemer het koppelt.
              </p>
              <div className="row">
                <button
                  type="button"
                  className="danger"
                  disabled={change.isPending}
                  onClick={() => change.mutate({ event: "release", details: `vrijgegeven; was van deelnemer ${owner ?? "?"}` })}
                >
                  Ja, vrijgeven
                </button>
                <button type="button" onClick={() => setConfirmRelease(false)}>
                  Annuleren
                </button>
              </div>
            </div>
          )}
          <p className="hint">
            <strong>Innemen</strong>: terug in het lab, blijft van de deelnemer; daarna <strong>Terugsturen</strong> na reparatie, of{" "}
            <strong>Vrijgeven</strong> voor een andere deelnemer. Een uitgegeven apparaat neem je eerst in. Wissen en opnieuw flashen doe je op
            het <a href="#/flashstation">flashstation</a> met het apparaat aangesloten.
          </p>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (note.trim()) change.mutate({ event: "note", details: note.trim() });
            }}
          >
            <div>
              <label htmlFor="note">Notitie</label>
              <input id="note" maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="bijv. behuizing beschadigd" />
            </div>
            <button type="submit" disabled={!note.trim() || change.isPending}>
              Opslaan
            </button>
          </form>
        </div>
      </section>

      <section className="panel">
        <h2>Historie</h2>
        <ol className="history">
          {(d.events ?? []).map((e) => (
            <li key={e.id}>
              <span className="nowrap muted small">{formatDateTime(e.at)}</span> <strong>{inventoryEventLabel[e.event]}</strong>
              {e.account_id ? <span> · deelnemer {e.account_id}</span> : null}
              {e.details && <span className="muted"> · {e.details}</span>}
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
