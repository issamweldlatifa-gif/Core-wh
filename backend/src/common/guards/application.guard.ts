import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { APPLICATION_KEY } from '../decorators/require-application.decorator';
import { RequestWithUser } from '../interfaces/request-with-user.interface';
import type { ApplicationKind } from '../../modules/access/application-access';

/**
 * Application-surface guard (Order #3). When a controller/handler declares
 * @RequireApplication('WORKER_NATIVE') only sessions whose DB `application` is
 * WORKER_NATIVE may call it; an ADMIN_WEB session (or a session whose roles
 * cannot open that surface) is rejected with 403 before the handler runs.
 *
 * Surface is server truth from the session row — the client cannot claim one.
 * Opt-in: routes without the decorator are unaffected (current web behaviour).
 */
@Injectable()
export class ApplicationGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<ApplicationKind>(
      APPLICATION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;
    if (!user) {
      throw new ForbiddenException('Access denied.');
    }
    if (user.application !== required) {
      throw new ForbiddenException(
        `This endpoint is reserved for the ${
          required === 'WORKER_NATIVE' ? 'Worker' : 'Admin'
        } application; this session is ${user.application}.`,
      );
    }
    if (!(user.allowedApplications ?? []).includes(required)) {
      throw new ForbiddenException('Your roles cannot open this application surface.');
    }
    return true;
  }
}
