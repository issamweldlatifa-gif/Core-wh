import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticatedUser } from '../../../common/interfaces/authenticated-user.interface';
import { AccessTokenPayload } from '../token.service';
import {
  applicationsAllowedByRoles,
  type ApplicationKind,
} from '../../access/application-access';

/**
 * Validates the access token and rebuilds the AuthenticatedUser from the
 * DATABASE on every request (roles + permissions reloaded), so that:
 *   - a deleted / disabled / locked user is rejected immediately;
 *   - a revoked or expired session is rejected immediately;
 *   - permission changes are effective immediately (no stale token claims);
 *   - a bound device that was disabled/re-assigned kills the session;
 *   - a bound station that changed assignment kills the session (force re-auth);
 *   - roles that no longer permit the session's application kill the session.
 *
 * Every one of these decisions is server-side truth from the DB — the client
 * never supplies role/station/device claims on requests.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_ACCESS_SECRET,
    });
  }

  async validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    if (!payload || payload.type !== 'access') {
      throw new UnauthorizedException('Invalid token.');
    }

    const session = await this.prisma.session.findUnique({
      where: { id: payload.sid },
      include: { user: true, device: true },
    });

    if (
      !session ||
      session.status !== 'ACTIVE' ||
      (session.expiresAt && session.expiresAt.getTime() < Date.now())
    ) {
      throw new UnauthorizedException('Session is no longer active.');
    }

    const user = session.user;
    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('User account is not active.');
    }

    // Application is server truth from the DB session row (never from the
    // client). Tokens minted before the application context landed carry no
    // claim; a present-but-mismatched claim is rejected as mis-issued.
    const application: ApplicationKind = session.application as ApplicationKind;
    if (payload.app && payload.app !== application) {
      throw new UnauthorizedException('Token application does not match the session.');
    }

    // Role change invalidation: if the current DB roles no longer allow the
    // surface this session was opened for (e.g. an admin revoked a worker's
    // operational role), the session is dead — force re-authentication.
    const roleRows = await this.prisma.userRole.findMany({
      where: { userId: user.id },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    });
    const roles = roleRows.map((r) => r.role.name);
    const allowedApplications = applicationsAllowedByRoles(roles);
    if (!allowedApplications.has(application)) {
      await this.revoke(session.id);
      throw new UnauthorizedException(
        'Your roles no longer permit access to this application — please sign in again.',
      );
    }

    // Device revocation (native worker sessions only): a session bound to a
    // device that is now DISABLED or gone is revoked immediately.
    if (session.deviceId) {
      const device = session.device;
      if (!device || device.status !== 'ACTIVE') {
        await this.revoke(session.id);
        throw new UnauthorizedException('This device is no longer authorized.');
      }
      // Cheap last-seen touch for admin device monitoring (bounded by each
      // authenticated request from the bound device).
      if (!device.lastSeenAt || Date.now() - device.lastSeenAt.getTime() > 30_000) {
        await this.prisma.device.update({
          where: { id: session.deviceId },
          data: { lastSeenAt: new Date(), lastSeenIp: session.ipAddress ?? null },
        });
      }
    }

    // Station assignment change (native worker sessions with a single bound
    // station): if the admin reassigned this worker (or disabled the station)
    // the old session is invalidated — next login picks up the new station.
    if (session.stationId) {
      const station = await this.prisma.station.findUnique({
        where: { id: session.stationId },
        select: { status: true, assignedWorkerId: true },
      });
      if (!station || station.status !== 'ACTIVE' || station.assignedWorkerId !== user.id) {
        await this.revoke(session.id);
        throw new UnauthorizedException(
          'Your station assignment changed — please sign in again.',
        );
      }
    }

    const permissions = [
      ...new Set(
        roleRows.flatMap((r) => r.role.permissions.map((p) => p.permission.key)),
      ),
    ];

    return {
      id: user.id,
      employeeCode: user.employeeCode,
      name: user.name,
      email: user.email,
      roles,
      permissions,
      sessionId: session.id,
      application,
      allowedApplications: [...allowedApplications],
    };
  }

  private async revoke(sessionId: string) {
    await this.prisma.session.updateMany({
      where: { id: sessionId, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
  }
}
