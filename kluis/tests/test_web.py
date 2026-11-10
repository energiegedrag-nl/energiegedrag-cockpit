# SPDX-License-Identifier: EUPL-1.2
"""The facade end to end, as the worker uses it: key, vault, participants, invitations, mails, reopen."""
import base64
import importlib
import json

import pytest

from kluis import age


@pytest.fixture()
def web(monkeypatch):
    monkeypatch.setattr(age, "SCRYPT_LOG_N", 10)  # fast in tests; the real default is 18
    from kluis import web

    importlib.reload(web)
    return web


def call(web, name, **args):
    out = json.loads(web.call(name, json.dumps(args)))
    if not out["ok"]:
        raise AssertionError(out["error"])
    return out["result"]


def test_flow(web):
    key = call(web, "sleutel_maken")
    assert key["herstelsleutel"].count("AGE-SECRET-KEY-1") == 1 and key["publieke_sleutel"].startswith("age1")
    protected = call(web, "sleutel_beschermen", wachtwoordzin="vier woorden als zin")["bestand"]
    info = call(web, "kluis_nieuw")
    assert info["ontvangers"] == [key["publieke_sleutel"]]

    anna = call(web, "toevoegen", velden={"naam": "Anna", "email": "anna@example.org"})
    call(web, "importeer_csv", tekst="naam,email\nBert,bert@example.org\n")
    call(web, "uitnodigingen_vastleggen", campagne_id=2, uitnodigingen=[{"deelnemer_id": anna["id"], "account_id": 41, "url": "https://e/i/t"}])
    mails = call(web, "mails", ids=[anna["id"]], campagne="Winter", helpdesk="helpdesk-winter@energiegedrag.nl")
    assert mails[0]["mailto"].startswith("mailto:anna@example.org?") and "helpdesk-winter" in mails[0]["tekst"]
    assert json.loads(web.call("mails", json.dumps({"ids": [anna["id"] + 1], "campagne": "Winter"})))["error"].startswith("Deelnemer")
    z = call(web, "eml_zip", ids=[anna["id"]], campagne="Winter")
    assert z["aantal"] == 1 and base64.b64decode(z["bestand"])[:2] == b"PK"

    other = age.Identity.generate()
    call(web, "ontvanger_toevoegen", publieke_sleutel=other.recipient)
    saved = call(web, "kluis_opslaan")
    blob = base64.b64decode(saved["bestand"])
    assert b"Anna" not in blob and age.recipients_of(blob) == 2

    # The other manager opens it with their own key.
    assert age.decrypt(blob, identities=[other]).startswith(b"SQLite format 3")

    # Reopen: lock, unlock with the passphrase, open.
    call(web, "vergrendelen")
    assert not json.loads(web.call("deelnemers", "{}"))["ok"]
    wrong = json.loads(web.call("sleutel_ontgrendelen", json.dumps({"bestand": protected, "wachtwoordzin": "fout fout fout"})))
    assert "klopt niet" in wrong["error"]
    call(web, "sleutel_ontgrendelen", bestand=protected, wachtwoordzin="vier woorden als zin")
    info = call(web, "kluis_openen", bestand=saved["bestand"])
    assert info["deelnemers"] == 2 and info["per_status"] == {"uitgenodigd": 1, "nieuw": 1}

    # The recovery key opens it too.
    call(web, "vergrendelen")
    call(web, "sleutel_laden", herstelsleutel=key["herstelsleutel"])
    assert call(web, "kluis_openen", bestand=saved["bestand"])["kluis_id"] == info["kluis_id"]


def test_errors_carry_no_data(web):
    call(web, "sleutel_maken")
    call(web, "kluis_nieuw")
    out = json.loads(web.call("wijzigen", json.dumps({"id": "geen getal", "velden": {"naam": "Geheime Naam"}})))
    assert not out["ok"] and "Geheime" not in out["error"]
