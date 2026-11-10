// Web Worker of the vault: runs Python (Pyodide) with the kluis package. The secret key and the open database live
// only here; the page terminates this worker to lock the vault. No network: everything is loaded from this origin
// at start, checked against kluis.json, and the Python package itself does no requests (tests/test_kern.py).
"use strict";

importScripts("./pyodide/pyodide.js");

let call = null;

async function sha256(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const ready = (async () => {
  const info = await (await fetch("./kluis.json", { cache: "no-cache" })).json();
  const pyodide = await loadPyodide({ indexURL: "./pyodide/" });
  // checkIntegrity: Pyodide compares each wheel with the sha256 in pyodide-lock.json (which maak.py pinned).
  await pyodide.loadPackage(["cryptography"], { checkIntegrity: true, messageCallback: () => {} });
  const zip = await (await fetch("./" + info.zip)).arrayBuffer();
  if ((await sha256(zip)) !== info.sha256) throw new Error("kluis.zip klopt niet met kluis.json: niet geladen.");
  pyodide.unpackArchive(zip, "zip", { extractDir: "/home/pyodide/kluis-src" });
  pyodide.runPython("import sys; sys.path.insert(0, '/home/pyodide/kluis-src')");
  const web = pyodide.pyimport("kluis.web");
  call = (name, args) => JSON.parse(web.call(name, JSON.stringify(args ?? {})));
  return { ...call("versie").result, pyodide: pyodide.version, kluis: info.version };
})();

self.onmessage = async (event) => {
  const { id, name, args } = event.data;
  try {
    if (name === "start") {
      self.postMessage({ id, ok: true, result: await ready });
      return;
    }
    await ready;
    self.postMessage({ id, ...call(name, args) });
  } catch (e) {
    self.postMessage({ id, ok: false, error: e && e.message ? e.message : String(e) });
  }
};
