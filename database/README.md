# Database

AYROVI Warehouse Core (Phase 0) uses **PostgreSQL** managed by **Prisma Migrations**.

## Where migrations live

All schema, migrations, and seed live under the backend package:

```
backend/prisma/
├── schema.prisma            # canonical schema (all core tables)
├── migrations/              # versioned SQL migrations (e.g. 2026..._init_core)
└── seed.ts                  # permissions + roles + initial admin
```

## Common commands (run from `backend/`)

```bash
npx prisma generate         # generate the Prisma client
npx prisma migrate deploy   # apply all migrations (production)
npx prisma migrate dev      # create/apply a migration (development)
npm run db:seed             # seed permissions, roles, and initial admin
```

## Architecture of the core schema (Phase 0)

- Identity/access: `users`, `roles`, `permissions`, `user_roles`, `role_permissions`
- Sessions: `sessions`
- Audit: `audit_logs`
- Config: `system_settings`, `api_clients`
- Foundation: `warehouses` (identification/config only)

**No operational workflow tables** (receiving/stowing/picking/packing/shipping,
inventory movement, containers, barcodes, OCR) exist in Phase 0. They are added
in later phases via new migrations.

## Production note

In production the DB user needs the usual table permissions but — unless it
also needs to run `prisma migrate dev` — it does not need `CREATEDB`. Migrations
are applied with `prisma migrate deploy`, which does not require a shadow
database.
