import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import * as crypto from 'crypto';

@Injectable()
export class ApiClientsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(name: string) {
    const clientId = crypto.randomUUID();
    const clientSecret = crypto.randomBytes(32).toString('hex');
    const hashed = crypto.createHash('sha256').update(clientSecret).digest('hex');
    const client = await this.prisma.apiClient.create({
      data: { name, clientId, clientSecretHash: hashed, status: 'ACTIVE' },
    });
    // Return the plaintext secret ONLY once at creation.
    return { ...this.toPublic(client), clientSecret };
  }

  async findAll() {
    const clients = await this.prisma.apiClient.findMany({ orderBy: { createdAt: 'desc' } });
    return clients.map((c) => this.toPublic(c));
  }

  async setStatus(id: string, status: 'ACTIVE' | 'DISABLED') {
    const existing = await this.prisma.apiClient.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('API client not found.');
    const updated = await this.prisma.apiClient.update({ where: { id }, data: { status } });
    return this.toPublic(updated);
  }

  async remove(id: string) {
    const existing = await this.prisma.apiClient.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('API client not found.');
    await this.prisma.apiClient.delete({ where: { id } });
    return { success: true };
  }

  private toPublic(client: any) {
    const { clientSecretHash, ...rest } = client;
    return rest;
  }
}
