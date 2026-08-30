import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class PermissionsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.permission.findMany({
      orderBy: [{ resource: 'asc' }, { action: 'asc' }],
    });
  }

  async findOne(key: string) {
    const perm = await this.prisma.permission.findUnique({ where: { key } });
    if (!perm) throw new NotFoundException('Permission not found.');
    return perm;
  }
}
