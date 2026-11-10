# SPDX-License-Identifier: EUPL-1.2
"""The participant database of the vault: SQLite in memory, saved as a whole (serialized and age-encrypted).

It links a person (name, contact details) to a pseudonymous NeedForHeat account number. The NeedForHeat server only
knows the account number; this database is the only place where the link exists.

A readable text form (CSV) goes both ways: import a list of participants, export for your own administration.
"""
from __future__ import annotations

import csv
import io
import sqlite3
import time
import uuid

SCHEMA_VERSION = "1"

SCHEMA = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE deelnemer (
    id INTEGER PRIMARY KEY,
    campagne_id INTEGER,                 -- NeedForHeat campaign, NULL while not invited
    account_id INTEGER UNIQUE,           -- NeedForHeat account (the pseudonym), NULL while not invited
    naam TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    telefoon TEXT NOT NULL DEFAULT '',
    adres TEXT NOT NULL DEFAULT '',
    postcode TEXT NOT NULL DEFAULT '',
    plaats TEXT NOT NULL DEFAULT '',
    apparaat TEXT NOT NULL DEFAULT '',   -- e.g. inventory number or device name
    notities TEXT NOT NULL DEFAULT '',
    uitnodiging_url TEXT NOT NULL DEFAULT '',
    uitgenodigd_op INTEGER,
    gemaild_op INTEGER,
    gestopt_op INTEGER,
    aangemaakt INTEGER NOT NULL,
    gewijzigd INTEGER NOT NULL
);
CREATE TABLE logboek (
    id INTEGER PRIMARY KEY,
    op INTEGER NOT NULL,
    deelnemer_id INTEGER,
    actie TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT ''
);
"""

# Fields a user may edit or import, in CSV column order.
FIELDS = ["naam", "email", "telefoon", "adres", "postcode", "plaats", "apparaat", "notities"]
EXPORT = ["id", "campagne_id", "account_id", *FIELDS, "status", "uitnodiging_url", "uitgenodigd_op", "gemaild_op", "gestopt_op"]


class VaultError(Exception):
    pass


def status_of(row: dict) -> str:
    if row.get("gestopt_op"):
        return "gestopt"
    if row.get("gemaild_op"):
        return "gemaild"
    if row.get("account_id"):
        return "uitgenodigd"
    return "nieuw"


class Database:
    def __init__(self, conn: sqlite3.Connection):
        conn.row_factory = sqlite3.Row
        self.conn = conn

    @classmethod
    def new(cls, recipients: list[str], now: int | None = None) -> "Database":
        conn = sqlite3.connect(":memory:")
        conn.executescript(SCHEMA)
        db = cls(conn)
        now = now or int(time.time())
        db.set_meta("schema", SCHEMA_VERSION)
        db.set_meta("kluis_id", str(uuid.uuid4()))
        db.set_meta("aangemaakt", str(now))
        db.set_recipients(recipients)
        db.log(None, "kluis aangemaakt", now=now)
        return db

    @classmethod
    def load(cls, data: bytes) -> "Database":
        conn = sqlite3.connect(":memory:")
        try:
            conn.deserialize(data)
            schema = conn.execute("SELECT value FROM meta WHERE key = 'schema'").fetchone()
        except sqlite3.DatabaseError as e:
            raise VaultError("dit is geen kluisdatabase") from e
        if not schema or schema[0] != SCHEMA_VERSION:
            raise VaultError(f"onbekende kluisversie {schema[0] if schema else '?'}")
        return cls(conn)

    def dump(self) -> bytes:
        self.conn.commit()
        return self.conn.serialize()

    # ---- meta ----------------------------------------------------------------------------------------------------

    def meta(self, key: str, default: str = "") -> str:
        row = self.conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row[0] if row else default

    def set_meta(self, key: str, value: str) -> None:
        self.conn.execute("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))

    def recipients(self) -> list[str]:
        return [r for r in self.meta("ontvangers").split("\n") if r]

    def set_recipients(self, recipients: list[str]) -> None:
        if not recipients:
            raise VaultError("een kluis heeft minstens één sleutel nodig")
        self.set_meta("ontvangers", "\n".join(dict.fromkeys(recipients)))

    def log(self, deelnemer_id: int | None, actie: str, details: str = "", now: int | None = None) -> None:
        self.conn.execute("INSERT INTO logboek (op, deelnemer_id, actie, details) VALUES (?, ?, ?, ?)",
                          (now or int(time.time()), deelnemer_id, actie, details))

    # ---- participants --------------------------------------------------------------------------------------------

    def participants(self) -> list[dict]:
        rows = [dict(r) for r in self.conn.execute("SELECT * FROM deelnemer ORDER BY id")]
        for r in rows:
            r["status"] = status_of(r)
        return rows

    def participant(self, pid: int) -> dict:
        row = self.conn.execute("SELECT * FROM deelnemer WHERE id = ?", (pid,)).fetchone()
        if row is None:
            raise VaultError(f"deelnemer {pid} bestaat niet")
        r = dict(row)
        r["status"] = status_of(r)
        return r

    def add(self, fields: dict, now: int | None = None) -> int:
        now = now or int(time.time())
        values = {k: str(fields.get(k, "") or "").strip() for k in FIELDS}
        if not values["naam"] and not values["email"]:
            raise VaultError("geef minstens een naam of e-mailadres")
        cur = self.conn.execute(
            f"INSERT INTO deelnemer ({', '.join(FIELDS)}, aangemaakt, gewijzigd) VALUES ({', '.join('?' * len(FIELDS))}, ?, ?)",
            (*values.values(), now, now),
        )
        self.log(cur.lastrowid, "toegevoegd", now=now)
        return int(cur.lastrowid)

    def update(self, pid: int, fields: dict, now: int | None = None) -> None:
        self.participant(pid)
        changes = {k: str(v or "").strip() for k, v in fields.items() if k in FIELDS}
        if not changes:
            return
        now = now or int(time.time())
        sets = ", ".join(f"{k} = ?" for k in changes)
        self.conn.execute(f"UPDATE deelnemer SET {sets}, gewijzigd = ? WHERE id = ?", (*changes.values(), now, pid))
        self.log(pid, "gewijzigd", ", ".join(sorted(changes)), now=now)

    def delete(self, pid: int) -> None:
        p = self.participant(pid)
        if p["account_id"]:
            raise VaultError("deze deelnemer heeft al een NeedForHeat-account; markeer als gestopt in plaats van verwijderen")
        self.conn.execute("DELETE FROM deelnemer WHERE id = ?", (pid,))
        self.log(pid, "verwijderd")

    def stop(self, pid: int, now: int | None = None) -> None:
        self.participant(pid)
        now = now or int(time.time())
        self.conn.execute("UPDATE deelnemer SET gestopt_op = ?, gewijzigd = ? WHERE id = ?", (now, now, pid))
        self.log(pid, "gestopt", now=now)

    def record_invitation(self, pid: int, campagne_id: int, account_id: int, url: str, now: int | None = None) -> None:
        p = self.participant(pid)
        if p["account_id"] and p["account_id"] != account_id:
            raise VaultError(f"deelnemer {pid} heeft al account {p['account_id']}")
        now = now or int(time.time())
        self.conn.execute(
            "UPDATE deelnemer SET campagne_id = ?, account_id = ?, uitnodiging_url = ?, uitgenodigd_op = ?, gewijzigd = ? WHERE id = ?",
            (campagne_id, account_id, url, now, now, pid),
        )
        self.log(pid, "uitgenodigd", f"campagne {campagne_id}, account {account_id}", now=now)

    def record_mailed(self, pids: list[int], how: str, now: int | None = None) -> None:
        now = now or int(time.time())
        for pid in pids:
            self.participant(pid)
            self.conn.execute("UPDATE deelnemer SET gemaild_op = ?, gewijzigd = ? WHERE id = ?", (now, now, pid))
            self.log(pid, "uitnodiging gemaild", how, now=now)

    def history(self, limit: int = 200) -> list[dict]:
        return [dict(r) for r in self.conn.execute("SELECT * FROM logboek ORDER BY id DESC LIMIT ?", (limit,))]

    # ---- text form -----------------------------------------------------------------------------------------------

    def import_csv(self, text: str, now: int | None = None) -> dict:
        """Adds a row per participant. Columns by header name (FIELDS); ',' or ';' as separator. Skips duplicates by e-mail."""
        text = text.lstrip("﻿")
        try:
            dialect = csv.Sniffer().sniff(text.split("\n", 1)[0], delimiters=",;\t")
        except csv.Error:
            dialect = csv.excel
        reader = csv.DictReader(io.StringIO(text), dialect=dialect)
        header = [h.strip().lower() for h in reader.fieldnames or []]
        if not any(h in FIELDS for h in header):
            raise VaultError(f"geen bekende kolommen; gebruik als kop: {', '.join(FIELDS)}")
        known = {r["email"].lower() for r in self.participants() if r["email"]}
        added = skipped = 0
        for raw in reader:
            row = {(k or "").strip().lower(): (v or "").strip() for k, v in raw.items()}
            email = row.get("email", "").lower()
            if email and email in known:
                skipped += 1
                continue
            if not row.get("naam") and not email:
                skipped += 1
                continue
            self.add(row, now=now)
            known.add(email)
            added += 1
        return {"toegevoegd": added, "overgeslagen": skipped}

    def export_csv(self) -> str:
        out = io.StringIO()
        writer = csv.DictWriter(out, fieldnames=EXPORT, extrasaction="ignore", lineterminator="\n")
        writer.writeheader()
        for row in self.participants():
            writer.writerow({k: "" if row.get(k) is None else row[k] for k in EXPORT})
        return out.getvalue()
