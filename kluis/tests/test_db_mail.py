# SPDX-License-Identifier: EUPL-1.2
import io
import zipfile

import pytest

from kluis import db, mail


def test_participants_csv_and_dump():
    d = db.Database.new(["age1qqq"], now=1)
    pid = d.add({"naam": "Anna de Vries", "email": "anna@example.org", "plaats": "Zwolle"}, now=2)
    result = d.import_csv("naam;email;telefoon\nBert;bert@example.org;0612345678\nAnna dubbel;ANNA@example.org;\n;;\n", now=3)
    assert result == {"toegevoegd": 1, "overgeslagen": 2}
    d.record_invitation(pid, 2, 41, "https://energiegedrag.nl/invite/x", now=4)
    assert d.participant(pid)["status"] == "uitgenodigd"
    with pytest.raises(db.VaultError):
        d.delete(pid)
    d.record_mailed([pid], "eml", now=5)
    assert d.participant(pid)["status"] == "gemaild"

    again = db.Database.load(d.dump())
    assert [p["naam"] for p in again.participants()] == ["Anna de Vries", "Bert"]
    assert again.recipients() == ["age1qqq"]
    csv_text = again.export_csv()
    assert csv_text.splitlines()[0].startswith("id,campagne_id,account_id,naam,email")
    assert "Bert,bert@example.org,0612345678" in csv_text

    with pytest.raises(db.VaultError):
        db.Database.load(b"geen database")
    with pytest.raises(db.VaultError):
        d.import_csv("kolom1,kolom2\na,b\n")


def test_mail_forms():
    body = mail.render(mail.DEFAULT_BODY, {"naam": "Anna", "campagne": "Winter", "link": "https://x/y", "helpdesk": "h@x", "afzender": "Team"})
    assert "Beste Anna" in body and "https://x/y" in body and "${" not in body
    url = mail.mailto("anna@example.org", "Uitnodiging: Winter", "regel 1\nregel 2")
    assert url.startswith("mailto:anna@example.org?subject=Uitnodiging%3A%20Winter&body=regel%201%0D%0Aregel%202")
    raw = mail.eml("Anna", "anna@example.org", "Onderwerp", "Tekst", reply_to="helpdesk@example.org")
    assert b"X-Unsent: 1" in raw and b"Reply-To: helpdesk@example.org" in raw
    z = mail.eml_zip([("a.eml", raw)])
    assert z == mail.eml_zip([("a.eml", raw)])  # reproducible
    assert zipfile.ZipFile(io.BytesIO(z)).read("a.eml") == raw


def test_eml_keeps_long_link_intact():
    import email

    link = "https://energiegedrag.nl/nfh/activate?prod_token=" + "eyJhbGciOiJFUzI1NiJ9." + "a" * 300
    body = mail.render(mail.DEFAULT_BODY, {"naam": "Zoë", "campagne": "Winter", "link": link, "helpdesk": "h@x", "afzender": "Team"})
    raw = mail.eml("Zoë", "zoe@example.org", "Uitnodiging: Winter", body)
    assert b"Content-Transfer-Encoding: 8bit" in raw
    assert raw.count(b"\n") == raw.count(b"\r\n")  # CRLF only
    assert link.encode() + b"\r\n" in raw  # the link on one line, no soft breaks or =3D
    assert b"=\r\n" not in raw
    parsed = email.message_from_bytes(raw, policy=email.policy.default)
    assert link in parsed.get_content() and "Beste Zoë" in parsed.get_content()
