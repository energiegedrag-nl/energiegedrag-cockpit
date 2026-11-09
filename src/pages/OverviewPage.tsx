import { useQuery } from "@tanstack/react-query";
import { api, explain } from "../api";
import { campaignStateLabel, formatDate, formatDateTime } from "../format";

export function OverviewPage() {
  const overview = useQuery({ queryKey: ["overview"], queryFn: () => api.overview() });

  if (overview.isPending) return <p className="muted">Campagnes laden…</p>;
  if (overview.isError) return <p className="error" role="alert">{explain(overview.error)}</p>;

  const { campaigns, apps, data_source_lists: lists } = overview.data;
  const running = campaigns.filter((c) => c.state === "running").length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Campagnes</h1>
          <p className="muted">
            {campaigns.length === 0
              ? "Nog geen campagnes."
              : `${campaigns.length} campagne${campaigns.length === 1 ? "" : "s"}, waarvan ${running} lopend. Bijgewerkt ${formatDateTime(overview.data.generated_at)}.`}
          </p>
        </div>
        <a className="button primary" href="#/nieuw">
          Nieuwe campagne
        </a>
      </div>

      {campaigns.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Campagne</th>
                <th>Status</th>
                <th>Looptijd</th>
                <th className="num">Deelnemers</th>
                <th className="num">Geactiveerd</th>
                <th>Databronnen</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id}>
                  <td>
                    <a href={`#/campagne/${c.id}`}>{c.name}</a>
                    <div className="muted small">{c.app}</div>
                  </td>
                  <td>
                    <span className={`pill campaign-${c.state}`}>{campaignStateLabel[c.state]}</span>
                  </td>
                  <td className="nowrap">
                    {formatDate(c.start_time)} – {formatDate(c.end_time)}
                  </td>
                  <td className="num">{c.accounts}</td>
                  <td className="num">
                    {c.activated}
                    {c.accounts > 0 && <span className="muted small"> ({Math.round((100 * c.activated) / c.accounts)}%)</span>}
                  </td>
                  <td>{c.data_source_list || "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="two-col">
        <div className="panel">
          <h2>Apps</h2>
          {apps.length === 0 ? (
            <p className="muted">Nog geen app ingericht.</p>
          ) : (
            <ul className="plain">
              {apps.map((a) => (
                <li key={a.id}>
                  <strong>{a.name}</strong>
                  <div className="muted small mono">{a.provisioning_url_template}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="panel">
          <h2>Databronnenlijsten</h2>
          {lists.length === 0 ? (
            <p className="muted">Nog geen lijsten ingericht.</p>
          ) : (
            <ul className="plain">
              {lists.map((l) => (
                <li key={l.id}>
                  <strong>{l.name}</strong> <span className="muted small">({l.items} databronnen)</span>
                </li>
              ))}
            </ul>
          )}
          <p className="hint">Apps, apparaattypes en lijsten maak je nu nog met het draaiboek in docs/21; dat komt in een volgende versie in de Cockpit.</p>
        </div>
      </section>
    </>
  );
}
