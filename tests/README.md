# Tests

Test code lives **next to the code it tests** (co-located).

## Where the tests are

- **Backend unit**: `backend/src/**/*.spec.ts` (e.g. `auth/token.service.spec.ts`)
- **Backend e2e**: `backend/test/*.e2e-spec.ts` (runs against a real Nest app + PostgreSQL)

## Run them

```bash
# unit
cd backend
npm test

# e2e (requires a migrated + seeded PostgreSQL; set env)
cd backend
DATABASE_URL="postgresql://..." \
INITIAL_ADMIN_CODE=ADMIN001 INITIAL_ADMIN_PASSWORD="..." \
JWT_ACCESS_SECRET=... JWT_REFRESH_SECRET=... \
npm run test:e2e
```

## Coverage (Phase 0)

- Authentication: valid login, wrong credentials (401), unknown user (401),
  `/auth/me`, logout session invalidation.
- RBAC: worker denied admin endpoints (403), unauthenticated (401), admin
  allowed (200), permission revocation immediate.
- Validation: invalid payload → 400 + uniform error envelope.
- Audit: `USER_LOGIN` recorded.
- API versioning: routes under `/api/v1`.
