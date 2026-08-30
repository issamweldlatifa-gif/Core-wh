import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';

export interface AccessTokenPayload {
  sub: string; // user id
  sid: string; // session id
  type: 'access';
}

export interface RefreshTokenPayload {
  sub: string; // user id
  sid: string; // session id
  type: 'refresh';
  jti: string; // unique token id (used to correlate with session)
}

@Injectable()
export class TokenService {
  constructor(private readonly jwtService: JwtService) {}

  signAccessToken(userId: string, sessionId: string): string {
    const payload: AccessTokenPayload = { sub: userId, sid: sessionId, type: 'access' };
    return this.jwtService.sign(payload, {
      secret: process.env.JWT_ACCESS_SECRET,
      expiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '15m',
    });
  }

  signRefreshToken(userId: string, sessionId: string): {
    token: string;
    jti: string;
    hashed: string;
    expiresAt: Date;
  } {
    const jti = crypto.randomUUID();
    const payload: RefreshTokenPayload = { sub: userId, sid: sessionId, type: 'refresh', jti };
    const token = this.jwtService.sign(payload, {
      secret: process.env.JWT_REFRESH_SECRET,
      expiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '7d',
    });
    const expiresInMs = this.toMs(process.env.JWT_REFRESH_EXPIRES_IN ?? '7d');
    return {
      token,
      jti,
      hashed: this.hashToken(token),
      expiresAt: new Date(Date.now() + expiresInMs),
    };
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    try {
      const payload = this.jwtService.verify<AccessTokenPayload>(token, {
        secret: process.env.JWT_ACCESS_SECRET,
      });
      if (payload.type !== 'access') {
        throw new UnauthorizedException('Invalid token type.');
      }
      return payload;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token.');
    }
  }

  verifyRefreshToken(token: string): RefreshTokenPayload {
    try {
      const payload = this.jwtService.verify<RefreshTokenPayload>(token, {
        secret: process.env.JWT_REFRESH_SECRET,
      });
      if (payload.type !== 'refresh') {
        throw new UnauthorizedException('Invalid token type.');
      }
      return payload;
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token.');
    }
  }

  hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private toMs(expiresIn: string): number {
    const match = /^(\d+)([smhd])$/.exec(expiresIn.trim());
    if (!match) return 7 * 24 * 60 * 60 * 1000; // default 7d
    const n = Number(match[1]);
    switch (match[2]) {
      case 's': return n * 1000;
      case 'm': return n * 60 * 1000;
      case 'h': return n * 60 * 60 * 1000;
      case 'd': return n * 24 * 60 * 60 * 1000;
      default: return n * 1000;
    }
  }
}
