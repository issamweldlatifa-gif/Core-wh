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
