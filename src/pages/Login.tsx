// SPDX-License-Identifier: EUPL-1.2
import { useState, type FormEvent } from "react";
import { api, explain } from "../api";

export function Login({ onLogin }: { onLogin: (token: string) => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const t = token.trim();
    if (!t) return;
    setBusy(true);
    setError(null);
    try {
      await api.overview(t); // checks the token before keeping it
      onLogin(t);
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form className="panel login-panel" onSubmit={submit}>
        <h1>Energiegedrag Cockpit</h1>
        <p className="muted">
          Campagnes van NeedForHeat opzetten, deelnemers uitnodigen en volgen of hun data binnenkomt.
        </p>
        <label htmlFor="token">Beheertoken</label>
        <input
          id="token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Plak het beheertoken"
        />
        <p className="hint">
          Het token blijft alleen in dit tabblad bewaard en verdwijnt als je het sluit. Een token maak je op de server met{" "}
          <code>needforheat-server-api admin create</code>.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy || !token.trim()}>
          {busy ? "Controleren…" : "Inloggen"}
        </button>
      </form>
    </main>
  );
}
