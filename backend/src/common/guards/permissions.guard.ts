import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';
import { RequestWithUser } from '../interfaces/request-with-user.interface';
import { AuditService } from '../../modules/audit/audit.service';

/**
 * Global RBAC guard. Enforces the granular permissions declared via
 * @RequirePermissions(...) by checking the permissions resolved from the
 * database on the current request. If any required permission is missing,
 * the request is rejected with 403 Forbidden.
 *
 * Security is enforced HERE on the back-end; the front-end merely hides
 * controls. Routes without @RequirePermissions are authenticated but only
 * (not additionally permission-gated).
 *
 * Denials are written to the security audit trail (UNAUTHORIZED_PERMISSION).
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit?: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
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
      if (this.audit) {
        try {
          await this.audit.log({
            actorUserId: user.id,
            action: 'UNAUTHORIZED_PERMISSION' as any,
            entityType: undefined,
            ipAddress: (request as any).ip,
            metadata: {
              required,
              missing,
              application: user.application,
              url: (request as any).originalUrl ?? (request as any).url,
            },
          });
        } catch {
          // Telemetry must never mask the authorization denial.
        }
      }
      throw new ForbiddenException(
        `Missing required permission(s): ${missing.join(', ')}`,
      );
    }
    return true;
  }
}
