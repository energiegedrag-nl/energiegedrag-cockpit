"""Invitation mails for the campaign manager's own mail program: mailto links, .eml drafts and a merge CSV.

Nothing is sent from here. The mail program of the campaign manager sends, with its own account; no mail
credentials are needed anywhere in the Cockpit or on the NeedForHeat server.
"""
from __future__ import annotations

import csv
import io
import zipfile
from email.message import EmailMessage
from email.utils import formataddr
from string import Template
from urllib.parse import quote

DEFAULT_SUBJECT = "Uitnodiging: ${campagne}"
DEFAULT_BODY = """Beste ${naam},

Fijn dat je meedoet aan ${campagne}. Met de link hieronder koppel je de NeedForHeat-app aan je deelname.
Open hem op je telefoon, of scan de QR-code die je van ons kreeg:

${link}

Deze link is persoonlijk: deel hem niet met anderen.

Vragen? Mail naar ${helpdesk}.

Met vriendelijke groet,
${afzender}
"""

PLACEHOLDERS = ["naam", "campagne", "link", "helpdesk", "afzender", "account"]


def render(template: str, values: dict) -> str:
    """${name} placeholders; unknown placeholders stay as they are."""
    return Template(template).safe_substitute({k: str(values.get(k, "")) for k in PLACEHOLDERS})


def values_for(participant: dict, campagne: str, helpdesk: str, afzender: str) -> dict:
    return {
        "naam": participant.get("naam") or "deelnemer",
        "campagne": campagne,
        "link": participant.get("uitnodiging_url", ""),
        "helpdesk": helpdesk,
        "afzender": afzender,
        "account": participant.get("account_id") or "",
    }


def mailto(to: str, subject: str, body: str) -> str:
    """RFC 6068 mailto URL (line breaks as CRLF)."""
    q = lambda s: quote(s, safe="")  # noqa: E731
    return f"mailto:{quote(to, safe='@')}?subject={q(subject)}&body={q(body.replace(chr(10), chr(13) + chr(10)))}"


def eml(to_name: str, to: str, subject: str, body: str, reply_to: str = "") -> bytes:
    """An unsent draft; Outlook and Thunderbird open it ready to send (X-Unsent)."""
    msg = EmailMessage()
    msg["To"] = formataddr((to_name, to)) if to_name else to
    msg["Subject"] = subject
    if reply_to:
        msg["Reply-To"] = reply_to
    msg["X-Unsent"] = "1"
    msg.set_content(body)
    return bytes(msg)


def eml_zip(messages: list[tuple[str, bytes]]) -> bytes:
    """Zip with fixed timestamps (same input gives the same bytes)."""
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in messages:
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, data)
    return out.getvalue()


def merge_csv(rows: list[dict]) -> str:
    """For mail merge in Word/Outlook or another mail tool: one row per participant."""
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=["email", "naam", "onderwerp", "link", "account"], lineterminator="\n")
    writer.writeheader()
    for r in rows:
        writer.writerow(r)
    return out.getvalue()
