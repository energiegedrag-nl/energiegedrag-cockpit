// Web Serial + esptool-js: detect the chip, read the MAC address, erase, flash with MD5 verification and read the
// console after a reset. esptool-js only writes flash; it never touches eFuses, so nothing here can lock a device.
import { ESPLoader, Transport, type IEspLoaderTerminal } from "esptool-js";
import type { FlashImage } from "./firmware";
import { md5 } from "./md5";

export const FLASH_BAUD = 460800;
export const CONSOLE_BAUD = 115200;

export function serialSupported(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

export interface Connection {
  port: SerialPort;
  transport: Transport;
  loader: ESPLoader;
  chipFamily: string; // e.g. ESP32, as in the ESP Web Tools manifest
  description: string; // e.g. ESP32-D0WD-V3 (revision v3.1)
  mac: string; // AA:BB:CC:DD:EE:FF
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function terminal(log: (line: string) => void): IEspLoaderTerminal {
  let partial = "";
  return {
    clean: () => undefined,
    write: (data) => {
      partial += data;
    },
    writeLine: (data) => {
      log(partial + data);
      partial = "";
    },
  };
}

/** Asks the user to pick a serial port, then connects to the ROM bootloader (resets the device into download mode). */
export async function connect(log: (line: string) => void): Promise<Connection> {
  const port = await navigator.serial.requestPort();
  const transport = new Transport(port, false);
  const loader = new ESPLoader({ transport, baudrate: FLASH_BAUD, terminal: terminal(log) });
  try {
    const description = await loader.main();
    const mac = (await loader.chip.readMac(loader)).toUpperCase();
    return { port, transport, loader, chipFamily: loader.chip.CHIP_NAME, description, mac };
  } catch (e) {
    await transport.disconnect().catch(() => undefined);
    throw e;
  }
}

export async function disconnect(c: Connection): Promise<void> {
  await c.transport.disconnect().catch(() => undefined);
}

/** Erases the whole flash: firmware, Wi-Fi credentials and the device secret in NVS. */
export async function eraseAll(c: Connection): Promise<void> {
  await c.loader.eraseFlash();
}

/**
 * Writes the images and lets esptool-js compare the MD5 of every written region with the image.
 * `erase` erases the whole flash first, so the device starts without old Wi-Fi credentials and makes a new secret.
 */
export async function flash(c: Connection, images: FlashImage[], erase: boolean, progress: (fraction: number) => void): Promise<void> {
  const total = images.reduce((sum, i) => sum + i.data.length, 0);
  const done = images.map(() => 0);
  await c.loader.writeFlash({
    fileArray: images.map((i) => ({ data: i.data, address: i.offset })),
    flashMode: "keep",
    flashFreq: "keep",
    flashSize: "keep",
    eraseAll: erase,
    compress: true,
    reportProgress: (index, written, size) => {
      done[index] = (written / size) * images[index].data.length;
      progress(done.reduce((a, b) => a + b, 0) / total);
    },
    calculateMD5Hash: md5,
  });
  progress(1);
}

/**
 * Resets the device into the new firmware and reads its console until `until` returns a result or the timeout ends.
 * Classic ESP32 boards reset through RTS (EN) with DTR (IO0) high.
 */
export async function resetAndWatch<T>(
  c: Connection,
  onText: (text: string) => void,
  until: (text: string) => T | null,
  timeoutMs = 45000,
): Promise<T | null> {
  await c.transport.disconnect().catch(() => undefined);
  await c.transport.connect(CONSOLE_BAUD);
  await c.transport.setDTR(false);
  await c.transport.setRTS(true);
  await sleep(120);
  await c.transport.setRTS(false);

  const decoder = new TextDecoder();
  let text = "";
  let result: T | null = null;
  let closed = false;
  const reading = c.transport.rawRead(
    (chunk) => {
      text += decoder.decode(chunk, { stream: true });
      if (text.length > 200000) text = text.slice(-100000);
      onText(text);
      if (result === null) result = until(text);
      if (result !== null) closed = true;
    },
    () => closed,
  );
  const started = Date.now();
  while (!closed && Date.now() - started < timeoutMs) await sleep(200);
  closed = true;
  await c.transport.disconnect().catch(() => undefined);
  await reading.catch(() => undefined);
  return result;
}
