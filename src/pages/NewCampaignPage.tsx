// SPDX-License-Identifier: EUPL-1.2
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, explain } from "../api";
import { fromDateInput } from "../format";

export function NewCampaignPage() {
  const queryClient = useQueryClient();
  const overview = useQuery({ queryKey: ["overview"], queryFn: () => api.overview() });
  const [name, setName] = useState("");
  const [app, setApp] = useState("");
  const [list, setList] = useState("");
  const [infoURL, setInfoURL] = useState("https://manuals.energiegedrag.nl/");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");

  const create = useMutation({
    mutationFn: () =>
      api.createCampaign({
        name: name.trim(),
        app: { name: app },
        info_url: infoURL.trim(),
        start_time: fromDateInput(start),
        end_time: fromDateInput(end),
        data_source_list: { name: list },
      }),
    onSuccess: (campaign) => {
      queryClient.invalidateQueries({ queryKey: ["overview"] });
      location.hash = campaign?.id ? `#/campagne/${campaign.id}` : "#/";
    },
  });

  if (overview.isPending) return <p className="muted">Laden…</p>;
  if (overview.isError) return <p className="error" role="alert">{explain(overview.error)}</p>;

  const { apps, data_source_lists: lists, campaigns } = overview.data;
  const startUnix = fromDateInput(start);
  const endUnix = fromDateInput(end);
  const invalidDates = startUnix !== undefined && endUnix !== undefined && endUnix <= startUnix;
  const duplicate = campaigns.some((c) => c.name.toLowerCase() === name.trim().toLowerCase());
  const usedInfo = campaigns.some((c) => c.info_url === infoURL.trim());

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  if (apps.length === 0 || lists.length === 0) {
    return (
      <>
        <h1>Nieuwe campagne</h1>
        <p className="panel">
          Voor een campagne zijn een app en een databronnenlijst nodig. {apps.length === 0 ? "Er is nog geen app. " : ""}
          {lists.length === 0 ? "Er is nog geen databronnenlijst. " : ""}Richt die eerst in met het draaiboek (docs/21).
        </p>
      </>
    );
  }

  return (
    <>
      <a href="#/" className="back">
        ← Campagnes
      </a>
      <h1>Nieuwe campagne</h1>
      <form className="panel form" onSubmit={submit}>
        <label htmlFor="name">Naam</label>
        <input id="name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="Bijvoorbeeld: Winter 2026 Zwolle" />
        {duplicate && <p className="error">Er bestaat al een campagne met deze naam.</p>}

        <div className="row">
          <div>
            <label htmlFor="app">App</label>
            <select id="app" value={app} onChange={(e) => setApp(e.target.value)} required>
              <option value="">Kies een app</option>
              {apps.map((a) => (
                <option key={a.id} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="list">Databronnenlijst</label>
            <select id="list" value={list} onChange={(e) => setList(e.target.value)} required>
              <option value="">Kies een lijst</option>
              {lists.map((l) => (
                <option key={l.id} value={l.name}>
                  {l.name} ({l.items})
                </option>
              ))}
            </select>
          </div>
        </div>

        <label htmlFor="info">Infopagina voor deelnemers</label>
        <input id="info" type="url" value={infoURL} onChange={(e) => setInfoURL(e.target.value)} required />
        {usedInfo && <p className="error">Elke campagne heeft een eigen infopagina; deze is al in gebruik.</p>}

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
        {invalidDates && <p className="error">De einddatum moet na de startdatum liggen.</p>}
        <p className="hint">Zonder startdatum staat de campagne op Gepland. Deelnemers uitnodigen kan daarna op de campagnepagina.</p>

        {create.isError && <p className="error" role="alert">{explain(create.error)}</p>}
        <button type="submit" className="primary" disabled={create.isPending || invalidDates || duplicate || usedInfo || !name.trim()}>
          {create.isPending ? "Aanmaken…" : "Campagne aanmaken"}
        </button>
      </form>
    </>
  );
}
