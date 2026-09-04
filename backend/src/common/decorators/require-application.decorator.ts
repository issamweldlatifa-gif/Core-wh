import { SetMetadata } from '@nestjs/common';
import type { ApplicationKind } from '../../modules/access/application-access';

export const APPLICATION_KEY = 'requiredApplication';

/**
 * Declares that a controller/handler may only be reached by sessions opened
 * for the given application surface (ADMIN_WEB or WORKER_NATIVE). The
 * ApplicationGuard reads this metadata and enforces it on the back-end.
 *
 * This is the coarse surface boundary of Order #3; granular RBAC on top stays
 * with @RequirePermissions. Routes without this decorator are surface-neutral
 * (shared self-service endpoints such as /auth/me).
 */
export const RequireApplication = (app: ApplicationKind) =>
  SetMetadata(APPLICATION_KEY, app);
