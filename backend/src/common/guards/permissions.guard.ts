import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';
import { RequestWithUser } from '../interfaces/request-with-user.interface';

/**
 * Global RBAC guard. Enforces the granular permissions declared via
 * @RequirePermissions(...) by checking the permissions resolved from the
 * database on the current request. If any required permission is missing,
 * the request is rejected with 403 Forbidden.
 *
 * Security is enforced HERE on the back-end; the front-end merely hides
 * controls. Routes without @RequirePermissions are authenticated but only
 * (not additionally permission-gated).
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;
    if (!user) {
      throw new ForbiddenException('Access denied.');
    }

    const granted = new Set(user.permissions ?? []);
    const missing = required.filter((p) => !granted.has(p));
    if (missing.length > 0) {
      throw new ForbiddenException(
        `Missing required permission(s): ${missing.join(', ')}`,
      );
    }
    return true;
  }
}
