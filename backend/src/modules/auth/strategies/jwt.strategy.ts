import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticatedUser } from '../../../common/interfaces/authenticated-user.interface';
import { AccessTokenPayload } from '../token.service';

/**
 * Validates the access token and rebuilds the AuthenticatedUser from the
 * DATABASE on every request (roles + permissions reloaded), so that:
 *   - a deleted / disabled / locked user is rejected immediately;
 *   - a revoked or expired session is rejected immediately;
 *   - permission changes are effective immediately (no stale token claims).
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
      include: { user: true },
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

    // Touch lastSeenAt occasionally? For Phase 0 we skip to keep requests light.

    const roleRows = await this.prisma.userRole.findMany({
      where: { userId: user.id },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    });

    const roles = roleRows.map((r) => r.role.name);
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
    };
  }
}
