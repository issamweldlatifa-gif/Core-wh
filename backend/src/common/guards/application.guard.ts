import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { APPLICATION_KEY } from '../decorators/require-application.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { RequestWithUser } from '../interfaces/request-with-user.interface';
import { AuditService } from '../../modules/audit/audit.service';
import type { ApplicationKind } from '../../modules/access/application-access';

/**
 * Application-surface guard (strict Admin/Worker isolation). When a
 * controller/handler declares @RequireApplication('WORKER_NATIVE') only
 * sessions whose DB `application` is WORKER_NATIVE may call it; an ADMIN_WEB
 * session (or a session whose roles cannot open that surface) is rejected
 * with 403 before the handler runs.
 *
 * Surface is server truth from the session row — the client cannot claim one.
 * Opt-in: routes without the decorator are unaffected (current web behaviour).
 *
 * Every denial is written to the security audit trail
 * (WORKER_APP_ACCESS_DENIED / ADMIN_APP_ACCESS_DENIED).
 */
@Injectable()
export class ApplicationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit?: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<ApplicationKind[]>(
      APPLICATION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    // @Public() routes (e.g. /system/health) are unauthenticated by design —
    // there is no session surface to isolate, so this guard must not touch
    // them. Without this, an anonymous health probe on a surface-declaring
    // controller would be rejected with 403 and break deploy health checks.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;
    if (!user) {
      throw new ForbiddenException('Access denied.');
    }
    if (!required.includes(user.application)) {
      await this.recordDenial(user, required, 'application_mismatch', request.ip);
      const label = required.map((r) => (r === 'WORKER_NATIVE' ? 'Worker' : 'Admin')).join(' or ');
      throw new ForbiddenException(
        `This endpoint is reserved for the ${label} application; this session is ${user.application}.`,
      );
    }
    const allowed = user.allowedApplications ?? [];
    if (!required.some((app) => allowed.includes(app))) {
      await this.recordDenial(user, required, 'roles_do_not_open_surface', request.ip);
      throw new ForbiddenException('Your roles cannot open this application surface.');
    }
    return true;
  }

  private async recordDenial(
    user: { id: string; application: ApplicationKind; roles?: string[] },
    required: ApplicationKind[],
    reason: string,
    ip?: string,
  ) {
    if (!this.audit) return;
    // An ADMIN_WEB session hitting a worker route is a "worker app denied"
    // event from the admin side; a WORKER_NATIVE session hitting an admin
    // route is an "admin access denied" event from the worker side.
    const action =
      required.includes('WORKER_NATIVE') && !required.includes('ADMIN_WEB')
        ? 'WORKER_APP_ACCESS_DENIED'
        : 'ADMIN_APP_ACCESS_DENIED';
    try {
      await this.audit.log({
        actorUserId: user.id,
        action: action as any,
        entityType: 'session',
        ipAddress: ip ?? undefined,
        metadata: {
          requiredApplication: required,
          sessionApplication: user.application,
          roles: user.roles ?? [],
          reason,
        },
      });
    } catch {
      // Telemetry must never mask the authorization denial.
    }
  }
}
