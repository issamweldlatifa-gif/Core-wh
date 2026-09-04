import { Test } from '@nestjs/testing';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from './token.service';
import { UnauthorizedException } from '@nestjs/common';

describe('TokenService', () => {
  let service: TokenService;

  beforeAll(() => {
    process.env.JWT_ACCESS_SECRET = 'test_access_secret';
    process.env.JWT_REFRESH_SECRET = 'test_refresh_secret';
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({})],
      providers: [TokenService],
    }).compile();
    service = moduleRef.get(TokenService);
  });

  it('signs and verifies an access token', () => {
    const token = service.signAccessToken('user-1', 'session-1');
    const payload = service.verifyAccessToken(token);
    expect(payload.sub).toBe('user-1');
    expect(payload.sid).toBe('session-1');
    expect(payload.type).toBe('access');
    // Default application surface is ADMIN_WEB (backwards compatible).
    expect(payload.app).toBe('ADMIN_WEB');
  });

  it('carries the application surface in both token kinds', () => {
    const access = service.signAccessToken('user-1', 'session-1', 'WORKER_NATIVE');
    const aPayload = service.verifyAccessToken(access);
    expect(aPayload.app).toBe('WORKER_NATIVE');

    const refresh = service.signRefreshToken('user-1', 'session-1', 'WORKER_NATIVE');
    const rPayload = service.verifyRefreshToken(refresh.token);
    expect(rPayload.app).toBe('WORKER_NATIVE');
  });

  it('rejects an invalid access token', () => {
    expect(() => service.verifyAccessToken('not-a-token')).toThrow(UnauthorizedException);
  });

  it('rejects a refresh token presented as access', () => {
    const r = service.signRefreshToken('user-1', 'session-1');
    expect(() => service.verifyAccessToken(r.token)).toThrow(UnauthorizedException);
  });

  it('hashes a refresh token deterministically', () => {
    const h1 = service.hashToken('abc');
    const h2 = service.hashToken('abc');
    expect(h1).toBe(h2);
    expect(h1).not.toBe('abc');
    expect(h1).toHaveLength(64);
  });
});
