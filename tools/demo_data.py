"""WALKTHROUGH DEMO DATA (owner walkthrough 2026-09-16).

Creates the real warehouse picture on top of the seeded stations:
  - one display per active station (Board),
  - the v3 SCREEN SET (Next Action / Andon / Print) for every station, so the
    walkthrough can open several single-purpose screens of the same station,
  - a live receiving session + scans + temporary-storage rows + a supervisor
    message, and one real label printed from the screen.

Run against a RUNNING API and its database:
  cd backend && npm run start:prod
  python3 tools/demo_data.py
It is idempotent (ON CONFLICT / upsert paths) and prints every display URL at
the end, grouped by station and role.
"""
import json, urllib.request, urllib.error, subprocess
BASE = "http://127.0.0.1:3000/api/v1"
PSQL = ["/usr/lib/postgresql/17/bin/psql","-h","/tmp","-p","5433","-U","postgres","-d","ayrovi","-t","-A","-c"]

def call(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(f"{BASE}{path}", data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if token: r.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(r, timeout=25) as res: return res.status, json.loads(res.read().decode() or "null")
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode())
        except Exception: return e.code, None

def sql(q): return subprocess.run(PSQL+[q], capture_output=True, text=True).stdout.strip()

_, tok = call("POST","/auth/login",{"identifier":"ADMIN001","secret":"ChangeMe!2024","mode":"password","app":"ADMIN_WEB"})
T = tok["accessToken"]

# 1) one display per active seeded station (what the bulk bar does in the console)
st, bulk = call("POST", "/station-displays/bulk", {"action": "CREATE_MISSING"}, T)
print(f"bulk CREATE_MISSING -> {bulk.get('applied')} display(s)")
urls = {c["stationCode"]: c["urlPath"] for c in bulk.get("created", [])}
_, fleet = call("GET", "/station-displays", None, T)
ids = {}
for row in fleet["stations"]:
    for d in row["displays"]:
        # the BOARD screen is the station's main screen — a set screen (Next
        # Action / Andon / Print) is never the one the demo reconfigures.
        if ids.get(row["stationCode"]) is None or d.get("view", "BOARD") == "BOARD":
            ids[row["stationCode"]] = d["id"]
        if row["stationCode"] not in urls:
            st, reg = call("POST", f"/station-displays/{d['id']}/regenerate", None, T)
            urls[row["stationCode"]] = reg["urlPath"]

# 2) RECEIVING dock 1 + BATCH + PACKING screens may act; RECEIVING = print first
call("PATCH", f"/station-displays/{ids['ST-REC-01']}", {"config": {"interactive": True, "printTransport": "BROWSER"}}, T)
call("PATCH", f"/station-displays/{ids['ST-PCK-01']}", {"config": {"interactive": True,
     "actions": {"print": True, "reprint": True, "ack": True, "help": True, "exception": True, "message": True}}}, T)
call("PATCH", f"/station-displays/{ids['ST-STG-01']}", {"config": {"interactive": True}}, T)
_, fleet = call("GET", "/station-displays", None, T)
print("fleet counters:", json.dumps(fleet["counters"]))

# 3) a live receiving operation on ST-REC-01 (same rows the CT40 writes)
sql("""INSERT INTO expected_arrivals (id, code, "customerArrivalCardId", "customerId", "customerName", "customerSurname", "storeName", source, status, "createdAt", "updatedAt")
       VALUES ('demo-arr','WAR-26091601','CARD-DEMO-1','CUST-77','Amine','Ben Salah','Store Tunis Centre','ARRIVAL_CRM','RECEIVING',NOW(),NOW())
       ON CONFLICT (id) DO NOTHING""")
sql("""INSERT INTO receiving_sessions (id, code, "arrivalId", status, "startedBy", "startedAt", "stationId", "deviceType", "createdAt", "updatedAt")
       VALUES ('demo-sess','RCV-000301','demo-arr','RECEIVING','admin',NOW(),(select id from stations where code='ST-REC-01'),'CT40',NOW(),NOW())
       ON CONFLICT (id) DO NOTHING""")
sql("""INSERT INTO receiving_products (id, "receivingSessionId", sku, reference, "productName", "expectedQuantity", "receivedQuantity", difference, status, "createdAt", "updatedAt")
       VALUES ('demo-p1','demo-sess','SA-4471','REF-4471','Office Chair Ergo',50,37,-13,'PARTIALLY_RECEIVED',NOW(),NOW())
       ON CONFLICT (id) DO NOTHING""")
for i,(code,qty) in enumerate([("SA-4471",2),("SA-4471",1),("SA-9982",1),("SA-4471",3),("SA-9982",2)]):
    sql(f"""INSERT INTO receiving_scan_events (id, "sessionId", "operationId", kind, code, quantity, source, "createdAt")
            VALUES ('demo-scan-{i}','demo-sess','demo-op-{i}','PRODUCT','{code}',{qty},'EXTERNAL_SCANNER',NOW() - INTERVAL '{12-i*2} minutes')
            ON CONFLICT (id) DO NOTHING""")
# a temporary-storage put on the STAGING station screen (ST-STG-01)
sql("""INSERT INTO temporary_storage_items (id, "operationId", sku, reference, "productName", "customerName", quantity, status, "sectionLetter", "scannedAt", "createdAt", "stationId")
       VALUES ('demo-ts-1','op-ts-demo-1','SA-4471','REF-4471','Office Chair Ergo','Amine Ben Salah',12,'STORED','A',NOW() - INTERVAL '4 minutes',NOW() - INTERVAL '4 minutes',(select id from stations where code='ST-STG-01'))
       ON CONFLICT (id) DO NOTHING""")
sql("""INSERT INTO temporary_storage_items (id, "operationId", sku, reference, "productName", "customerName", quantity, status, "sectionLetter", "scannedAt", "createdAt", "stationId")
       VALUES ('demo-ts-2','op-ts-demo-2','SA-9982','REF-9982','Desk Lamp Pro','Amine Ben Salah',6,'REVIEW','B',NOW() - INTERVAL '2 minutes',NOW() - INTERVAL '2 minutes',(select id from stations where code='ST-STG-01'))
       ON CONFLICT (id) DO NOTHING""")

# 4) supervisor message waiting on the receiving screen + a printed label pair
call("POST", f"/station-displays/{ids['ST-REC-01']}/message",
     {"body": "2 cartons short on WAR-26091601 - check with the driver before closing the session", "severity": "WARNING"}, T)
tok_recv = urls["ST-REC-01"].split("/display/")[1]
st, job = call("POST", f"/display-views/{tok_recv}/actions/print", {"target": "SCAN"})
if st in (200, 201):
    job_id = job["job"]["id"]
    call("POST", f"/display-views/{tok_recv}/actions/print/{job_id}/result", {"status": "PRINTED"})
    st2, rep = call("POST", f"/display-views/{tok_recv}/actions/print", {"reprintOf": job_id})
    if st2 in (200, 201):
        call("POST", f"/display-views/{tok_recv}/actions/print/{rep['job']['id']}/result", {"status": "PRINTED"})
    st3, ackm = call("POST", f"/display-views/{tok_recv}/actions/ack", {"note": "shortage confirmed with the driver"})
    print("ack from the screen:", st3)
print(f"print from the screen: HTTP {st} (job {job.get('job', {}).get('status', job.get('message'))})")

# 5) v3 SCREEN SET: every station gets its single-purpose screens
#    (Board already exists from step 1; this adds Next Action / Andon / Print).
st, sets = call("POST", "/station-displays/bulk", {"action": "CREATE_SET", "views": ["ACTION", "ALERTS", "PRINT"]}, T)
print(f"bulk CREATE_SET -> {sets.get('applied')} screen(s)")

# the RECEIVING Next Action screen may act (so the walkthrough can tap PRINT on it)
_, fleet = call("GET", "/station-displays", None, T)
by_station = {r["stationCode"]: r for r in fleet["stations"]}
for d in by_station.get("ST-REC-01", {}).get("displays", []):
    if d.get("view") == "ACTION":
        call("PATCH", f"/station-displays/{d['id']}", {"config": {"view": "ACTION", "interactive": True,
             "actions": {"print": True, "reprint": True, "ack": True, "help": True, "exception": True, "message": True}}}, T)
    if d.get("view") == "PRINT":
        # the PRINT screen may act too, and its transport is the station printer
        call("PATCH", f"/station-displays/{d['id']}", {"config": {"view": "PRINT", "interactive": True,
             "printTransport": "BROWSER", "actions": {"print": True, "reprint": True}}}, T)

screen_urls = {}
for r in fleet["stations"]:
    for d in r["displays"]:
        st, reg = call("POST", f"/station-displays/{d['id']}/regenerate", None, T)
        screen_urls.setdefault(r["stationCode"], []).append((d.get("view", "BOARD"), reg["urlPath"]))

_, actions = call("GET", f"/station-displays/stations/{[s['stationId'] for s in fleet['stations'] if s['stationCode']=='ST-REC-01'][0]}/actions", None, T)
print("station action log:", [a["kind"] for a in actions])
print()
print("=== SCREEN SET per station (one URL per screen — open them in separate windows) ===")
for code in sorted(screen_urls):
    for view, path in sorted(screen_urls[code], key=lambda v: ["BOARD", "ACTION", "ALERTS", "PRINT", "QUEUE", "STATS"].index(v[0])):
        print(f"{code:12s} {view:7s} {path}")
