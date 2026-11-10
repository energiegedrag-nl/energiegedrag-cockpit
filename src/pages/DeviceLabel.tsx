// SPDX-License-Identifier: EUPL-1.2
import { firmwareLabel } from "../format";
import type { InventoryDevice } from "../types";
import { QR } from "./Invitations";

/**
 * Label for the device: the provisioning QR code the participant scans with the app, plus the device name and the
 * inventory number. The QR code contains the device secret, so the label is printed now and not stored anywhere.
 */
export function DeviceLabel({ device, payload }: { device: InventoryDevice; payload: string }) {
  return (
    <div className="label-sheet">
      <div className="device-label">
        <QR text={payload} size={132} alt="QR-code om het apparaat met de app te koppelen" />
        <div className="device-label-text">
          <div className="device-label-name mono">{device.name || "–"}</div>
          <div>{firmwareLabel(device.firmware)}</div>
          <div className="small">Voorraad #{device.id}</div>
          <div className="small">Scan met de NeedForHeat-app</div>
        </div>
      </div>
    </div>
  );
}

/** Prints only the label (see the print rules for body.print-label in styles.css). */
export function printLabel() {
  document.body.classList.add("print-label");
  const done = () => {
    document.body.classList.remove("print-label");
    window.removeEventListener("afterprint", done);
  };
  window.addEventListener("afterprint", done);
  window.print();
}
