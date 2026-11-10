"""Serve the built Cockpit with a fake /api (sample data, nothing real).
Usage: python -I mock_server.py <dist-dir> [port] [firmware-dir]
The firmware dir (output of mirror/mirror.py) is served under /firmware/; the inventory lives in memory."""
import json
import os
import re
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DIST = Path(sys.argv[1]).resolve()
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 5178
FIRMWARE = Path(sys.argv[3]).resolve() if len(sys.argv) > 3 else None
NOW = int(time.time())
H, D = 3600, 86400

OVERVIEW = {
    "apps": [{"id": 1, "name": "NeedForHeat", "provisioning_url_template": "https://energiegedrag.nl/nfh/invite/<account_activation_token>", "oauth_redirect_url": ""}],
    "campaigns": [
        {"id": 2, "name": "Voorbeeld winter 2026", "app": "NeedForHeat", "info_url": "https://manuals.energiegedrag.nl/voorbeeld", "start_time": NOW - 20 * D,
         "end_time": NOW + 120 * D, "state": "running", "data_source_list_id": 1, "data_source_list": "Thuis basis", "accounts": 5, "activated": 4},
        {"id": 1, "name": "Voorbeeld proef", "app": "NeedForHeat", "info_url": "https://manuals.energiegedrag.nl/proef", "start_time": NOW - 200 * D,
         "end_time": NOW - 100 * D, "state": "ended", "data_source_list_id": 1, "data_source_list": "Thuis basis", "accounts": 3, "activated": 3},
    ],
    "data_source_lists": [{"id": 1, "name": "Thuis basis", "items": 3}],
    "generated_at": NOW,
}
SOURCES = [
    {"id": 11, "category": "device_type", "name": "P1-Reader", "upload_schedule": "0 */1 * * *", "notification_threshold": "P1D"},
    {"id": 12, "category": "device_type", "name": "Living-Room-Module", "upload_schedule": "*/30 * * * *", "notification_threshold": "PT12H"},
    {"id": 13, "category": "energy_query_type", "name": "building-profile", "upload_schedule": "", "notification_threshold": ""},
]


def src(sid, state, latest=None, act=None, inst=None):
    s = {"source_id": sid, "state": state, "activated_at": act, "latest_upload": latest}
    if inst:
        s["instance"] = inst
    return s


ACCOUNTS = [
    {"id": 7, "activated_at": NOW - 15 * D, "state": "attention", "sources": [
        src(11, "ok", NOW - 40 * 60, NOW - 15 * D, "NFH-P1-1A2B"), src(12, "late", NOW - 2 * D, NOW - 15 * D, "NFH-LRM-3C4D"), src(13, "ok", NOW - 14 * D, NOW - 14 * D)]},
    {"id": 8, "activated_at": NOW - 10 * D, "state": "active", "sources": [
        src(11, "ok", NOW - 20 * 60, NOW - 10 * D, "NFH-P1-5E6F"), src(12, "ok", NOW - 25 * 60, NOW - 10 * D, "NFH-LRM-7A8B"), src(13, "ok", NOW - 9 * D, NOW - 9 * D)]},
    {"id": 9, "activated_at": NOW - 3 * D, "state": "incomplete", "sources": [
        src(11, "waiting", None, NOW - 3 * H, "NFH-P1-9C0D"), src(12, "missing"), src(13, "ok", NOW - 3 * D, NOW - 3 * D)]},
    {"id": 10, "activated_at": NOW - 2 * D, "state": "active", "sources": [
        src(11, "ok", NOW - 5 * 60, NOW - 2 * D, "NFH-P1-1E2F"), src(12, "ok", NOW - 10 * 60, NOW - 2 * D, "NFH-LRM-3A4B"), src(13, "ok", NOW - 2 * D, NOW - 2 * D)]},
    {"id": 11, "activated_at": None, "state": "invited", "sources": [src(11, "missing"), src(12, "missing"), src(13, "missing")]},
]
STATUS = {"campaign": OVERVIEW["campaigns"][0], "sources": SOURCES, "accounts": ACCOUNTS,
          "totals": {"invited": 1, "active": 2, "incomplete": 1, "attention": 1}, "generated_at": NOW}
next_id = [12]

# Inventory (in memory): two sample devices, one of them activated by the app.
INVENTORY = {}
EVENTS = {}


def inv_add(mac, name, state, account=None, in_use=None, age=D):
    i = len(INVENTORY) + 1
    INVENTORY[i] = {"id": i, "mac": mac, "chip": "ESP32", "device_type": "twomes-p1-reader-firmware", "name": name,
                    "firmware": "energiegedrag-nl/needforheat-p1-reader-firmware", "firmware_version": "v1.0.0 ESP32DEV_PRODUCTION_SERVER",
                    "state": state, "account_id": account, "note": "", "created_at": NOW - age, "updated_at": NOW - age // 2, "in_use": in_use}
    EVENTS[i] = [{"id": 1, "at": NOW - age, "event": "flash", "state": "flashed", "account_id": None, "details": "v1.0.0"}]
    if account:
        EVENTS[i].insert(0, {"id": 2, "at": NOW - age // 2, "event": "assign", "state": "assigned", "account_id": account, "details": ""})


inv_add("24:0A:C4:11:22:33", "5A1C-112233", "shipped", 7, {"account_id": 7, "campaign_id": 2, "activated_at": NOW - 15 * D}, 20 * D)
inv_add("24:0A:C4:44:55:66", "5A1C-445566", "flashed", None, None, 2 * D)
VAULTS = {}  # vault id -> list of versions (bytes); only stores, never reads
MAIL = {2: {"campaign_id": 2, "enabled": True, "helpdesk_alias": "helpdesk-winter@energiegedrag.nl", "updated_at": NOW - D}}
NEXT = {"flash": "flashed", "assign": "assigned", "ship": "shipped", "return": "returned", "erase": "erased"}
ALLOWED = {"assign": {"flashed", "assigned"}, "ship": {"assigned"}, "return": {"assigned", "shipped"}}


def inv_full(i):
    return dict(INVENTORY[i], events=sorted(EVENTS[i], key=lambda e: -e["at"]))


def inv_event(i, event, state, account=None, details=""):
    EVENTS[i].append({"id": len(EVENTS[i]) + 1, "at": int(time.time()), "event": event, "state": state, "account_id": account, "details": details})


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(DIST), **kw)

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        if self.headers.get("Authorization", "") != "Bearer demo":
            self.send_json({"message": "unauthorized"}, 401)
            return False
        return True

    def do_GET(self):
        if self.path.startswith("/api/"):
            if not self.authorized():
                return
            if self.path == "/api/admin/overview":
                return self.send_json(OVERVIEW)
            if self.path.startswith("/api/admin/campaigns/") and self.path.endswith("/status"):
                return self.send_json(STATUS)
            m = re.fullmatch(r"/api/admin/campaigns/(\d+)/mail", self.path)
            if m:
                cid = int(m.group(1))
                return self.send_json(MAIL.get(cid, {"campaign_id": cid, "enabled": False, "helpdesk_alias": "", "updated_at": None}))
            m = re.fullmatch(r"/api/admin/vaults/([0-9a-f-]{36})", self.path)
            if m:
                versions = VAULTS.get(m.group(1))
                if not versions:
                    return self.send_json({"message": "not found"}, 404)
                body = versions[-1]
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("X-Vault-Version", str(len(versions)))
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if self.path == "/api/admin/inventory":
                return self.send_json(sorted(INVENTORY.values(), key=lambda d: -d["updated_at"]))
            m = re.fullmatch(r"/api/admin/inventory/mac/([0-9A-Fa-f]{12})", self.path)
            if m:
                mac = ":".join(m.group(1).upper()[k:k + 2] for k in range(0, 12, 2))
                hit = [i for i, d in INVENTORY.items() if d["mac"] == mac]
                return self.send_json(inv_full(hit[0])) if hit else self.send_json({"message": "not found"}, 404)
            m = re.fullmatch(r"/api/admin/inventory/(\d+)", self.path)
            if m and int(m.group(1)) in INVENTORY:
                return self.send_json(inv_full(int(m.group(1))))
            return self.send_json({"message": "not found"}, 404)
        if self.path.split("?")[0] == "/config.json":  # links between Cockpit and vault (two origins)
            return self.send_json({"kluis_url": os.environ.get("KLUIS_URL", "http://localhost:5179/"),
                                   "cockpit_url": os.environ.get("COCKPIT_URL", "http://localhost:5178/")})
        if self.path.startswith("/firmware/"):
            rel = self.path[len("/firmware/"):].split("?")[0]
            target = (FIRMWARE / rel).resolve() if FIRMWARE else None
            if not target or FIRMWARE not in target.parents or not target.is_file():
                self.send_response(404)
                self.end_headers()
                return
            body = target.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/json" if rel.endswith(".json") else "application/octet-stream")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if not (DIST / self.path.lstrip("/").split("?")[0]).is_file():
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        if not self.authorized():
            return
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path.endswith("/accounts") and "/campaigns/" in self.path:
            out = []
            for _ in range(int(body.get("count", 1))):
                out.append({"account_id": next_id[0], "invitation_url": f"https://energiegedrag.nl/nfh/invite/voorbeeld-token-{next_id[0]}"})
                next_id[0] += 1
            return self.send_json(out)
        if self.path == "/api/admin/inventory/flash":
            mac = body["mac"].upper()
            hit = [i for i, d in INVENTORY.items() if d["mac"] == mac]
            i = hit[0] if hit else len(INVENTORY) + 1
            old = INVENTORY.get(i)
            if old and old["state"] in ("assigned", "shipped") and not body.get("force"):
                return self.send_json({"message": "device is still assigned to a participant; flash again with force to unlink it"}, 409)
            INVENTORY[i] = {"id": i, "mac": mac, "chip": body["chip"], "device_type": body["device_type"], "name": body["name"],
                            "firmware": body["firmware"], "firmware_version": body["firmware_version"], "state": "flashed",
                            "account_id": None, "note": old["note"] if old else "", "created_at": old["created_at"] if old else int(time.time()),
                            "updated_at": int(time.time()), "in_use": None}
            EVENTS.setdefault(i, [])
            inv_event(i, "flash", "flashed", None, body["firmware_version"])
            return self.send_json(inv_full(i))
        m = re.fullmatch(r"/api/admin/inventory/(\d+)/events", self.path)
        if m and int(m.group(1)) in INVENTORY:
            i, d, ev = int(m.group(1)), INVENTORY[int(m.group(1))], body.get("event")
            if ev == "note":
                d["note"] = body.get("details", "")
                inv_event(i, "note", d["state"], d["account_id"], d["note"])
                return self.send_json(inv_full(i))
            if ev not in NEXT or ev == "flash" or (ev in ALLOWED and d["state"] not in ALLOWED[ev]):
                return self.send_json({"message": "event not allowed in the current state"}, 409)
            if ev == "assign":
                if body.get("account_id") not in (7, 8, 9, 10, 11):
                    return self.send_json({"message": "unknown account"}, 400)
                d["account_id"] = body["account_id"]
            d["state"] = NEXT[ev]
            if d["state"] not in ("assigned", "shipped"):
                d["account_id"] = None
            d["updated_at"] = int(time.time())
            inv_event(i, ev, d["state"], d["account_id"], body.get("details", ""))
            return self.send_json(inv_full(i))
        if self.path.endswith("/invitation"):
            return self.send_json({"account_id": int(self.path.split("/")[-2]), "invitation_url": "https://energiegedrag.nl/nfh/invite/nieuw-voorbeeld"})
        return self.send_json({"message": "not found"}, 404)

    def do_PUT(self):
        if not self.authorized():
            return
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n)
        m = re.fullmatch(r"/api/admin/vaults/([0-9a-f-]{36})", self.path)
        if m:
            if not raw.startswith(b"age-encryption.org/v1" + bytes([10])):
                return self.send_json({"message": "only age-encrypted vaults are accepted"}, 400)
            versions = VAULTS.setdefault(m.group(1), [])
            if int(self.headers.get("X-Vault-Base-Version", "-1")) != len(versions):
                return self.send_json({"message": "vault was changed in the meantime"}, 409)
            versions.append(raw)
            return self.send_json({"version": len(versions)})
        m = re.fullmatch(r"/api/admin/campaigns/(\d+)/mail", self.path)
        if m:
            body = json.loads(raw or b"{}")
            MAIL[int(m.group(1))] = {"campaign_id": int(m.group(1)), "enabled": bool(body.get("enabled")),
                                     "helpdesk_alias": body.get("helpdesk_alias", ""), "updated_at": int(time.time())}
            return self.send_json(MAIL[int(m.group(1))])
        return self.send_json({"message": "not found"}, 404)

    def log_message(self, fmt, *a):
        if os.environ.get("MOCK_LOG"):
            print(time.strftime("%H:%M:%S"), fmt % a, file=sys.stderr, flush=True)
            sys.stderr.flush()


ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
