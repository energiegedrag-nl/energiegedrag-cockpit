// SPDX-License-Identifier: EUPL-1.2
import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, explain } from "../api";
import { connect, disconnect, eraseAll, flash, resetAndWatch, serialSupported, type Connection } from "../flash/esp";
import { loadImages, loadIndex, sortFirmware, type FirmwareEntry } from "../flash/firmware";
import { findProvisioning, nameMatchesMac, type Provisioning } from "../flash/provisioning";
import { firmwareLabel, formatDateTime, inventoryStateLabel } from "../format";
import type { InventoryDevice } from "../types";
import { DeviceLabel, printLabel } from "./DeviceLabel";

type Step =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "busy"; what: string; progress?: number }
  | { kind: "done"; device: InventoryDevice; provisioning: Provisioning | null }
  | { kind: "erased"; device: InventoryDevice | null };

const entryKey = (e: FirmwareEntry) => `${e.repo}@${e.tag}/${e.variant}`;

export function FlashStationPage() {
  const queryClient = useQueryClient();
  const index = useQuery({ queryKey: ["firmware-index"], queryFn: loadIndex, refetchInterval: false });
  const [showPre, setShowPre] = useState(false);
  const [selected, setSelected] = useState<string>("");
  const [eraseFirst, setEraseFirst] = useState(true);
  const [force, setForce] = useState(false);
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [consoleText, setConsoleText] = useState("");
  const [known, setKnown] = useState<InventoryDevice | null>(null);
  const connection = useRef<Connection | null>(null);

  const firmware = useMemo(() => sortFirmware((index.data?.firmware ?? []).filter((f) => showPre || !f.prerelease)), [index.data, showPre]);
  const chip = connection.current?.chipFamily;
  const choice = firmware.find((f) => entryKey(f) === selected) ?? null;
  const assigned = known !== null && (known.state === "assigned" || known.state === "shipped");
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
    setError(e instanceof ApiError ? explain(e) : e instanceof Error ? e.message : String(e));
    if (connection.current) await disconnect(connection.current);
    connection.current = null;
    setStep({ kind: "idle" });
  };

  const onConnect = async () => {
    setError(null);
    setLog([]);
    setConsoleText("");
    setKnown(null);
    setForce(false);
    setStep({ kind: "connecting" });
    try {
      const c = await connect(addLog);
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
        force: assigned && force,
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
        device = await api.inventoryEvent(known.id, { event: "erase", details: "volledig gewist op het flashstation" });
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
              </div>
              <p className="hint">
                Volledig wissen verwijdert oude wifi-gegevens en geeft het apparaat een nieuw geheim, dus ook een nieuwe QR-code. Gespiegeld{" "}
                {formatDateTime(index.data.generated_at)}.
              </p>
              {choice && (
                <p className="small">
                  Apparaattype <code>{choice.device_type || "onbekend"}</code> · chip {choice.chip_family}
                </p>
              )}
            </>
          )}
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
          {known?.in_use && (
            <p className="warning">
              De app heeft dit apparaat geactiveerd voor deelnemer {known.in_use.account_id}. Opnieuw flashen verbreekt de meting.
            </p>
          )}
          {connection.current && assigned && (
            <label className="check warning">
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Dit apparaat is nog{" "}
              {inventoryStateLabel[known!.state].toLowerCase()} aan deelnemer {known!.account_id}. Toch flashen en de koppeling verbreken.
            </label>
          )}
        </div>
      </section>

      <section className="panel">
        <h2>3. Flashen</h2>
        {step.kind === "busy" && (
          <div className="progress-block" aria-live="polite">
            <div>{step.what}…</div>
            {step.progress !== undefined && (
              <progress max={1} value={step.progress}>
                {Math.round(step.progress * 100)}%
              </progress>
            )}
          </div>
        )}
        {step.kind === "connected" && (
          <div className="row">
            <button type="button" className="primary" onClick={onFlash} disabled={!choice || choice.chip_family !== chip || (assigned && !force)}>
              {choice ? `Flash ${firmwareLabel(choice.repo)} ${choice.tag}` : "Kies eerst firmware"}
            </button>
            {known && (
              <button type="button" onClick={onEraseOnly} disabled={assigned && !force}>
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
            <pre>{log.join("\n")}</pre>
            {consoleText && <pre>{consoleText.slice(-6000)}</pre>}
          </details>
        )}
      </section>
    </>
  );
}
