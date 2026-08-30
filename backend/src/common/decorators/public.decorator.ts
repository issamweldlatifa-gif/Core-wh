import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route as publicly accessible (skips the global JWT + permission
 * guards). Use ONLY for endpoints that must be reachable without a session,
 * e.g. /auth/login and /auth/refresh.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
