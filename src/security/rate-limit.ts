// Fixed window in this process. shortcut: one Node server only, move the counters to Postgres before a second instance.

type Bucket = { reset: number; count: number };

const buckets = new Map<string, Bucket>();

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): { ok: true } | { ok: false; retryAfter: number } {
  if (buckets.size > 1000) {
    for (const [k, bucket] of buckets) if (now >= bucket.reset) buckets.delete(k);
  }
  const current = buckets.get(key);
  if (!current || now >= current.reset) {
    buckets.set(key, { reset: now + windowMs, count: 1 });
    return { ok: true };
  }
  if (current.count >= limit)
    return { ok: false, retryAfter: Math.max(1, Math.ceil((current.reset - now) / 1000)) };
  current.count += 1;
  return { ok: true };
}

export function resetRateLimits(): void {
  buckets.clear();
}
