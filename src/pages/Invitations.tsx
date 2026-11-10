// SPDX-License-Identifier: EUPL-1.2
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { Invitation } from "../types";

export function QR({ text, size = 148, alt = "QR-code van de uitnodigingslink" }: { text: string; size?: number; alt?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(text, { margin: 2, width: size, errorCorrectionLevel: "M" })
      .then((url) => alive && setSrc(url))
      .catch(() => alive && setSrc(null));
    return () => {
      alive = false;
    };
  }, [text, size]);
  return src ? <img className="qr" src={src} width={size} height={size} alt={alt} /> : <div className="qr" style={{ width: size, height: size }} />;
}

export function CopyButton({ text, label = "Kopieer link" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          })
          .catch(() => window.prompt("Kopieer deze tekst:", text));
      }}
    >
      {done ? "Gekopieerd" : label}
    </button>
  );
}

/** Invitation cards: link, QR code and copy button. Meant to be printed or handed out one by one. */
export function InvitationCards({ campaign, invitations }: { campaign: string; invitations: Invitation[] }) {
  const all = invitations.map((i) => `Deelnemer ${i.account_id}\t${i.invitation_url}`).join("\n");
  return (
    <div className="invitations">
      <div className="invitations-head">
        <p>
          <strong>{invitations.length} uitnodiging{invitations.length === 1 ? "" : "en"} gemaakt.</strong> Bewaar of verstuur de links nu:
          de server bewaart ze niet en toont ze niet opnieuw. Een kwijtgeraakte link vervang je met <em>Nieuwe link</em> bij de deelnemer.
        </p>
        <CopyButton text={all} label="Kopieer alle links" />
      </div>
      <ul className="cards">
        {invitations.map((i) => (
          <li key={i.account_id} className="card">
            <QR text={i.invitation_url} />
            <div className="card-body">
              <div className="card-title">
                Deelnemer {i.account_id} <span className="muted small">· {campaign}</span>
              </div>
              <div className="mono small break">{i.invitation_url}</div>
              <CopyButton text={i.invitation_url} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
