# ROADMAP v1.3.0 — Live Warehouse OS
## Phase 0 — Foundation (backend, P0)
- [x] Idempotency keys on all scan endpoints (dedupe double-trigger)
- [x] Worker heartbeat endpoint (true online status)
- [x] Server-Sent Events bus for live admin dashboard
- [x] Exception report endpoint (worker can flag+continue)
## Phase 1 — Mobile v1.3.0 (P0+P1 UX)
- [x] Sound + vibration feedback (accept/reject/warn profiles)
- [x] Persistent network-error banner with retry
- [x] Exception report flow (reason + continue)
- [x] Shift counter (today's scans per station) in footer
- [x] Auto-resume last context on app relaunch
- [x] Battery indicator on top strip
- [x] Larger manual entry + big ENTER button
- [x] Flashbar: success auto-dismiss after 2s, errors stay until dismiss
- [x] Big "SCAN NEXT" call-to-action after every success
- [x] Packing: real checkboxes with colour fill when complete
- [x] Trace: timestamps where available
- [x] Bump versionCode 41 / 1.3.0
## Phase 2 — Admin Web v1.3.0
- [x] Live Operations Dashboard via SSE (workers online, throughput, exceptions live)
- [x] Worker performance table (per-worker per-shift stats)
- [x] Large-format Station Display page (wallboard for warehouse TV)
- [x] Live sound/alerts on new exceptions
- [x] Mobile-style dark theme alignment with worker app
## Phase 3 — Build & Deploy
- [x] Mobile CI green → canary APK link
- [x] Web build → deploy to Render
- [x] Smoke-test both surfaces
## Phase 4 — Report & next-step plan (P2 backlog)
