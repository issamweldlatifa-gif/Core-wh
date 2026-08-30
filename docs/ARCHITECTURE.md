# AYROVI Warehouse Core — Architecture (Phase 0)

## 1. Style: Modular Monolith

AYROVI Warehouse Core is a **Modular Monolith**. One deployable application,
but internally split into isolated, self-contained modules. Each module owns
its own routes, DTOs, service, and data access — and communicates with other
modules only through **published services / internal events**, never by
reaching into another module's tables directly.

This keeps the design ready to split any module into an independent service
later without rewriting the system.

```
AYROVI WAREHOUSE CORE
│
├── Frontend          (React + TS + Vite)
├── Backend API       (NestJS, REST /api/v1)
├── Authentication    (JWT access + refresh, sessions)
├── Authorization/RBAC (Users·Roles·Permissions)
├── Warehouse Core Domain
├── Audit System      (audit-ready)
├── Internal API Layer (services + internal event bus)
├── Integration Boundary (contracts only, Phase 0)
└── PostgreSQL
```

## 2. Backend module structure

```
backend/src/
├── app.module.ts            # root module: wires global guards
├── main.ts                  # bootstrap, versioning, global filters, Swagger
├── common/                  # shared guards, decorators, interfaces, filters
│   ├── guards/
│   │   ├── jwt-auth.guard.ts        # global auth (@Public to opt out)
│   │   ├── permissions.guard.ts     # global RBAC (@RequirePermissions)
│   │   └── rate-limit.guard.ts      # brute-force protection (auth endpoints)
│   ├── decorators/
│   └── filters/all-exceptions.filter.ts  # uniform error envelope
├── prisma/                 # schema.prisma, migrations, seed
├── events/                 # internal event bus (decoupling)
├── integrations/           # EXTERNAL boundary — contracts only (Phase 0)
└── modules/
    ├── auth/               # login, refresh, logout, me, session revocation
    ├── users/              # user + role assignment
    ├── roles/              # role + permission assignment
    ├── permissions/        # read-only permission catalog
    ├── audit/              # audit log read + global AuditService
    ├── system/             # settings + api-clients (submodule)
    └── warehouse/          # minimal warehouse foundation (config only)
```

## 3. Authorization flow (enforced on the back-end)

```
Request
  → JwtAuthGuard        (all routes unless @Public)
  → PermissionsGuard    (checks @RequirePermissions(...) against DB-resolved perms)
  → 403 Forbidden if a required permission is missing
  → 401 if not authenticated / session inactive
```

The JWT strategy **reloads** the user's roles and permissions from the
database on **every** request, so:
- a disabled/locked user is rejected immediately;
- a revoked/expired session is rejected immediately;
- a permission change or role removal takes effect immediately.

The frontend only hides controls; the security decision is made by the
backend.

## 4. Data model (Phase 0 — Core only)

Core tables: `users`, `roles`, `permissions`, `user_roles`, `role_permissions`,
`sessions`, `audit_logs`, `system_settings`, `api_clients` + `warehouses`
(minimal foundation).

No operational/workflow tables exist in Phase 0.

## 5. Audit model

`audit_logs` captures `actor_user_id`, `action`, `entity_type`, `entity_id`,
`ip_address`, `metadata`, `created_at`. System events are recorded right now
(`USER_LOGIN`, `USER_LOGIN_FAILED`, `USER_LOGOUT`, `ROLE_CREATED`,
`ROLE_PERMISSIONS_CHANGED`, `USER_ROLES_CHANGED`, `SETTINGS_UPDATED`, …).
Operational event names are **reserved** in the enum but not emitted until
their phases arrive.

## 6. Integration boundary

`integrations/` exists as a boundary. In Phase 0 it is **contracts only**: no
live CRM, shipping, notifications, OCR, payment, or email calls. No real
credentials. Future adapters plug in behind published interfaces so the domain
stays provider-agnostic.

## 7. Security model

- Credentials (password / PIN) hashed with bcrypt — never plain text.
- Secrets in env vars (`.env.example` placeholders), never in Git.
- Global validation (DTO + class-validator), whitelisting, forbid unknown fields.
- Helmet headers, explicit CORS, HTTPS at the proxy, rate-limited auth.
- DB constraints, foreign keys, indexes; proper FKs/joins.
- `api_clients` secrets hashed, never returned after creation.

## 8. Deployment (portable)

Containerized with multi-stage Dockerfiles (`docker/`). Superset of the
`DOMAIN → FRONTEND → HTTPS → BACKEND → (PostgreSQL | Storage)` topology from
the spec. Not tied to Render; works on any host.
