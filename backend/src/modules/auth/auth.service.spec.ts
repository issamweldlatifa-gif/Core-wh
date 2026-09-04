import { Test } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from './token.service';
import { AuditService } from '../audit/audit.service';

const SECRET = 'TestSecret@1';
const HASH = bcrypt.hashSync(SECRET, 4);

function prismaMock() {
  const sessions: any[] = [];
  return {
    user: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    userRole: { findMany: jest.fn() },
    session: {
      create: jest.fn(async (args: any) => {
        const id = `sess-${sessions.length + 1}`;
        sessions.push({ id, ...args.data });
        return { id, ...args.data };
      }),
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn(),
    },
  };
}

describe('AuthService — strict Admin/Worker application gate (Order #3)', () => {
  async function makeService(roleName: string) {
    const prisma = prismaMock();
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      employeeCode: roleName === 'SUPER_ADMIN' ? 'Isco' : 'W1',
      name: 'Test',
      email: 't',
      status: 'ACTIVE',
      credentialMode: 'PASSWORD',
      passwordHash: HASH,
      pinHash: null,
    });
    prisma.userRole.findMany.mockResolvedValue([{ role: { name: roleName } }]);

    const tokens = {
      signAccessToken: jest.fn().mockReturnValue('at'),
      signRefreshToken: jest.fn().mockReturnValue({ token: 'rt', jti: 'j', hashed: 'h', expiresAt: new Date() }),
      hashToken: jest.fn((t: string) => `hash:${t}`),
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: TokenService, useValue: tokens },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    return { service: moduleRef.get(AuthService), prisma, tokens, audit };
  }

  it('allows an admin role on ADMIN_WEB (default) and binds the session to it', async () => {
    const { service, prisma, tokens } = await makeService('SUPER_ADMIN');
    const out = await service.login('Isco', SECRET, 'password', {});
    expect(out.accessToken).toBe('at');
    expect(prisma.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ application: 'ADMIN_WEB' }),
      }),
    );
    expect(tokens.signAccessToken).toHaveBeenCalledWith('user-1', expect.any(String), 'ADMIN_WEB');
  });

  it('denies an admin role asking to open the WORKER_NATIVE app', async () => {
    const { service, audit } = await makeService('SUPER_ADMIN');
    await expect(
      service.login('Isco', SECRET, 'password', { app: 'WORKER_NATIVE' }),
    ).rejects.toThrow(ForbiddenException);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'USER_LOGIN_FAILED',
        metadata: expect.objectContaining({ application: 'WORKER_NATIVE', roles: ['SUPER_ADMIN'] }),
      }),
    );
  });

  it('denies a worker role asking to open the ADMIN_WEB app', async () => {
    const { service } = await makeService('INBOUND_WORKER');
    await expect(
      service.login('W1', SECRET, 'password', { app: 'ADMIN_WEB' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('allows a worker role on WORKER_NATIVE and binds the session to it', async () => {
    const { service, prisma, tokens } = await makeService('INBOUND_WORKER');
    const out = await service.login('W1', SECRET, 'password', { app: 'WORKER_NATIVE' });
    expect(out.accessToken).toBe('at');
    expect(prisma.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ application: 'WORKER_NATIVE' }),
      }),
    );
    expect(tokens.signAccessToken).toHaveBeenCalledWith('user-1', expect.any(String), 'WORKER_NATIVE');
  });
});
