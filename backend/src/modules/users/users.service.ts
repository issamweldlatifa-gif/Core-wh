import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(dto: CreateUserDto, actorUserId: string, ip?: string) {
    const exists = await this.prisma.user.findFirst({
      where: {
        OR: [{ employeeCode: dto.employeeCode }, ...(dto.email ? [{ email: dto.email }] : [])],
      },
    });
    if (exists) {
      throw new ConflictException('A user with that employee code or email already exists.');
    }

    const salt = 12;
    const data: any = {
      name: dto.name,
      employeeCode: dto.employeeCode,
      email: dto.email ?? null,
      status: dto.isActive === false ? 'DISABLED' : 'ACTIVE',
      credentialMode: dto.credentialMode ?? 'PASSWORD',
    };
    data.passwordHash = await bcrypt.hash(dto.password, salt);
    if (dto.credentialMode === 'PIN' || dto.credentialMode === 'BOTH') {
      if (!dto.pin) throw new BadRequestException('A PIN is required for PIN/BOTH credential mode.');
      data.pinHash = await bcrypt.hash(dto.pin, salt);
    }

    const created = await this.prisma.user.create({ data });

    if (dto.roles?.length) {
      const roles = await this.prisma.role.findMany({ where: { name: { in: dto.roles } } });
      if (roles.length !== dto.roles.length) {
        const found = roles.map((r) => r.name);
        const missing = dto.roles.filter((r) => !found.includes(r));
        throw new BadRequestException(`Unknown role(s): ${missing.join(', ')}`);
      }
      await this.prisma.userRole.createMany({
        data: roles.map((r) => ({ userId: created.id, roleId: r.id, assignedById: actorUserId })),
      });
    }

    await this.audit.log({
      actorUserId,
      action: 'USER_CREATED',
      entityType: 'user',
      entityId: created.id,
      ipAddress: ip,
      metadata: { employeeCode: created.employeeCode, roles: dto.roles ?? [] },
    });

    return this.toPublic(created);
  }

  async findAll() {
    const users = await this.prisma.user.findMany({
      include: { roles: { include: { role: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return users.map((u) => this.toPublic(u));
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { roles: { include: { role: true } } },
    });
    if (!user) throw new NotFoundException('User not found.');
    return this.toPublic(user);
  }

  async update(id: string, dto: UpdateUserDto, actorUserId: string, ip?: string) {
    const existing = await this.prisma.user.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('User not found.');

    const data: any = {};
    if (dto.name) data.name = dto.name;
    if (dto.email !== undefined) {
      if (dto.email) data.email = dto.email;
      else data.email = null;
    }
    if (dto.isActive !== undefined) data.status = dto.isActive ? 'ACTIVE' : 'DISABLED';
    if (dto.password) data.passwordHash = await bcrypt.hash(dto.password, 12);
    if (dto.pin) data.pinHash = await bcrypt.hash(dto.pin, 12);
    if (dto.credentialMode) data.credentialMode = dto.credentialMode;

    const updated = await this.prisma.user.update({ where: { id }, data });

    if (dto.roles) await this.assignRoles(id, dto.roles, actorUserId, ip);

    if (dto.isActive !== undefined) {
      await this.audit.log({
        actorUserId,
        action: 'USER_STATUS_CHANGED',
        entityType: 'user',
        entityId: id,
        ipAddress: ip,
        metadata: { status: dto.isActive ? 'ACTIVE' : 'DISABLED' },
      });
      // Disabling a worker must end their live sessions NOW (server-side):
      // the next request with an old token fails and the worker is forced to
      // re-authenticate (Doc1 §12 — Session Revocation).
      if (!dto.isActive) {
        await this.revokeActiveSessions(id, actorUserId, ip, 'user_disabled');
      }
    }

    return this.toPublic(updated);
  }

  async assignRoles(userId: string, roleNames: string[], actorUserId: string, ip?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found.');

    const roles = await this.prisma.role.findMany({ where: { name: { in: roleNames } } });
    if (roles.length !== roleNames.length) {
      const found = roles.map((r) => r.name);
      const missing = roleNames.filter((r) => !found.includes(r));
      throw new BadRequestException(`Unknown role(s): ${missing.join(', ')}`);
    }

    await this.prisma.$transaction([
      this.prisma.userRole.deleteMany({ where: { userId } }),
      this.prisma.userRole.createMany({
        data: roles.map((r) => ({ userId, roleId: r.id, assignedById: actorUserId })),
      }),
    ]);

    await this.audit.log({
      actorUserId,
      action: 'USER_ROLES_CHANGED',
      entityType: 'user',
      entityId: userId,
      ipAddress: ip,
      metadata: { roles: roleNames },
    });
    return { userId, roles: roleNames };
  }

  async remove(id: string, actorUserId: string, ip?: string) {
    const existing = await this.prisma.user.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('User not found.');
    if (existing.employeeCode === process.env.INITIAL_ADMIN_CODE) {
      throw new BadRequestException('The initial admin account cannot be deleted.');
    }
    // Soft disable rather than hard delete is safer; Phase 0 disables.
    await this.prisma.user.update({ where: { id }, data: { status: 'DISABLED' } });
    await this.audit.log({ actorUserId, action: 'USER_DELETED', entityType: 'user', entityId: id, ipAddress: ip });
    await this.revokeActiveSessions(id, actorUserId, ip, 'user_disabled');
    return { success: true };
  }

  private async revokeActiveSessions(
    userId: string,
    actorUserId: string,
    ip?: string,
    reason?: string,
  ) {
    const revoked = await this.prisma.session.updateMany({
      where: { userId, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    if (revoked.count > 0) {
      await this.audit.log({
        actorUserId,
        action: 'SESSION_REVOKED' as any,
        entityType: 'user',
        entityId: userId,
        ipAddress: ip,
        metadata: { reason: reason ?? 'user_disabled', count: revoked.count },
      });
    }
  }

  private toPublic(user: any) {
    const { passwordHash, pinHash, ...rest } = user;
    return {
      ...rest,
      roles: user.roles?.map((r: any) => ({ id: r.role.id, name: r.role.name })) ?? [],
    };
  }
}
