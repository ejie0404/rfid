type AttemptBucket = { count: number; expiresAt: number };
export type AttemptDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** Small process-local limiter for sensitive API entry points. */
export class RequestAttemptLimiter {
  private readonly buckets = new Map<string, AttemptBucket>();
  private lastPrunedAt = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maximumBuckets = 10_000,
  ) {}

  take(key: string, maximum: number, windowMs: number): AttemptDecision {
    const currentTime = this.now();
    if (currentTime - this.lastPrunedAt >= 60_000 || this.buckets.size >= this.maximumBuckets) {
      for (const [bucketKey, bucket] of this.buckets)
        if (bucket.expiresAt <= currentTime) this.buckets.delete(bucketKey);
      this.lastPrunedAt = currentTime;
    }

    const existing = this.buckets.get(key);
    const bucket = existing && existing.expiresAt > currentTime ? existing : undefined;
    if (bucket && bucket.count >= maximum)
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.expiresAt - currentTime) / 1000)),
      };

    const next = bucket
      ? { ...bucket, count: bucket.count + 1 }
      : { count: 1, expiresAt: currentTime + windowMs };
    this.buckets.delete(key);
    this.buckets.set(key, next);
    while (this.buckets.size > this.maximumBuckets) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
    return { allowed: true };
  }
}

type AttemptRule = { name: string; maximum: number; windowMs: number };

/**
 * Shared route groups keep callers from bypassing limits by switching equivalent endpoints.
 * `route` is the router's matched route pattern, never the raw request URL. The router decodes
 * percent-encoding and ignores the query string, so every spelling that reaches a handler is
 * counted against that handler's group. An unmatched request (`undefined`) reaches no handler.
 */
export function attemptRule(method: string, route: string | undefined): AttemptRule | undefined {
  if (method.toUpperCase() !== "POST") return undefined;
  if (route === "/auth/login") return { name: "identity-login", maximum: 30, windowMs: 5 * 60_000 };
  if (route === "/auth/mfa/verify")
    return { name: "identity-mfa", maximum: 30, windowMs: 5 * 60_000 };
  if (route === "/demo/session") return { name: "demo-session", maximum: 30, windowMs: 5 * 60_000 };
  if (route === "/setup/operator")
    return { name: "operator-setup", maximum: 5, windowMs: 15 * 60_000 };
  if (route === "/auth/invitations/accept")
    return { name: "invitation-accept", maximum: 20, windowMs: 10 * 60_000 };
  if (route === "/edge/v1/enrollment/claim")
    return { name: "controller-enrollment", maximum: 8, windowMs: 60_000 };
  return undefined;
}
