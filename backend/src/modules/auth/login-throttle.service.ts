import { HttpException, Injectable } from '@nestjs/common';

/**
 * Per-account (per presented identifier) brute-force throttle for login.
 *
 * The IP rate limiter (common/guards/rate-limit.guard.ts) stops one machine
 * from spraying attempts, but a distributed attacker rotates IPs. This gate
 * is keyed by the identifier — the value an attacker must repeat to guess a
 * credential — so credential stuffing against ONE account slows to a crawl
 * even from many addresses.
 *
 * Design pragmatics (mirrors RateLimitGuard): in-memory, single instance,
 * bounded map. Only credential-type failures count (unknown code / missing
 * credential / bad secret); an inactive-account rejection is not a guessing
 * vector and must not add lock pressure. Locks expire on their own; a
 * successful login clears the account's history. Managers keep the stronger,
 * human tool: the LOCKED account status (auth login responds with a plain
 * "blocked by a manager" message for that case).
 */
@Injectable()
export class LoginThrottleService {
  private static readonly WINDOW_MS = 15 * 60 * 1000; // 15 minutes
  private static readonly MAX_FAILURES = 8;
  private static readonly LOCK_MS = 5 * 60 * 1000; // 5 minutes
  private static readonly MAX_BUCKETS = 10_000;

  private readonly buckets = new Map<string, { fails: number[]; lockUntil: number }>();

  /** Throws 429 while the identifier is locked; cheap no-op otherwise. */
  assertAllowed(identifier: string): void {
    const bucket = this.buckets.get(this.key(identifier));
    if (bucket && bucket.lockUntil > Date.now()) {
      const minutes = Math.max(1, Math.ceil((bucket.lockUntil - Date.now()) / 60_000));
      throw new HttpException(
        `Too many sign-in attempts for this account — try again in ~${minutes} minute(s).`,
        429,
      );
    }
  }

  /** Records one credential-type failure; locks the account at the threshold. */
  failure(identifier: string): void {
    const key = this.key(identifier);
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? { fails: [], lockUntil: 0 };
    bucket.fails = bucket.fails.filter((t) => now - t < LoginThrottleService.WINDOW_MS);
    bucket.fails.push(now);
    if (bucket.fails.length >= LoginThrottleService.MAX_FAILURES) {
      bucket.lockUntil = now + LoginThrottleService.LOCK_MS;
    }
    this.buckets.set(key, bucket);
    if (this.buckets.size > LoginThrottleService.MAX_BUCKETS) this.prune(now);
  }

  /** A proven credential wipes the account's failure history. */
  success(identifier: string): void {
    this.buckets.delete(this.key(identifier));
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      const last = bucket.fails.length ? bucket.fails[bucket.fails.length - 1] : 0;
      if (bucket.lockUntil < now && now - last >= LoginThrottleService.WINDOW_MS) {
        this.buckets.delete(key);
      }
    }
  }

  private key(identifier: string): string {
    return identifier.trim().toLowerCase();
  }
}
