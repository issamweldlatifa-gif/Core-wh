import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(dto: CreateRoleDto, actorUserId: string, ip?: string) {
    const exists = await this.prisma.role.findUnique({ where: { name: dto.name } });
    if (exists) throw new ConflictException('Role already exists.');

    const created = await this.prisma.role.create({
      data: {
        name: dto.name,
        description: dto.description ?? null,
        isSystem: false,
        applicationClass: dto.applicationClass ?? 'UNKNOWN',
      },
    });

    if (dto.permissions?.length) {
      await this.grantPermissions(created.id, dto.permissions, actorUserId, ip, false);
    }

    await this.audit.log({
      actorUserId,
      action: 'ROLE_CREATED',
      entityType: 'role',
      entityId: created.id,
      ipAddress: ip,
      metadata: { name: created.name, permissions: dto.permissions ?? [] },
    });
    return created;
  }

  async findAll() {
    return this.prisma.role.findMany({
      include: { permissions: { include: { permission: true } } },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string) {
    const role = await this.prisma.role.findUnique({
      where: { id },
      include: { permissions: { include: { permission: true } } },
    });
    if (!role) throw new NotFoundException('Role not found.');
    return role;
  }

  async update(id: string, dto: UpdateRoleDto, actorUserId: string, ip?: string) {
    const existing = await this.prisma.role.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Role not found.');

    const data: any = {};
    if (dto.name) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description ?? null;
    if (dto.applicationClass !== undefined) data.applicationClass = dto.applicationClass;

    const updated = await this.prisma.role.update({ where: { id }, data });
    if (dto.permissions) await this.grantPermissions(id, dto.permissions, actorUserId, ip, false);
    return updated;
  }

  async grantPermissions(roleId: string, permissionKeys: string[], actorUserId: string, ip?: string, audit = true) {
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role) throw new NotFoundException('Role not found.');

    const perms = await this.prisma.permission.findMany({ where: { key: { in: permissionKeys } } });
    if (perms.length !== permissionKeys.length) {
      const found = new Set(perms.map((p) => p.key));
      const missing = permissionKeys.filter((k) => !found.has(k));
      throw new BadRequestException(`Unknown permission(s): ${missing.join(', ')}`);
    }

    await this.prisma.$transaction([
      this.prisma.rolePermission.deleteMany({ where: { roleId } }),
      this.prisma.rolePermission.createMany({
        data: perms.map((p) => ({ roleId, permissionId: p.id })),
      }),
    ]);

    if (audit) {
      await this.audit.log({
        actorUserId,
        action: 'ROLE_PERMISSIONS_CHANGED',
        entityType: 'role',
        entityId: roleId,
        ipAddress: ip,
        metadata: { permissions: permissionKeys },
      });
    }
    return { roleId, permissions: permissionKeys };
  }

  async remove(id: string, actorUserId: string, ip?: string) {
    const role = await this.prisma.role.findUnique({ where: { id } });
    if (!role) throw new NotFoundException('Role not found.');
    if (role.isSystem) throw new BadRequestException('System roles cannot be deleted.');
    await this.prisma.role.delete({ where: { id } });
    await this.audit.log({ actorUserId, action: 'ROLE_DELETED', entityType: 'role', entityId: id, ipAddress: ip, metadata: { name: role.name } });
    return { success: true };
  }
}
