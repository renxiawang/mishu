/** Slack retries an unacked event for ~5 minutes (immediately, then ~1m, ~5m). */
export const DEFAULT_DEDUPE_TTL_MS = 5 * 60_000;

export interface TtlSet {
  has(key: string): boolean;
  add(key: string): void;
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
