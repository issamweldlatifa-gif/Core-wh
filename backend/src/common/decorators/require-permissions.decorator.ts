import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'requiredPermissions';

/**
 * Declares the granular permission(s) required to access a controller/handler.
 * The global PermissionsGuard reads this metadata and enforces it on the
 * back-end. If omitted, routes are authenticated but not additionally
 * permission-gated (used for self-service endpoints such as /auth/me).
 */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * OR semantics for the same guard (`@RequirePermissions` is AND).
 *
 * Why it exists (owner order 2026-09-16, open item «PC → CT40 printer»): the
 * handheld print agent is ONE endpoint behind SIX different shop-floor jobs —
 * a receiving worker holds `receiving.execute`, a batch worker `batch.execute`,
 * a packer `packing.execute`… The agent is for whoever is ASSIGNED to the
 * station (enforced in the service), but it must still be closed to accounts
 * with no warehouse execution right at all (admin/manager-only logins).
 * Listing the six as AND would lock out five valid roles; listing none would
 * open it to every authenticated worker account.
 */
export const PERMISSIONS_ANY_KEY = 'requiredAnyPermissions';

export const RequireAnyPermission = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_ANY_KEY, permissions);
