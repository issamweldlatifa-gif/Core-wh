import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TokenService, RefreshTokenPayload } from './token.service';
import * as bcrypt from 'bcrypt';
import {
  applicationsAllowedByRoleClasses,
  classifyRole,
  evaluateAccess,
  roleClassOf,
  type ApplicationKind,
} from '../access/application-access';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * A cross-app login attempt (admin role asking for WORKER_NATIVE, or a worker
 * role asking for ADMIN_WEB) is rejected here at the session boundary — the
 * single gate the Native Worker App and the Admin Web share. Nothing else in
 * the API can mint a session for the wrong surface.
 */
function applicationDenyMessage(app: ApplicationKind, roles: string[]): string {
  const classes = roles.map((r) => classifyRole(r));
  if (app === 'WORKER_NATIVE' && classes.some((c) => c === 'ADMIN' || c === 'VIEWER')) {
    return 'This account is an Admin/Viewer — it cannot open the Worker app.';
  }
  if (app === 'ADMIN_WEB' && classes.some((c) => c === 'OPERATIONAL')) {
    return 'This is a warehouse worker account — it cannot open the Admin Web.';
  }
  return `This account is not permitted on ${app}.`;
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
    ctx?: { ip?: string; ua?: string; app?: ApplicationKind; deviceId?: string },
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

    // Strict application gate (Order #3): resolve the user's DB roles and the
    // requested application surface, then enforce the isolation rule BEFORE a
    // session can be created. Roles come from the database — the client never
    // supplies them, so a role can never be claimed.
    const roleRows = await this.prisma.userRole.findMany({
      where: { userId: user.id },
      include: { role: true },
    });
    const roles = roleRows.map((r) => r.role.name);
    // Data-driven classification: the DB `applicationClass` column decides
    // which surfaces these roles may open (Doc1 §15, Doc2 §6). The client
    // never supplies a class.
    const roleClasses = roleRows.map((r) => roleClassOf(r.role));
    const application: ApplicationKind = ctx?.app ?? 'ADMIN_WEB';
    const decision = evaluateAccess({
      application,
      roles,
      roleClasses,
      accountActive: true,
    });
    if (!decision.allowed) {
      await this.audit.log({
        actorUserId: user.id,
        action: 'USER_LOGIN_FAILED',
        entityType: 'user',
        entityId: user.id,
        ipAddress: ctx?.ip,
        metadata: {
          reason: `application_${decision.reason}`,
          application,
          roles,
          roleClasses,
          allowed: [...applicationsAllowedByRoleClasses(roleClasses)],
        },
      });
      throw new ForbiddenException(applicationDenyMessage(application, roles));
    }

    // Strict device + station binding (native worker app): when a WORKER_NATIVE
    // login presents a device code, the server verifies the device is real,
    // ACTIVE and not assigned to someone else (first use binds it to this
    // worker). The worker's currently assigned station is captured on the
    // session so later reassignment/disable can be enforced server-side.
    // ADMIN_WEB logins never bind a device (deviceId is ignored there).
    let deviceId: string | undefined;
    let stationId: string | undefined;
    if (application === 'WORKER_NATIVE') {
      if (ctx?.deviceId) {
        const bound = await this.authorizeDeviceForWorker(
          ctx.deviceId,
          user.id,
          ctx.ip,
          application,
        );
        if (!bound) {
          throw new ForbiddenException('This device is not authorized for the Worker app.');
        }
        deviceId = bound;
      }
      stationId = await this.resolveAssignedStationId(user.id);
    }

    const tokens = await this.createSession(
      user.id,
      ctx?.ip,
      ctx?.ua,
      application,
      deviceId,
      stationId,
    );
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
      metadata: { mode: resolveMode, application },
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

    // A refresh keeps the SAME application surface the session was opened for
    // (server truth is the DB row; the token claim is only echoed). Device and
    // station binding are preserved across the rotation.
    return this.createSession(
      session.userId,
      session.ipAddress ?? undefined,
      session.userAgent ?? undefined,
      session.application as ApplicationKind,
      session.deviceId ?? undefined,
      session.stationId ?? undefined,
    );
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
    const revoked = await this.prisma.session.updateMany({
      where: { id: sessionId, userId },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    if (revoked.count > 0) {
      await this.audit.log({
        actorUserId: userId,
        action: 'SESSION_REVOKED' as any,
        entityType: 'session',
        entityId: sessionId,
        metadata: { reason: 'admin_revoked_session' },
      });
    }
  }

  async revokeAllSessions(userId: string, actorUserId?: string) {
    const revoked = await this.prisma.session.updateMany({
      where: { userId, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    if (revoked.count > 0) {
      await this.audit.log({
        actorUserId: actorUserId ?? userId,
        action: 'SESSION_REVOKED' as any,
        entityType: 'user',
        entityId: userId,
        metadata: { reason: 'revoke_all_sessions', count: revoked.count },
      });
    }
  }

  /**
   * Creates a DB session record, stores the hashed refresh token (never
   * plain text) and returns a properly signed access + refresh pair bound to
   * that session id.
   */
  private async createSession(
    userId: string,
    ip?: string,
    ua?: string,
    application: ApplicationKind = 'ADMIN_WEB',
    deviceId?: string,
    stationId?: string,
  ): Promise<AuthTokens> {
    // First create the session with a temporary hashed token so we can get an id.
    const hashed = this.tokens.hashToken('placeholder');
    const session = await this.prisma.session.create({
      data: {
        userId,
        refreshTokenHash: hashed,
        ipAddress: ip,
        userAgent: ua,
        status: 'ACTIVE',
        application,
        deviceId: deviceId ?? null,
        stationId: stationId ?? null,
        expiresAt: new Date(Date.now() + this.refreshTtlMs()),
        lastSeenAt: new Date(),
      },
    });

    // Now sign the real tokens bound to session.id.
    const accessToken = this.tokens.signAccessToken(userId, session.id, application);
    const { token: refreshToken } = this.tokens.signRefreshToken(userId, session.id, application);
    const finalHash = this.tokens.hashToken(refreshToken);
    await this.prisma.session.update({
      where: { id: session.id },
      data: { refreshTokenHash: finalHash },
    });

    return { accessToken, refreshToken };
  }

  /**
   * Server-side device authorization (Doc1 §7, Doc2 §11, Doc3 §11).
   * The device code comes from the native app; the decision uses the DB
   * record only — a device the admin never registered, a disabled device or
   * a device assigned to another worker is rejected with DEVICE_REJECTED and
   * no session is created.
   *
   * @returns the device row id when authorized, else null (caller denies).
   */
  private async authorizeDeviceForWorker(
    deviceCodeRaw: string,
    workerId: string,
    ip?: string,
    application?: ApplicationKind,
  ): Promise<string | null> {
    const code = deviceCodeRaw.trim().toUpperCase();
    const device = await this.prisma.device.findUnique({ where: { code } });

    const deny = async (reason: string, deviceId?: string) => {
      await this.audit.log({
        actorUserId: workerId,
        action: 'DEVICE_REJECTED' as any,
        entityType: 'device',
        entityId: deviceId ?? null,
        ipAddress: ip,
        metadata: { deviceCode: code, reason, application: application ?? 'WORKER_NATIVE' },
      });
      return null;
    };

    if (!device) return deny('unknown_device');
    if (device.status !== 'ACTIVE') return deny(`device_${device.status.toLowerCase()}`, device.id);
    if (device.assignedWorkerId && device.assignedWorkerId !== workerId) {
      return deny('assigned_to_another_worker', device.id);
    }

    // First use binds the device to this worker (admin can re-assign later).
    const bound = await this.prisma.device.update({
      where: { id: device.id },
      data: {
        assignedWorkerId: device.assignedWorkerId ?? workerId,
        lastSeenAt: new Date(),
        lastSeenIp: ip ?? null,
      },
    });
    return bound.id;
  }

  /**
   * Resolve the station a worker is currently assigned to (ACTIVE only).
   * When a worker is assigned to exactly one station that id is captured on
   * the session; zero or several stations leave it null (the terminal home
   * already handles "no station" and "several stations" flows).
   */
  private async resolveAssignedStationId(workerId: string): Promise<string | undefined> {
    const stations = await this.prisma.station.findMany({
      where: { assignedWorkerId: workerId, status: 'ACTIVE' },
      select: { id: true },
      take: 2,
    });
    if (stations.length === 1) return stations[0].id;
    return undefined;
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
