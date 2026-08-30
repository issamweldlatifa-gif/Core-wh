import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';

/**
 * Simple in-memory sliding-window rate limiter protecting the authentication
 * endpoints (login/refresh) against brute force abuse.
 *
 * NOTE: In-memory limits are per-instance. In a multi-instance production
 * deployment this should be backed by a shared store (Redis). This satisfies
 * the Phase 0 security requirement for the single-instance default; the
 * upgrade path is documented in OPEN-DECISIONS.md.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private static readonly WINDOW_MS = 15 * 60 * 1000; // 15 minutes
  private static readonly MAX_ATTEMPTS = 20;
  private readonly buckets = new Map<string, number[]>();

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const ip = req.ip ?? 'unknown';
    const now = Date.now();

    const timestamps = (this.buckets.get(ip) ?? []).filter(
      (t) => now - t < RateLimitGuard.WINDOW_MS,
    );
    if (timestamps.length >= RateLimitGuard.MAX_ATTEMPTS) {
      throw new HttpException(
        'Too many attempts. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    timestamps.push(now);
    this.buckets.set(ip, timestamps);
    return true;
  }
}
