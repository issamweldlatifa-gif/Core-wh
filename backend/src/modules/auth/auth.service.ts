import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TokenService, RefreshTokenPayload } from './token.service';
import * as bcrypt from 'bcrypt';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  async login(
    identifier: string,
    secret: string,
    mode?: 'password' | 'pin',
    ctx?: { ip?: string; ua?: string },
  ): Promise<AuthTokens> {
    const user = await this.prisma.user.findUnique({
      where: { employeeCode: identifier },
    });

    // Uniform error; never reveal whether the employee code exists.
    const invalid = new UnauthorizedException('Invalid credentials.');
    if (!user) {
      await this.audit.log({
        actorUserId: null,
        action: 'USER_LOGIN_FAILED',
        entityType: 'user',
        entityId: null,
        ipAddress: ctx?.ip,
        metadata: { identifier, reason: 'unknown_user' },
      });
      throw invalid;
    }
    if (user.status !== 'ACTIVE') {
      await this.audit.log({
        actorUserId: user.id,
        action: 'USER_LOGIN_FAILED',
        entityType: 'user',
        entityId: user.id,
        ipAddress: ctx?.ip,
        metadata: { reason: `account_${user.status}` },
      });
      // Worker Control (COMMAND #3): a LOCKED account was temporarily blocked
      // (reversible by a manager), a DISABLED one was removed for good. Say so
      // plainly so the worker knows to ask a manager instead of retrying.
      if (user.status === 'LOCKED') throw new ForbiddenException('Account is blocked by a manager — contact your supervisor.');
      throw new ForbiddenException('Account is not active.');
    }

    const resolveMode = mode ?? (user.credentialMode === 'PIN' ? 'pin' : 'password');
    const hashToCheck = resolveMode === 'pin' ? user.pinHash : user.passwordHash;
    if (!hashToCheck) {
      await this.audit.log({
        actorUserId: user.id,
        action: 'USER_LOGIN_FAILED',
        entityType: 'user',
        entityId: user.id,
        ipAddress: ctx?.ip,
        metadata: { reason: 'no_credential' },
      });
      throw invalid;
    }

    const ok = await bcrypt.compare(secret, hashToCheck);
    if (!ok) {
      await this.audit.log({
        actorUserId: user.id,
        action: 'USER_LOGIN_FAILED',
        entityType: 'user',
        entityId: user.id,
        ipAddress: ctx?.ip,
        metadata: { reason: 'bad_secret' },
      });
      throw invalid;
    }

    const tokens = await this.createSession(user.id, ctx?.ip, ctx?.ua);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    await this.audit.log({
      actorUserId: user.id,
      action: 'USER_LOGIN',
      entityType: 'user',
      entityId: user.id,
      ipAddress: ctx?.ip,
      metadata: { mode: resolveMode },
    });

    return tokens;
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    const payload = this.tokens.verifyRefreshToken(refreshToken);
    const session = await this.prisma.session.findUnique({
      where: { id: payload.sid },
    });
    if (!session || session.status !== 'ACTIVE' || session.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Session is no longer active.');
    }

    // Rotate the refresh token to prevent replay.
    await this.prisma.session.update({
      where: { id: session.id },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });

    return this.createSession(session.userId, session.ipAddress ?? undefined, session.userAgent ?? undefined);
  }

  async logout(userId: string, sessionId: string, ip?: string) {
    await this.prisma.session.updateMany({
      where: { id: sessionId, userId },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    await this.audit.log({
      actorUserId: userId,
      action: 'USER_LOGOUT',
      entityType: 'session',
      entityId: sessionId,
      ipAddress: ip,
    });
  }

  async revokeSession(userId: string, sessionId: string) {
    await this.prisma.session.updateMany({
      where: { id: sessionId, userId },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
  }

  async revokeAllSessions(userId: string) {
    await this.prisma.session.updateMany({
      where: { userId, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
  }

  /**
   * Creates a DB session record, stores the hashed refresh token (never
   * plain text) and returns a properly signed access + refresh pair bound to
   * that session id.
   */
  private async createSession(userId: string, ip?: string, ua?: string): Promise<AuthTokens> {
    // First create the session with a temporary hashed token so we can get an id.
    const hashed = this.tokens.hashToken('placeholder');
    const session = await this.prisma.session.create({
      data: {
        userId,
        refreshTokenHash: hashed,
        ipAddress: ip,
        userAgent: ua,
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + this.refreshTtlMs()),
        lastSeenAt: new Date(),
      },
    });

    // Now sign the real tokens bound to session.id.
    const accessToken = this.tokens.signAccessToken(userId, session.id);
    const { token: refreshToken } = this.tokens.signRefreshToken(userId, session.id);
    const finalHash = this.tokens.hashToken(refreshToken);
    await this.prisma.session.update({
      where: { id: session.id },
      data: { refreshTokenHash: finalHash },
    });

    return { accessToken, refreshToken };
  }

  private refreshTtlMs(): number {
    const v = process.env.JWT_REFRESH_EXPIRES_IN ?? '7d';
    const m = /^(\d+)([smhd])$/.exec(v.trim());
    if (!m) return 7 * 24 * 60 * 60 * 1000;
    const n = Number(m[1]);
    switch (m[2]) {
      case 's': return n * 1000;
      case 'm': return n * 60 * 1000;
      case 'h': return n * 60 * 60 * 1000;
      case 'd': return n * 24 * 60 * 60 * 1000;
    }
    return n * 1000;
  }
}
