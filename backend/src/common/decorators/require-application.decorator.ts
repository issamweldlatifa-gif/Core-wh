import { SetMetadata } from '@nestjs/common';
import type { ApplicationKind } from '../../modules/access/application-access';

export const APPLICATION_KEY = 'requiredApplication';

/**
 * Declares which application surface(s) may reach a controller/handler:
 * ADMIN_WEB, WORKER_NATIVE, or an explicit list when a controller genuinely
 * serves both (e.g. Fulfillment: workers scan there, the Admin traceability
 * board reads there). The ApplicationGuard reads this metadata and enforces
 * it on the back-end.
 *
 * This is the coarse surface boundary of Order #3; granular RBAC on top stays
 * with @RequirePermissions. Routes without this decorator are surface-neutral
 * (shared self-service endpoints such as /auth/me).
 */
export const RequireApplication = (...apps: ApplicationKind[]) =>
  SetMetadata(APPLICATION_KEY, apps);
