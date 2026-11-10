"""Facade for the browser: JSON in, JSON out (binary as base64). The Web Worker calls `call(name, args_json)`.

State (the unlocked secret key and the open database) lives only in this Python process, in the memory of the
worker. Locking the vault terminates the worker, which discards both. Runs the same in CPython (tests/test_web.py).
"""
from __future__ import annotations

import base64
import json
import sqlite3
import sys
import time
import traceback

from . import age, db, mail

_identity: age.Identity | None = None
_db: db.Database | None = None


class UserError(Exception):
    """A message for the campaign manager (Dutch)."""


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def _bytes(value: str) -> bytes:
    return base64.b64decode(value)


def _need_identity() -> age.Identity:
    if _identity is None:
        raise UserError("De kluis is vergrendeld: ontgrendel eerst je sleutel.")
    return _identity


def _need_db() -> db.Database:
    if _db is None:
        raise UserError("Er is geen kluis open.")
    return _db


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# ---- keys ------------------------------------------------------------------------------------------------------------

def versie() -> dict:
    import cryptography

    return {"python": sys.version.split()[0], "sqlite": sqlite3.sqlite_version, "cryptography": cryptography.__version__}


def sleutel_maken() -> dict:
    """A new X25519 key pair. The identity file is the recovery key: show it once, let the user keep it offline."""
    global _identity
    _identity = age.Identity.generate()
    return {"publieke_sleutel": _identity.recipient, "herstelsleutel": _identity.identity_file(_now())}


def sleutel_beschermen(wachtwoordzin: str) -> dict:
    """The secret key, encrypted with the passphrase (age scrypt), for daily use on this device."""
    identity = _need_identity()
    if len(wachtwoordzin) < 12:
        raise UserError("Kies een wachtwoordzin van minstens 12 tekens (liever een zin van vier of meer woorden).")
    return {"bestand": _b64(age.encrypt(identity.identity_file(_now()).encode(), passphrase=wachtwoordzin))}


def sleutel_ontgrendelen(bestand: str, wachtwoordzin: str) -> dict:
    global _identity
    try:
        text = age.decrypt(_bytes(bestand), passphrase=wachtwoordzin).decode()
    except age.AgeError as e:
        raise UserError("Wachtwoordzin klopt niet." if "passphrase" in str(e) else f"Sleutelbestand onleesbaar: {e}") from e
    _identity = age.identities_from_file(text)[0]
    return {"publieke_sleutel": _identity.recipient}


def sleutel_laden(herstelsleutel: str) -> dict:
    """Open with the recovery key (identity file or the AGE-SECRET-KEY-1… line)."""
    global _identity
    try:
        _identity = age.identities_from_file(herstelsleutel)[0]
    except (age.AgeError, ValueError) as e:
        raise UserError("Dit is geen geldige herstelsleutel (AGE-SECRET-KEY-1…).") from e
    return {"publieke_sleutel": _identity.recipient}


# ---- vault -----------------------------------------------------------------------------------------------------------

def info() -> dict:
    d = _need_db()
    rows = d.participants()
    counts: dict[str, int] = {}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    return {
        "kluis_id": d.meta("kluis_id"),
        "aangemaakt": int(d.meta("aangemaakt", "0")),
        "ontvangers": d.recipients(),
        "eigen_sleutel": _identity.recipient if _identity else None,
        "deelnemers": len(rows),
        "per_status": counts,
        "sjabloon": sjabloon(),
    }


def kluis_nieuw() -> dict:
    global _db
    _db = db.Database.new([_need_identity().recipient])
    return info()


def kluis_openen(bestand: str) -> dict:
    global _db
    identity = _need_identity()
    try:
        plain = age.decrypt(_bytes(bestand), identities=[identity])
    except age.AgeError as e:
        if "no matching identity" in str(e):
            raise UserError("Deze kluis is niet versleuteld voor jouw sleutel.") from e
        raise UserError(f"Kluis onleesbaar of gewijzigd: {e}") from e
    try:
        _db = db.Database.load(plain)
    except db.VaultError as e:
        raise UserError(str(e)) from e
    return info()


def kluis_opslaan() -> dict:
    """The vault encrypted to all its recipients; the caller writes it locally and to the server."""
    d = _need_db()
    _need_identity()
    data = age.encrypt(d.dump(), recipients=d.recipients())
    return {"bestand": _b64(data), "kluis_id": d.meta("kluis_id"), "grootte": len(data)}


def ontvanger_toevoegen(publieke_sleutel: str) -> dict:
    d = _need_db()
    try:
        age.parse_recipient(publieke_sleutel)
    except (age.AgeError, ValueError) as e:
        raise UserError("Dit is geen publieke age-sleutel (age1…).") from e
    d.set_recipients(d.recipients() + [publieke_sleutel.strip()])
    d.log(None, "sleutel toegevoegd", publieke_sleutel.strip())
    return info()


def ontvanger_verwijderen(publieke_sleutel: str) -> dict:
    d = _need_db()
    if publieke_sleutel == _need_identity().recipient:
        raise UserError("Je kunt je eigen sleutel niet verwijderen: dan kun je de kluis zelf niet meer openen.")
    d.set_recipients([r for r in d.recipients() if r != publieke_sleutel])
    d.log(None, "sleutel verwijderd", publieke_sleutel)
    return info()


def vergrendelen() -> dict:
    global _identity, _db
    _identity = None
    _db = None
    return {}


# ---- participants ----------------------------------------------------------------------------------------------------

def _wrap(f, *args):
    try:
        return f(*args)
    except db.VaultError as e:
        raise UserError(str(e)) from e


def deelnemers() -> list[dict]:
    return _need_db().participants()


def toevoegen(velden: dict) -> dict:
    pid = _wrap(_need_db().add, velden)
    return _need_db().participant(pid)


def wijzigen(id: int, velden: dict) -> dict:
    _wrap(_need_db().update, id, velden)
    return _need_db().participant(id)


def verwijderen(id: int) -> dict:
    _wrap(_need_db().delete, id)
    return {}


def stoppen(id: int) -> dict:
    _wrap(_need_db().stop, id)
    return _need_db().participant(id)


def importeer_csv(tekst: str) -> dict:
    return _wrap(_need_db().import_csv, tekst)


def exporteer_csv() -> dict:
    return {"tekst": _need_db().export_csv()}


def logboek() -> list[dict]:
    return _need_db().history()


def uitnodigingen_vastleggen(campagne_id: int, uitnodigingen: list[dict]) -> dict:
    """[{deelnemer_id, account_id, url}] after the server created the accounts (POST /admin/campaigns/{id}/accounts)."""
    d = _need_db()
    for u in uitnodigingen:
        _wrap(d.record_invitation, int(u["deelnemer_id"]), campagne_id, int(u["account_id"]), str(u["url"]))
    return {"vastgelegd": len(uitnodigingen)}


# ---- mail ------------------------------------------------------------------------------------------------------------

def sjabloon() -> dict:
    d = _need_db()
    return {
        "onderwerp": d.meta("mail_onderwerp", mail.DEFAULT_SUBJECT),
        "tekst": d.meta("mail_tekst", mail.DEFAULT_BODY),
        "afzender": d.meta("mail_afzender", ""),
        "antwoordadres": d.meta("mail_antwoordadres", ""),
    }


def sjabloon_opslaan(onderwerp: str, tekst: str, afzender: str, antwoordadres: str) -> dict:
    d = _need_db()
    for key, value in (("mail_onderwerp", onderwerp), ("mail_tekst", tekst), ("mail_afzender", afzender), ("mail_antwoordadres", antwoordadres)):
        d.set_meta(key, value)
    return sjabloon()


def _messages(ids: list[int], campagne: str, helpdesk: str) -> list[dict]:
    d = _need_db()
    t = sjabloon()
    out = []
    for pid in ids:
        p = d.participant(pid)
        if not p["uitnodiging_url"]:
            raise UserError(f"Deelnemer {pid} heeft nog geen uitnodigingslink.")
        if not p["email"]:
            raise UserError(f"Deelnemer {pid} ({p['naam']}) heeft geen e-mailadres.")
        values = mail.values_for(p, campagne, helpdesk or t["antwoordadres"], t["afzender"])
        out.append({"id": pid, "naam": p["naam"], "email": p["email"], "account": p["account_id"],
                    "onderwerp": mail.render(t["onderwerp"], values), "tekst": mail.render(t["tekst"], values),
                    "link": p["uitnodiging_url"]})
    return out


def mails(ids: list[int], campagne: str, helpdesk: str = "") -> list[dict]:
    """Per participant a mailto link (opens the own mail program with the invitation filled in)."""
    return [dict(m, mailto=mail.mailto(m["email"], m["onderwerp"], m["tekst"])) for m in _messages(ids, campagne, helpdesk)]


def eml_zip(ids: list[int], campagne: str, helpdesk: str = "") -> dict:
    t = sjabloon()
    reply = helpdesk or t["antwoordadres"]
    files = [(f"uitnodiging-{m['account'] or m['id']}.eml", mail.eml(m["naam"], m["email"], m["onderwerp"], m["tekst"], reply))
             for m in _messages(ids, campagne, helpdesk)]
    return {"bestand": _b64(mail.eml_zip(files)), "aantal": len(files)}


def samenvoeg_csv(ids: list[int], campagne: str, helpdesk: str = "") -> dict:
    rows = [{"email": m["email"], "naam": m["naam"], "onderwerp": m["onderwerp"], "link": m["link"], "account": m["account"]}
            for m in _messages(ids, campagne, helpdesk)]
    return {"tekst": mail.merge_csv(rows)}


def gemaild(ids: list[int], hoe: str) -> dict:
    _wrap(_need_db().record_mailed, ids, hoe)
    return {}


# ---- dispatch --------------------------------------------------------------------------------------------------------

FUNCTIONS = {f.__name__: f for f in [
    versie, sleutel_maken, sleutel_beschermen, sleutel_ontgrendelen, sleutel_laden, info, kluis_nieuw, kluis_openen,
    kluis_opslaan, ontvanger_toevoegen, ontvanger_verwijderen, vergrendelen, deelnemers, toevoegen, wijzigen, verwijderen,
    stoppen, importeer_csv, exporteer_csv, logboek, uitnodigingen_vastleggen, sjabloon, sjabloon_opslaan, mails, eml_zip,
    samenvoeg_csv, gemaild,
]}


def call(name: str, args_json: str) -> str:
    """{"ok": true, "result": …} or {"ok": false, "error": "…"}. Unexpected errors carry no data from the vault."""
    try:
        f = FUNCTIONS[name]
        result = f(**json.loads(args_json or "{}"))
        return json.dumps({"ok": True, "result": result})
    except UserError as e:
        return json.dumps({"ok": False, "error": str(e)})
    except KeyError:
        return json.dumps({"ok": False, "error": f"onbekende functie {name}"})
    except Exception as e:  # programming error: type and place, not the content
        tb = traceback.extract_tb(e.__traceback__)[-1]
        return json.dumps({"ok": False, "error": f"interne fout: {type(e).__name__} in {tb.name} (regel {tb.lineno})"})
