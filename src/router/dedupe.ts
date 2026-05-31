/**
 * Idempotent-dispatch dedupe (spec §4.1).
 *
 * Immediate Socket Mode ACK stops the retry storm but duplicates still arrive (a
 * lost ACK inside the retry window, or a reconnect race). The router dedupes on
 * the mention's Slack `ts`: a `ts` already accepted is dropped.
 *
 * This is a TTL set keyed by `ts`, sized to cover Slack's ~5-min retry window.
 * It lives in router memory (transient bucket, §3) and is lost on restart, which
 * is fine — retries don't outlive that window. The clock is injected so the TTL
 * is testable without sleeping.
 */

/** Slack retries an unacked event for ~5 minutes (immediately, then ~1m, ~5m). */
export const DEFAULT_DEDUPE_TTL_MS = 5 * 60_000;

export interface TtlSet {
  /** True iff `key` was added within the TTL window. Evicts expired keys first. */
  has(key: string): boolean;
  /** Record `key` as seen at the current time. */
  add(key: string): void;
  /** Count of non-expired keys (test introspection). */
  size(): number;
}

export function createTtlSet(
  ttlMs: number = DEFAULT_DEDUPE_TTL_MS,
  now: () => number = Date.now,
): TtlSet {
  const insertedAt = new Map<string, number>();

  const evict = (current: number): void => {
    for (const [key, ts] of insertedAt) {
      if (current - ts >= ttlMs) {
        insertedAt.delete(key);
      }
    }
  };

  return {
    has(key: string): boolean {
      evict(now());
      return insertedAt.has(key);
    },
    add(key: string): void {
      const current = now();
      evict(current);
      insertedAt.set(key, current);
    },
    size(): number {
      evict(now());
      return insertedAt.size;
    },
  };
}
