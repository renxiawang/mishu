import { createTtlSet, DEFAULT_DEDUPE_TTL_MS } from "./dedupe.js";

describe("createTtlSet", () => {
  it("reports added keys as present within the TTL window", () => {
    const clock = 1000;
    const set = createTtlSet(1000, () => clock);
    expect(set.has("ts-1")).toBe(false);
    set.add("ts-1");
    expect(set.has("ts-1")).toBe(true);
  });

  it("tracks distinct keys independently", () => {
    let clock = 0;
    const set = createTtlSet(1000, () => clock);
    set.add("a");
    clock = 1; // keep the same window
    expect(set.has("a")).toBe(true);
    expect(set.has("b")).toBe(false);
    set.add("b");
    expect(set.has("a")).toBe(true);
    expect(set.has("b")).toBe(true);
  });

  it("does NOT evict before the TTL elapses", () => {
    let clock = 0;
    const set = createTtlSet(1000, () => clock);
    set.add("a");
    clock = 999; // one tick before expiry
    expect(set.has("a")).toBe(true);
  });

  it("evicts exactly at the TTL boundary", () => {
    let clock = 0;
    const set = createTtlSet(1000, () => clock);
    set.add("a");
    clock = 1000; // current - inserted === ttl -> expired
    expect(set.has("a")).toBe(false);
  });

  it("size() counts only non-expired keys", () => {
    let clock = 0;
    const set = createTtlSet(1000, () => clock);
    set.add("a"); // inserted at 0
    clock = 500;
    set.add("b"); // inserted at 500
    expect(set.size()).toBe(2);
    clock = 1000; // "a" expires (1000-0>=1000), "b" survives (1000-500<1000)
    expect(set.size()).toBe(1);
    expect(set.has("a")).toBe(false);
    expect(set.has("b")).toBe(true);
  });

  it("defaults the TTL to at least Slack's ~5-min retry window", () => {
    expect(DEFAULT_DEDUPE_TTL_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });
});
