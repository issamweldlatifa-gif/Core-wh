"""STATION DISPLAY v2 — end-to-end smoke test (owner order 2026-09-16, stage 2).

Boots nothing itself: point it at a RUNNING API and the database that API uses.

  cd backend && npm run start:prod          # or: npm run start:dev
  python3 tools/station-display-smoke.py    # 36 checks, exits 1 on any failure

It proves the whole contract of the interactive display stage on real rows:
  read-only by default -> interactive opt-in -> print/reprint/ack/help/exception
  -> audit with the display identity -> fleet console + bulk -> revocation
  (disable / regenerate kill read AND write) -> per-display rate limit.

Adjust BASE / PSQL below for another environment (they default to a local dev
stack: API :3000, PostgreSQL on /tmp:5433).
"""

import json
import os
import subprocess
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:3000/api/v1"
PSQL = ["/usr/lib/postgresql/17/bin/psql", "-h", "/tmp", "-p", "5433", "-U", "postgres", "-d", "ayrovi", "-t", "-A", "-c"]
results = []


def call(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{BASE}{path}", data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw


def sql(query):
    out = subprocess.run(PSQL + [query], capture_output=True, text=True)
    if out.returncode != 0:
        print(f"   (sql warning: {out.stderr.strip().splitlines()[-1] if out.stderr.strip() else 'failed'})")
    return out.stdout.strip()


def check(name, ok, detail=""):
    results.append((ok, name, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


# 1) login
# Same convention as the e2e specs: the seeded admin comes from the env,
# documented default for a local dev stack.
ADMIN_CODE = os.environ.get("INITIAL_ADMIN_CODE", "ADMIN001")
ADMIN_PASS = os.environ.get("INITIAL_ADMIN_PASSWORD", "ChangeMe!2024")
st, tok = call("POST", "/auth/login", {"identifier": ADMIN_CODE, "secret": ADMIN_PASS, "mode": "password", "app": "ADMIN_WEB"})
token = tok.get("accessToken")
check("admin login", st in (200, 201) and bool(token), f"HTTP {st}")

# 2) a station to play with
st, station = call("POST", "/stations", {"code": "SMOKE-01", "name": "Smoke Receiving", "department": "RECEIVING", "capabilities": ["CAMERA"]}, token)
if st == 409:  # already created by a previous run
    st, allst = call("GET", "/stations", None, token)
    station = [s for s in allst if s["code"] == "SMOKE-01"][0]
check("station created", st in (200, 201) or station.get("code") == "SMOKE-01", f"HTTP {st}")

# 3) a display (read-only by default)
st, disp = call("POST", f"/stations/{station['id']}/displays", {"name": "Smoke Wall"}, token)
tok_key = disp["accessToken"]
check("display created with url", st in (200, 201) and disp["urlPath"] == f"/display/{tok_key}", f"HTTP {st}")

# 4) snapshot: read-only contract
st, snap = call("GET", f"/display-views/{tok_key}")
check("public snapshot works without auth", st == 200 and snap["enabled"] is True)
check("DEFAULT is read-only (no action offered)", snap["options"]["interactive"] is False and snap["options"]["actions"] == [])

# 5) every action refused while read-only
st, err = call("POST", f"/display-views/{tok_key}/actions/ack", {})
check("ack refused on a read-only display", st == 403 and err.get("message") == "DISPLAY_READ_ONLY", f"HTTP {st} {err.get('message')}")
st, err = call("POST", f"/display-views/{tok_key}/actions/print", {})
check("print refused on a read-only display", st == 403, f"HTTP {st}")

# 6) admin switches the display ON — PRINT-FIRST DEFAULT (owner decision
#    2026-09-16): a bare interactive display advertises print/reprint only
#    (plus the supervisor-message confirmation).
st, _ = call("PATCH", f"/station-displays/{disp['id']}", {"config": {"interactive": True}}, token)
check("admin switched the display interactive", st == 200, f"HTTP {st}")
st, snap = call("GET", f"/display-views/{tok_key}")
check("the default action set is PRINT + REPRINT (owner's first batch)",
      st == 200 and set(snap["options"]["actions"]) == {"print", "reprint", "message"},
      str(snap["options"]["actions"]))

# 6b) assist actions stay OFF until the admin ticks them on that display
st, listed = call("GET", f"/stations/{station['id']}/displays", None, token)
check("assist actions are not available until switched on",
      all(listed[0]["config"]["actions"][k] is False for k in ("ack", "help", "exception", "move")),
      str(listed[0]["config"]["actions"]))
st, err = call("POST", f"/display-views/{tok_key}/actions/help", {"note": "not allowed yet"})
check("HELP is refused while its switch is off", st == 403 and "DISPLAY_ACTION_NOT_ALLOWED" in str(err.get("message")), f"HTTP {st}")

# 6c) now the full assist profile for the rest of the run
cfg_full = {
    "interactive": True, "sound": True, "printTransport": "BROWSER",
    "actions": {"print": True, "reprint": True, "ack": True, "help": True, "exception": True, "message": True},
}
st, _ = call("PATCH", f"/station-displays/{disp['id']}", {"config": cfg_full}, token)
check("admin enabled the assist profile on that screen", st == 200, f"HTTP {st}")

st, snap = call("GET", f"/display-views/{tok_key}")
check("snapshot now advertises the allowed actions",
      st == 200 and snap["options"]["interactive"] is True and set(snap["options"]["actions"]) == {"print", "reprint", "ack", "help", "exception", "message"},
      str(snap["options"]["actions"]))

# 7) print with NOTHING on screen must be refused (no blank label)
st, err = call("POST", f"/display-views/{tok_key}/actions/print", {"target": "SCAN"})
check("print refused when there is nothing to print", st == 400 and err.get("message") == "NOTHING_TO_PRINT", f"HTTP {st}")

# 8) simulate a real CT40 transaction at this station (same tables the display reads)
# A real arrival is required (FK) — the CT40 would be working on one too.
sql("""INSERT INTO expected_arrivals (id, code, "customerArrivalCardId", "customerId", "customerName", source, status, "createdAt", "updatedAt")
       VALUES ('smoke-arr', 'WAR-SMOKE', 'CARD-SMOKE', 'CUST-SMOKE', 'Smoke Customer', 'ARRIVAL_CRM', 'EXPECTED', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING""")
sql(f"""INSERT INTO receiving_sessions (id, code, "arrivalId", status, "startedBy", "startedAt", "stationId", "deviceType", "createdAt", "updatedAt")
        VALUES ('smoke-sess', 'RCV-SMOKE', 'smoke-arr', 'RECEIVING', 'admin', NOW(), '{station['id']}', 'CT40', NOW(), NOW())
        ON CONFLICT (id) DO NOTHING""")
sql("""INSERT INTO receiving_scan_events (id, "sessionId", "operationId", kind, code, quantity, source, "createdAt")
        VALUES ('smoke-scan', 'smoke-sess', 'op-smoke-1', 'PRODUCT', 'SA-SMOKE-77', 3, 'EXTERNAL_SCANNER', NOW())
        ON CONFLICT (id) DO NOTHING""")
inserted = sql("SELECT count(*) FROM receiving_scan_events WHERE id = 'smoke-scan'")
check("(setup) CT40 transaction rows in the DB", inserted.strip() == "1", f"rows={inserted.strip()!r}")
sql("""INSERT INTO receiving_scan_events (id, "sessionId", kind, code, quantity, source, "createdAt")
        VALUES ('smoke-scan', 'smoke-sess', 'PRODUCT', 'SA-SMOKE-77', 3, 'EXTERNAL_SCANNER', NOW())""")

st, snap = call("GET", f"/display-views/{tok_key}")
check("display mirrors the CT40 transaction (same id)",
      snap["lastScan"] and snap["lastScan"]["id"] == "smoke-scan" and snap["lastScan"]["code"] == "SA-SMOKE-77")

# 9) print now succeeds and carries the same identity
st, pr = call("POST", f"/display-views/{tok_key}/actions/print", {"target": "SCAN"})
job = pr.get("job") or {}
check("print job queued with the operator's own code",
      st in (200, 201) and job.get("targetRef") == "SA-SMOKE-77" and job.get("payload", {}).get("reference") == "smoke-scan",
      f"HTTP {st}")

st, res = call("POST", f"/display-views/{tok_key}/actions/print/{job.get('id')}/result", {"status": "PRINTED"})
check("print result recorded (PRINTED)", st in (200, 201) and res.get("job", {}).get("status") == "PRINTED")

# 10) reprint reuses the original payload
st, rep = call("POST", f"/display-views/{tok_key}/actions/print", {"reprintOf": job.get("id")})
check("reprint reuses the original payload", st in (200, 201) and rep.get("job", {}).get("targetRef") == "SA-SMOKE-77")

# 11) ack / help / exception
st, ack = call("POST", f"/display-views/{tok_key}/actions/ack", {"note": "seen by smoke test"})
check("ack recorded", st in (200, 201) and ack.get("ok") is True)
st, help_ = call("POST", f"/display-views/{tok_key}/actions/help", {"note": "carton blocked", "urgent": True})
check("help request recorded (+ supervisor push attempted)", st in (200, 201) and help_.get("ok") is True, f"notified={help_.get('notified')}")
st, exc = call("POST", f"/display-views/{tok_key}/actions/exception", {"type": "DAMAGED", "reason": "pallet damaged", "code": "SA-SMOKE-77"})
check("exception created as a REAL OperationalException", st in (200, 201) and str(exc.get("exceptionCode", "")).startswith("EXC-"), str(exc.get("exceptionCode")))
st, bad = call("POST", f"/display-views/{tok_key}/actions/exception", {})
check("exception without a reason refused", st == 400, f"HTTP {st}")

# 12) admin -> screen message, screen acknowledges
st, msg = call("POST", f"/station-displays/{disp['id']}/message", {"body": "Stop scanning, supervisor coming", "severity": "URGENT"}, token)
check("admin message sent to the screen", st in (200, 201) and msg.get("severity") == "URGENT")
st, snap = call("GET", f"/display-views/{tok_key}")
check("message reaches the screen", bool(snap.get("messages")) and snap["messages"][0]["body"].startswith("Stop scanning"))
st, mack = call("POST", f"/display-views/{tok_key}/messages/{msg['id']}/ack", {"note": "stopped"})
check("screen acknowledged the message", st in (200, 201) and mack.get("ok") is True)
st, snap = call("GET", f"/display-views/{tok_key}")
check("acknowledged message leaves the screen", snap.get("messages") == [])

# 13) the display's own action log (the «record every action» requirement)
st, acts = call("GET", f"/station-displays/stations/{station['id']}/actions", None, token)
kinds = [a["kind"] for a in acts] if isinstance(acts, list) else []
check("station action log keeps every action (print/reprint/ack/help/exception/message)",
      {"PRINT", "REPRINT", "ACK", "HELP", "EXCEPTION", "MESSAGE", "MESSAGE_SEEN"}.issubset(set(kinds)), str(sorted(set(kinds))))

# 14) the station feed shows the display actions too (feed merge)
st, snap = call("GET", f"/display-views/{tok_key}")
feed_kinds = [r["kind"] for r in snap.get("recent", [])]
check("station feed includes screen actions", any(k in feed_kinds for k in ("PRINT", "EXCEPTION", "ACK", "HELP")), str(feed_kinds))

# 15) audit trail: every action carries the display identity
rows = sql("""SELECT action || ':' || COALESCE(metadata->>'display', '-') FROM audit_logs
              WHERE action::text LIKE 'DISPLAY_%' ORDER BY "createdAt" DESC LIMIT 12""").splitlines()
audited = [r for r in rows if r.endswith(":Smoke Wall")]
check("audit records every display action with the display identity", len(audited) >= 7, ",".join(audited[:8]))

# 16) revocation: disable the display -> both read and act die instantly
call("PATCH", f"/station-displays/{disp['id']}", {"enabled": False}, token)
st, snap2 = call("GET", f"/display-views/{tok_key}")
check("disabled display leaks no data", st == 200 and snap2.get("enabled") is False and "station" not in snap2)
st, err = call("POST", f"/display-views/{tok_key}/actions/ack", {})
check("disabled display refuses actions", st == 403, f"HTTP {st}")
call("PATCH", f"/station-displays/{disp['id']}", {"enabled": True}, token)

# 17) regenerating the token kills the old URL (read + write)
st, reg = call("POST", f"/station-displays/{disp['id']}/regenerate", None, token)
st, gone = call("GET", f"/display-views/{tok_key}")
check("regenerated token kills the old URL", st == 404, f"HTTP {st}")

# 18) fleet console
st, fleet = call("GET", "/station-displays", None, token)
counters = fleet.get("counters", {})
check("fleet lists every station (with AND without a display)",
      st == 200 and counters.get("stations", 0) >= 1 and counters.get("stationsWithDisplay", 0) >= 1 and counters.get("stationsWithoutDisplay", 0) >= 0,
      json.dumps(counters))
check("fleet never exposes tokens", "accessToken" not in json.dumps(fleet))

# 19) bulk: create a display for every station that has none
st, second = call("POST", "/stations", {"code": "SMOKE-02", "name": "Smoke Packing", "department": "PACKING"}, token)
st, bulk = call("POST", "/station-displays/bulk", {"action": "CREATE_MISSING"}, token)
check("bulk created displays for the stations that had none",
      st in (200, 201) and bulk.get("applied", 0) >= 1 and all(str(c["urlPath"]).startswith("/display/") for c in bulk.get("created", [])),
      f"{bulk.get('applied')} created")

# 20) bulk profile + kill switch
st, b2 = call("POST", "/station-displays/bulk", {"action": "APPLY_CONFIG", "config": {"interactive": True, "sound": False, "actions": {"print": True}}}, token)
check("bulk applied a config profile to the whole fleet", st in (200, 201) and b2.get("applied", 0) >= 2, f"{b2.get('applied')} affected")
st, b3 = call("POST", "/station-displays/bulk", {"action": "SET_ENABLED", "enabled": False}, token)
st, fleet2 = call("GET", "/station-displays", None, token)
check("kill switch disabled every screen", b3.get("applied", 0) >= 2 and fleet2["counters"]["disabled"] == fleet2["counters"]["displays"])
call("POST", "/station-displays/bulk", {"action": "SET_ENABLED", "enabled": True}, token)

# 21) rate limit (a screen is not a bot): bounded actions per minute, and the
#     bound is PER DISPLAY (a hammered screen must not silence the others).
# The screen must be enabled + interactive, and ACK must be switched on for
# THIS display (section 20's fleet profile left only `print` on).
call("POST", "/station-displays/bulk", {"action": "APPLY_CONFIG", "stationIds": [station["id"]], "config": cfg_full}, token)
st, reg2 = call("POST", f"/station-displays/{disp['id']}/regenerate", None, token)
live_key = reg2["accessToken"]
codes = []
for _ in range(33):
    s, _r = call("POST", f"/display-views/{live_key}/actions/ack", {})
    codes.append(s)
check("rate limit kicks in (429) instead of unbounded actions",
      429 in codes and codes.count(429) >= 1, f"{codes.count(200)} ok, {codes.count(429)} limited, others {[c for c in codes if c not in (200, 429)][:3]}")

# 22) a hammered screen must not lock the OTHERS (per-display window)
other = [c for c in call("GET", "/station-displays", None, token)[1]["stations"] if c["stationCode"] == "SMOKE-02"][0]
st, reg3 = call("POST", f"/station-displays/{other['displays'][0]['id']}/regenerate", None, token)
call("POST", "/station-displays/bulk", {"action": "APPLY_CONFIG", "stationIds": [other["stationId"]], "config": cfg_full}, token)
st, ok = call("POST", f"/display-views/{reg3['accessToken']}/actions/ack", {})
check("the rate window is per display (an idle station screen still works)", st in (200, 201), f"HTTP {st}")

print()
failed = [r for r in results if not r[0]]
print(f"=== {len(results) - len(failed)}/{len(results)} checks passed ===")
if failed:
    for _ok, name, detail in failed:
        print(f"  FAILED: {name} {detail}")
    raise SystemExit(1)
