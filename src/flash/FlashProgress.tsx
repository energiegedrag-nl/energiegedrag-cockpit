// SPDX-License-Identifier: EUPL-1.2
// Progress in the style of tqdm: percentage, elapsed time and estimated time left, with a shimmer on the bar that shows
// the page is alive, and a clear "waiting for the device" when progress stalls (at 115200 baud flashing takes minutes).
import { useEffect, useRef, useState } from "react";

const STALL_MS = 4000;

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Estimated seconds left from the writing rate since writing started (erasing does not count). */
export function secondsLeft(fraction: number, writeStart: { t: number; f: number } | null, now: number): number | null {
  if (!writeStart || fraction <= writeStart.f || fraction >= 1) return null;
  const rate = (fraction - writeStart.f) / ((now - writeStart.t) / 1000);
  if (rate <= 0 || !Number.isFinite(rate)) return null;
  return (1 - fraction) / rate;
}

export function FlashProgress({ what, fraction }: { what: string; fraction?: number }) {
  const [now, setNow] = useState(() => Date.now());
  const started = useRef(Date.now());
  const writeStart = useRef<{ t: number; f: number } | null>(null);
  const lastChange = useRef({ t: Date.now(), f: fraction ?? 0 });

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);

  const f = fraction ?? 0;
  if (f !== lastChange.current.f) lastChange.current = { t: Date.now(), f };
  if (writeStart.current === null && f > 0) writeStart.current = { t: Date.now(), f };

  const elapsed = (now - started.current) / 1000;
  const left = secondsLeft(f, writeStart.current, now);
  const stalledMs = now - lastChange.current.t;
  const stalled = stalledMs > STALL_MS && f < 1;
  const indeterminate = fraction === undefined || f === 0;

  return (
    <div className="progress-block" aria-live="polite">
      <div className="progress-head">
        <span>{what}…</span>
        <span className="progress-numbers">
          {!indeterminate && <strong>{Math.floor(f * 100)}%</strong>}
          <span>{clock(elapsed)} verstreken</span>
          {left !== null && <span>nog ±{clock(left)}</span>}
        </span>
      </div>
      <div
        className={`bar${indeterminate ? " indeterminate" : ""}${stalled ? " stalled" : ""}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : Math.floor(f * 100)}
      >
        <div className="bar-fill" style={{ width: indeterminate ? "100%" : `${f * 100}%` }} />
      </div>
      <div className="small muted">
        {stalled
          ? `Wacht op de module… (${Math.round(stalledMs / 1000)} s geen voortgang; de pagina werkt nog)`
          : indeterminate
            ? "Bezig; de voortgang verschijnt zodra het schrijven begint."
            : " "}
      </div>
    </div>
  );
}
