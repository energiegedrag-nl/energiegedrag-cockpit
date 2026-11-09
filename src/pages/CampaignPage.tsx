import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, explain } from "../api";
import {
  accountStateLabel,
  ago,
  campaignStateLabel,
  categoryLabel,
  durationLabel,
  formatDate,
  formatDateTime,
  fromDateInput,
  sourceStateLabel,
  toDateInput,
} from "../format";
import type { AccountState, AccountStatus, Campaign, CampaignStatus, Invitation, Source, SourceStatus } from "../types";
import { InvitationCards } from "./Invitations";

const FILTERS: (AccountState | "all")[] = ["all", "attention", "incomplete", "invited", "active"];

export function CampaignPage({ id }: { id: number }) {
  const status = useQuery({ queryKey: ["campaign", id], queryFn: () => api.campaignStatus(id) });
  const [filter, setFilter] = useState<AccountState | "all">("all");

  if (status.isPending) return <p className="muted">Campagne laden…</p>;
  if (status.isError)
    return (
      <>
        <p className="error" role="alert">{explain(status.error)}</p>
        <a href="#/">Terug naar de campagnes</a>
      </>
    );

  const data = status.data;
  const c = data.campaign;
  const shown = filter === "all" ? data.accounts : data.accounts.filter((a) => a.state === filter);

  return (
    <>
      <a href="#/" className="back">
        ← Campagnes
      </a>
      <div className="page-head">
        <div>
          <h1>
            {c.name} <span className={`pill campaign-${c.state}`}>{campaignStateLabel[c.state]}</span>
          </h1>
          <p className="muted">
            {c.app} · {formatDate(c.start_time)} – {formatDate(c.end_time)} · lijst {c.data_source_list || "–"} ·{" "}
            <a href={c.info_url} target="_blank" rel="noreferrer">
              infopagina
            </a>
          </p>
        </div>
        <p className="muted small">
          Bijgewerkt {formatDateTime(data.generated_at)}
          {status.isFetching ? " · verversen…" : ""}
        </p>
      </div>

      <div className="chips" role="group" aria-label="Filter deelnemers">
        {FILTERS.map((f) => {
          const count = f === "all" ? data.accounts.length : (data.totals[f] ?? 0);
          return (
            <button
              key={f}
              type="button"
              className={`chip ${f !== "all" ? `account-${f}` : ""}`}
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              <span className="chip-count">{count}</span> {f === "all" ? "Alle deelnemers" : accountStateLabel[f]}
            </button>
          );
        })}
      </div>

      <StatusTable status={data} accounts={shown} campaign={c.name} />

      <section className="two-col">
        <InvitePanel campaign={c} />
        <SettingsPanel campaign={c} />
      </section>

      <SourcesPanel sources={data.sources} />
    </>
  );
}

function StatusTable({ status, accounts, campaign }: { status: CampaignStatus; accounts: AccountStatus[]; campaign: string }) {
  const [renewed, setRenewed] = useState<Invitation | null>(null);
  const [renewError, setRenewError] = useState<string | null>(null);
  const renew = useMutation({
    mutationFn: (accountId: number) => api.newInvitation(accountId),
    onSuccess: (inv) => {
      setRenewed(inv);
      setRenewError(null);
    },
    onError: (e) => setRenewError(explain(e)),
  });

  if (status.accounts.length === 0)
    return <p className="panel muted">Nog geen deelnemers. Maak hieronder uitnodigingen aan.</p>;
  if (accounts.length === 0) return <p className="panel muted">Geen deelnemers in deze selectie.</p>;

  return (
    <>
      <div className="table-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th>Deelnemer</th>
              <th>Status</th>
              {status.sources.map((s) => (
                <th key={s.id} title={`${categoryLabel[s.category] ?? s.category}; te laat na ${durationLabel(s.notification_threshold)}`}>
                  {s.name || `Bron ${s.id}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td className="nowrap">
                  <strong>{a.id}</strong>
                  <div className="muted small">{a.activated_at ? `actief sinds ${formatDate(a.activated_at)}` : "nog niet geactiveerd"}</div>
                </td>
                <td>
                  <span className={`pill account-${a.state}`}>{accountStateLabel[a.state]}</span>
                  {a.state === "invited" && (
                    <div>
                      <button type="button" className="link small" disabled={renew.isPending} onClick={() => renew.mutate(a.id)}>
                        Nieuwe link
                      </button>
                    </div>
                  )}
                </td>
                {status.sources.map((s, i) => (
                  <SourceCell key={s.id} source={s} status={a.sources[i]} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {renewError && <p className="error" role="alert">{renewError}</p>}
      {renewed && (
        <div className="panel">
          <div className="panel-head">
            <h2>Nieuwe link voor deelnemer {renewed.account_id}</h2>
            <button type="button" className="link" onClick={() => setRenewed(null)}>
              Sluiten
            </button>
          </div>
          <InvitationCards campaign={campaign} invitations={[renewed]} />
          <p className="hint">De oude link blijft ook geldig zolang de deelnemer nog niet geactiveerd is.</p>
        </div>
      )}
    </>
  );
}

function SourceCell({ source, status }: { source: Source; status?: SourceStatus }) {
  if (!status) return <td>–</td>;
  const detail =
    status.state === "missing"
      ? ""
      : status.latest_upload
        ? `laatste data ${ago(status.latest_upload)}`
        : `gekoppeld ${ago(status.activated_at)}`;
  return (
    <td className={`cell source-${status.state}`} title={`${source.name}: ${sourceStateLabel[status.state]}${status.instance ? ` (${status.instance})` : ""}`}>
      <span className="dot" aria-hidden="true" />
      <span>{sourceStateLabel[status.state]}</span>
      {detail && <div className="muted small">{detail}</div>}
    </td>
  );
}

function InvitePanel({ campaign }: { campaign: Campaign }) {
  const queryClient = useQueryClient();
  const [count, setCount] = useState(1);
  const invite = useMutation({
    mutationFn: () => api.invite(campaign.id, count),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["campaign", campaign.id] });
      queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });

  return (
    <div className="panel">
      <h2>Deelnemers uitnodigen</h2>
      <p className="muted">
        Elke uitnodiging maakt een pseudoniem account in deze campagne met een persoonlijke activeringslink voor de app. De Cockpit slaat
        geen namen of e-mailadressen op; houd de koppeling tussen deelnemer en nummer bij in je eigen administratie.
      </p>
      <form
        className="row"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          invite.mutate();
        }}
      >
        <label htmlFor="count">Aantal</label>
        <input id="count" type="number" min={1} max={200} value={count} onChange={(e) => setCount(Math.max(1, Math.min(200, Number(e.target.value) || 1)))} />
        <button type="submit" className="primary" disabled={invite.isPending || campaign.state === "ended"}>
          {invite.isPending ? "Bezig…" : "Uitnodigingen maken"}
        </button>
      </form>
      {campaign.state === "ended" && <p className="hint">Deze campagne is afgelopen; verleng de einddatum om nog iemand uit te nodigen.</p>}
      {invite.isError && <p className="error" role="alert">{explain(invite.error)}</p>}
      {invite.data && <InvitationCards campaign={campaign.name} invitations={invite.data} />}
    </div>
  );
}

function SettingsPanel({ campaign }: { campaign: Campaign }) {
  const queryClient = useQueryClient();
  const [infoURL, setInfoURL] = useState(campaign.info_url);
  const [start, setStart] = useState(toDateInput(campaign.start_time));
  const [end, setEnd] = useState(toDateInput(campaign.end_time));
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      api.updateCampaign(campaign.id, {
        info_url: infoURL.trim() !== campaign.info_url ? infoURL.trim() : undefined,
        start_time: start !== toDateInput(campaign.start_time) ? fromDateInput(start) : undefined,
        end_time: end !== toDateInput(campaign.end_time) ? fromDateInput(end) : undefined,
      }),
    onSuccess: () => {
      setSaved(true);
      queryClient.invalidateQueries({ queryKey: ["campaign", campaign.id] });
      queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });
  const startUnix = fromDateInput(start);
  const endUnix = fromDateInput(end);
  const invalid = startUnix !== undefined && endUnix !== undefined && endUnix <= startUnix;

  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        setSaved(false);
        save.mutate();
      }}
    >
      <h2>Instellingen</h2>
      <label htmlFor="info">Infopagina voor deelnemers</label>
      <input id="info" type="url" value={infoURL} onChange={(e) => setInfoURL(e.target.value)} required />
      <div className="row">
        <div>
          <label htmlFor="start">Start</label>
          <input id="start" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div>
          <label htmlFor="end">Einde</label>
          <input id="end" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
      </div>
      {invalid && <p className="error">De einddatum moet na de startdatum liggen.</p>}
      <p className="hint">Een datum leegmaken kan nog niet; app en lijst van een lopende campagne wijzig je niet.</p>
      {save.isError && <p className="error" role="alert">{explain(save.error)}</p>}
      <div className="row">
        <button type="submit" className="primary" disabled={save.isPending || invalid}>
          {save.isPending ? "Opslaan…" : "Opslaan"}
        </button>
        {saved && !save.isPending && <span className="ok-text">Opgeslagen</span>}
      </div>
    </form>
  );
}

function SourcesPanel({ sources }: { sources: Source[] }) {
  return (
    <details className="panel">
      <summary>Databronnen van deze campagne ({sources.length})</summary>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Databron</th>
              <th>Soort</th>
              <th>Uploadschema</th>
              <th>Te laat na</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.id}>
                <td>{s.name || `Bron ${s.id}`}</td>
                <td>{categoryLabel[s.category] ?? s.category}</td>
                <td className="mono small">{s.upload_schedule || "–"}</td>
                <td>{durationLabel(s.notification_threshold)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
