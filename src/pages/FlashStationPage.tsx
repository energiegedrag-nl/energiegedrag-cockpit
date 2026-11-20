// SPDX-License-Identifier: EUPL-1.2
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, explain, getToken } from "../api";
import { connect, disconnect, eraseAll, FLASH_BAUD, flash, resetAndWatch, SAFE_FLASH_BAUD, serialSupported, type Connection } from "../flash/esp";
import { loadImages, loadIndex, loadMirrorStatus, refreshMirror, sortFirmware, type FirmwareEntry } from "../flash/firmware";
import { findProvisioning, nameMatchesMac, type Provisioning } from "../flash/provisioning";
import { firmwareLabel, formatDateTime, inventoryStateLabel } from "../format";
import type { InventoryDevice } from "../types";
import { DeviceLabel, printLabel } from "./DeviceLabel";
import { FlashProgress } from "../flash/FlashProgress";

type Step =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "busy"; what: string; progress?: number }
  | { kind: "done"; device: InventoryDevice; provisioning: Provisioning | null }
  | { kind: "erased"; device: InventoryDevice | null };

const entryKey = (e: FirmwareEntry) => `${e.repo}@${e.tag}/${e.variant}`;

/**
 * "Gespiegeld <tijd>" plus "Nu ophalen": the mirror fetches the firmware releases every 6 hours; a release that was just
 * published can be fetched at once (mirror/mirror.py, MIRROR_TRIGGER; nginx checks the admin token first).
 */
function MirrorRefresh({ generatedAt, disabled }: { generatedAt: number; disabled: boolean }) {
  const queryClient = useQueryClient();
  const [asked, setAsked] = useState<number | null>(null); // unix time of the click
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const status = useQuery({
    queryKey: ["firmware-mirror-status"],
    queryFn: loadMirrorStatus,
    refetchInterval: (q) => (asked !== null || q.state.data?.running ? 3000 : 60000),
  });
  const s = status.data;
  const busy = asked !== null || !!s?.running || !!s?.requested;

  useEffect(() => {
    if (asked === null || !s) return;
    if (!s.running && !s.requested && s.finished_at >= asked) {
      setAsked(null);
      void queryClient.invalidateQueries({ queryKey: ["firmware-index"] });
      const problems = s.problems.length ? ` ${s.problems.length} melding${s.problems.length === 1 ? "" : "en"}, zie hieronder.` : "";
      setMessage(s.ok ? `Klaar: ${s.builds} build${s.builds === 1 ? "" : "s"} beschikbaar.${problems}` : `Ophalen mislukt.${problems}`);
    } else if (Date.now() / 1000 - asked > 600) {
      setAsked(null);
      setFailure("De spiegel is na 10 minuten nog niet klaar; kijk in het log van firmware-mirror.");
    }
  }, [asked, s, queryClient]);

  async function onClick() {
    setMessage(null);
    setFailure(null);
    const now = Math.floor(Date.now() / 1000);
    try {
      await refreshMirror(getToken());
      setAsked(now);
      void status.refetch();
    } catch (e) {
      setFailure(explain(e));
    }
  }

  const last = s?.finished_at || generatedAt;
  return (
    <div className="mirror-refresh">
      <p className="hint">
        Gespiegeld {formatDateTime(last)}
        {s?.next_run_at ? `; volgende keer vanzelf ${formatDateTime(s.next_run_at)}` : ""}.{" "}
        <button type="button" onClick={onClick} disabled={disabled || busy}>
          {busy ? "Ophalen…" : "Nu ophalen"}
        </button>
      </p>
      {message && <p className="small">{message}</p>}
      {failure && <p className="error">{failure}</p>}
      {s && !busy && s.problems.length > 0 && (
        <details className="small">
          <summary>Meldingen van de laatste ronde ({s.problems.length})</summary>
          <ul>
            {s.problems.map((p, i) => (
              <li key={i}>
                <code>{p}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function FlashStationPage() {
  const queryClient = useQueryClient();
  const index = useQuery({ queryKey: ["firmware-index"], queryFn: loadIndex, refetchInterval: false });
  const [showPre, setShowPre] = useState(false);
  const [selected, setSelected] = useState<string>("");
  const [eraseFirst, setEraseFirst] = useState(true);
  // Write errors ("Failed to write compressed data to flash") at 460800 baud on some USB-serial chips: flash slower.
  const [slow, setSlow] = useState(() => {
    try {
      return localStorage.getItem("flash.slow") === "1";
    } catch {
      return false;
    }
  });
  // A device that is still linked to a participant: where does it go after flashing?
  const [decision, setDecision] = useState<"release" | "keep" | null>(null);
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [consoleText, setConsoleText] = useState("");
  const [known, setKnown] = useState<InventoryDevice | null>(null);
  const connection = useRef<Connection | null>(null);

  const firmware = useMemo(() => sortFirmware((index.data?.firmware ?? []).filter((f) => showPre || !f.prerelease)), [index.data, showPre]);
  const chip = connection.current?.chipFamily;
  const choice = firmware.find((f) => entryKey(f) === selected) ?? null;
  // Still linked: assigned, shipped or taken in (returned) in the inventory, or activated by the app.
  const linked = known !== null && (known.state === "assigned" || known.state === "shipped" || known.state === "returned" || known.in_use !== null);
  const owner = known?.account_id ?? known?.in_use?.account_id ?? null;
  const blocked = linked && decision === null;
  const addLog = (line: string) => setLog((l) => [...l.slice(-300), line]);

  if (!serialSupported()) {
    return (
      <>
        <h1>Flashstation</h1>
        <p className="error" role="alert">
          Deze browser kan geen USB-apparaten aansturen (Web Serial). Gebruik Chrome of Edge op een laptop of desktop, via https://.
        </p>
      </>
    );
  }

  const fail = async (e: unknown) => {
    const message = e instanceof ApiError ? explain(e) : e instanceof Error ? e.message : String(e);
    const writeError = /write|flash|status/i.test(message) && !slow;
    setError(writeError ? `${message} Probeer "Langzaam flashen" hieronder (115200 baud), een kortere kabel of een poort direct op de computer.` : message);
    if (connection.current) await disconnect(connection.current);
    connection.current = null;
    setStep({ kind: "idle" });
  };

  const onConnect = async () => {
    setError(null);
    setLog([]);
    setConsoleText("");
    setKnown(null);
    setDecision(null);
    setStep({ kind: "connecting" });
    try {
      const c = await connect(addLog, slow ? SAFE_FLASH_BAUD : FLASH_BAUD);
      connection.current = c;
      try {
        setKnown(await api.inventoryByMac(c.mac));
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) throw e;
      }
      setStep({ kind: "connected" });
    } catch (e) {
      if (e instanceof DOMException && e.name === "NotFoundError") {
        setStep({ kind: "idle" }); // the user closed the port picker
        return;
      }
      await fail(e);
    }
  };

  const onFlash = async () => {
    const c = connection.current;
    if (!c || !choice) return;
    setError(null);
    try {
      setStep({ kind: "busy", what: "Firmware ophalen en SHA-256 controleren" });
      const { images } = await loadImages(choice, c.chipFamily);
      setStep({ kind: "busy", what: eraseFirst ? "Wissen en flashen" : "Flashen", progress: 0 });
      await flash(c, images, eraseFirst, (p) => setStep({ kind: "busy", what: eraseFirst ? "Wissen en flashen" : "Flashen", progress: p }));
      addLog("Geschreven en gecontroleerd (MD5 per deel).");
      setStep({ kind: "busy", what: "Herstarten en wachten op de QR-code in de console" });
      const provisioning = await resetAndWatch(c, setConsoleText, findProvisioning);
      const name = provisioning && nameMatchesMac(provisioning.name, c.mac) ? provisioning.name : "";
      if (provisioning && !name) addLog(`Naam ${provisioning.name} past niet bij MAC ${c.mac}; niet geregistreerd als naam.`);
      const device = await api.recordFlash({
        mac: c.mac,
        chip: c.chipFamily,
        device_type: choice.device_type,
        name,
        firmware: choice.repo,
        firmware_version: `${choice.tag} ${choice.variant}`,
        release: linked && decision === "release",
        keep_account: linked && decision === "keep",
      });
      connection.current = null; // resetAndWatch closed the port
      setKnown(device);
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      setStep({ kind: "done", device, provisioning });
    } catch (e) {
      await fail(e);
    }
  };

  const onEraseOnly = async () => {
    const c = connection.current;
    if (!c) return;
    setError(null);
    try {
      setStep({ kind: "busy", what: "Volledig wissen" });
      await eraseAll(c);
      addLog("Flash gewist.");
      await disconnect(c);
      connection.current = null;
      let device: InventoryDevice | null = null;
      if (known && known.state !== "erased") {
        // The device is here: a shipped or assigned device is taken in first.
        if (linked && (known.state === "shipped" || known.state === "assigned")) {
          device = await api.inventoryEvent(known.id, { event: "return", details: "ingenomen op het flashstation" });
        }
        if (linked && decision === "release") {
          device = await api.inventoryEvent(known.id, { event: "release", details: `vrijgegeven op het flashstation; was van deelnemer ${owner ?? "?"}` });
        }
        // Repair for the same participant: keep the account (erased would drop it).
        if (!(linked && decision === "keep")) {
          device = await api.inventoryEvent(known.id, { event: "erase", details: "volledig gewist op het flashstation" });
        }
        queryClient.invalidateQueries({ queryKey: ["inventory"] });
      }
      setStep({ kind: "erased", device });
    } catch (e) {
      await fail(e);
    }
  };

  const busy = step.kind === "busy" || step.kind === "connecting";

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Flashstation</h1>
          <p className="muted">Apparaat via USB aansluiten, firmware schrijven, registreren in de voorraad en een label printen.</p>
        </div>
        <a className="button" href="#/voorraad">
          Voorraad
        </a>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <section className="two-col">
        <div className="panel">
          <h2>1. Firmware</h2>
          {index.isPending && <p className="muted">Firmware-index laden…</p>}
          {index.isError && <p className="error">{explain(index.error)}</p>}
          {index.data && index.data.firmware.length === 0 && (
            <p className="muted">
              Nog geen firmware gespiegeld. De spiegeltaak (<code>firmware-mirror</code>) zet releases onder <code>/firmware/</code>.
            </p>
          )}
          {index.data && index.data.firmware.length > 0 && (
            <>
              <label htmlFor="fw">Firmware</label>
              <select id="fw" value={selected} onChange={(e) => setSelected(e.target.value)} disabled={busy}>
                <option value="">Kies firmware…</option>
                {firmware.map((f) => (
                  <option key={entryKey(f)} value={entryKey(f)} disabled={chip !== undefined && f.chip_family !== chip}>
                    {firmwareLabel(f.repo)} {f.tag} · {f.variant}
                    {f.prerelease ? " (pre-release)" : ""}
                  </option>
                ))}
              </select>
              <div className="checks">
                <label className="check">
                  <input type="checkbox" checked={showPre} onChange={(e) => setShowPre(e.target.checked)} /> Pre-releases tonen
                </label>
                <label className="check">
                  <input type="checkbox" checked={eraseFirst} onChange={(e) => setEraseFirst(e.target.checked)} /> Eerst volledig wissen
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={slow}
                    onChange={(e) => {
                      setSlow(e.target.checked);
                      try {
                        localStorage.setItem("flash.slow", e.target.checked ? "1" : "0");
                      } catch {
                        /* not remembered */
                      }
                    }}
                  />{" "}
                  Langzaam flashen (115200 baud, bij schrijffouten)
                </label>
              </div>
              <p className="hint">
                Volledig wissen verwijdert oude wifi-gegevens en geeft het apparaat een nieuw geheim, dus ook een nieuwe QR-code.
              </p>
              {choice && (
                <p className="small">
                  Apparaattype <code>{choice.device_type || "onbekend"}</code> · chip {choice.chip_family}
                </p>
              )}
            </>
          )}
          <MirrorRefresh generatedAt={index.data?.generated_at ?? 0} disabled={busy} />
        </div>

        <div className="panel">
          <h2>2. Apparaat</h2>
          {!connection.current && step.kind !== "connecting" && (
            <>
              <p className="muted small">Sluit het apparaat met een USB-datakabel aan. De browser vraagt welke poort.</p>
              <button type="button" className="primary" onClick={onConnect} disabled={busy}>
                Apparaat aansluiten
              </button>
            </>
          )}
          {step.kind === "connecting" && <p className="muted">Verbinden met de bootloader…</p>}
          {connection.current && (
            <dl className="facts">
              <dt>Chip</dt>
              <dd>{connection.current.description}</dd>
              <dt>MAC</dt>
              <dd className="mono">{connection.current.mac}</dd>
              <dt>Voorraad</dt>
              <dd>
                {known ? (
                  <>
                    <a href={`#/voorraad/${known.id}`}>#{known.id}</a> · <span className={`pill inv-${known.state}`}>{inventoryStateLabel[known.state]}</span>{" "}
                    <span className="muted small">
                      {firmwareLabel(known.firmware)} {known.firmware_version}
                    </span>
                  </>
                ) : (
                  <span className="muted">Nieuw apparaat</span>
                )}
              </dd>
            </dl>
          )}
          {connection.current && linked && (
            <fieldset className="warning decision">
              <legend>
                Dit apparaat is nog van deelnemer {owner ?? "?"}
                {known!.in_use ? " (geactiveerd door de app)" : ` (${inventoryStateLabel[known!.state].toLowerCase()})`}. Waar gaat het heen?
              </legend>
              <label className="check">
                <input type="radio" name="decision" checked={decision === "release"} onChange={() => setDecision("release")} /> Naar een{" "}
                <strong>andere deelnemer</strong>: vrijgeven. De metingen blijven bij deelnemer {owner ?? "?"}; de oude koppeling werkt niet
                meer.
              </label>
              <label className="check">
                <input type="radio" name="decision" checked={decision === "keep"} onChange={() => setDecision("keep")} /> Na reparatie{" "}
                <strong>terug naar deelnemer {owner ?? "?"}</strong>. Die koppelt het daarna opnieuw met de app; in de voorraad staat het als
                ingenomen, klaar om terug te sturen.
              </label>
            </fieldset>
          )}
        </div>
      </section>

      <section className="panel">
        <h2>3. Flashen</h2>
        {step.kind === "busy" && (
          <FlashProgress key={step.what} what={step.what} fraction={step.progress} />
        )}
        {step.kind === "connected" && (
          <div className="row">
            <button type="button" className="primary" onClick={onFlash} disabled={!choice || choice.chip_family !== chip || blocked}>
              {choice ? `Flash ${firmwareLabel(choice.repo)} ${choice.tag}` : "Kies eerst firmware"}
            </button>
            {known && (
              <button type="button" onClick={onEraseOnly} disabled={blocked}>
                Alleen wissen (retour)
              </button>
            )}
          </div>
        )}
        {step.kind === "done" && (
          <div className="label-flow">
            <p className="ok-text">
              Geflasht, gecontroleerd en geregistreerd als <a href={`#/voorraad/${step.device.id}`}>#{step.device.id}</a>.
            </p>
            {step.provisioning ? (
              <DeviceLabel device={step.device} payload={step.provisioning.payload} />
            ) : (
              <p className="warning">
                De QR-code verscheen niet binnen 45 seconden in de console. Druk op de resetknop van het apparaat en sluit het opnieuw aan
                om het nog eens te proberen, of lees de code van het scherm van het apparaat.
              </p>
            )}
            <div className="row">
              {step.provisioning && (
                <button type="button" className="primary" onClick={printLabel}>
                  Label printen
                </button>
              )}
              <button type="button" onClick={() => setStep({ kind: "idle" })}>
                Volgend apparaat
              </button>
            </div>
          </div>
        )}
        {step.kind === "erased" && (
          <div className="row">
            <p className="ok-text">Gewist{step.device ? ` en in de voorraad als gewist gemarkeerd (#${step.device.id})` : ""}.</p>
            <button type="button" onClick={() => setStep({ kind: "idle" })}>
              Volgend apparaat
            </button>
          </div>
        )}
        {step.kind === "idle" && <p className="muted small">Kies firmware en sluit een apparaat aan.</p>}

        {(log.length > 0 || consoleText) && (
          <details className="log">
            <summary>Logboek</summary>
            <h3 className="small">Flashen (esptool)</h3>
            <LogBlock text={log.join("\n")} />
            {consoleText && (
              <>
                <h3 className="small">Uitvoer van het apparaat na herstart</h3>
                <p className="small muted">Hieruit leest het flashstation de provisioning-gegevens voor de voorraad.</p>
                <LogBlock text={consoleText.slice(-6000)} />
              </>
            )}
          </details>
        )}
      </section>
    </>
  );
}

/** A log that keeps showing its last line while it grows. */
function LogBlock({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text]);
  return <pre ref={ref}>{text}</pre>;
}
