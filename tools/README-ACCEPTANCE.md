# Practical acceptance — MASTER EXECUTION chain

These scripts drive the REAL APIs only (no mock data). Run them against a
fresh database (`prisma migrate reset --force && npm run db:seed`) or a
disposable staging environment, then against the deployed environment.

| script | what it proves |
| --- | --- |
| `acceptance-temp-storage.mjs` | Temporary Storage station: 45 confirmed products → A1 20/20 FULL, A2 20/20 FULL, A3 5/20 ACTIVE; wrong container refused; cartons never enter; REVIEW lane + admin exception; Rapport de Fin → admin review; runtime capacity config |
| `harness-test-worker.mjs` | Creates the throwaway `TEST_WORKER` (admin API) and binds it to station **ST-REC-02**, so `acceptance-e2e.mjs` / `acceptance-temp-storage.mjs` have a second receiving worker without stealing the demo one (ST-REC-01 belongs to WORKER001). Run it once after a seed. |
| `acceptance-e2e.mjs` | Receiving → verification report SUBMITTED → CONFIRMED-only product handoff into the Temporary Storage inbox |
| `acceptance-chain.mjs` | **The reference chain end to end**, one worker per station: `WORKER → STATION → OPERATION → WORK → TASK` for Receiving, Temporary Storage, Sorting (tri par client), Packing (Colis) and Shipping-Dispatch (Expédition), plus the matching Admin Web surfaces |

```bash
# once after a seed (creates TEST_WORKER on ST-REC-02)
BASE=http://127.0.0.1:3000/api/v1 node tools/harness-test-worker.mjs

# local / CI
BASE=http://127.0.0.1:3000/api/v1 node tools/acceptance-chain.mjs

# deployed
BASE=https://core-wh.onrender.com/api/v1 \
  ADMIN_SECRET='<ADMIN001 password>' INT_KEY='<integration API key>' \
  node tools/acceptance-chain.mjs
```

Environment variables: `BASE`, `ADMIN_ID` (default `ADMIN001`), `ADMIN_SECRET`,
`INT_KEY` (integration API key), `WORKER_SECRET` (demo worker password, default
`WorkerPass!2026`).

> The auth endpoint rate-limits 20 attempts / 15 min per IP. Restart the API
> (or wait) between repeated runs.
