import type { ThreadId } from "../types.js";
import {
  chooseSandboxName,
  hashSandboxName,
  isCharsetSafe,
  isHashName,
  parseSandboxName,
  SANDBOX_PREFIX,
  sandboxName,
} from "./sandbox-name.js";

const SAMPLES: ThreadId[] = [
  { channel: "C0ABCDEF", threadTs: "1748600000.123456" },
  { channel: "G12345678", threadTs: "1700000000.000100" },
  { channel: "D0XYZ", threadTs: "1.2" },
  { channel: "C0ABCDEFGHIJ", threadTs: "1748600000.999999" },
];

describe("sandboxName", () => {
  it("encodes as t-<channel>-<thread_ts>, keeping the '.' (spec §4.1)", () => {
    expect(sandboxName({ channel: "C0ABCDEF", threadTs: "1748600000.123456" })).toBe(
      "t-C0ABCDEF-1748600000.123456",
    );
  });

  it("NEVER substitutes '.' -> '_' (the spec's charset bug)", () => {
    for (const thread of SAMPLES) {
      const name = sandboxName(thread);
      expect(name).not.toContain("_");
      expect(name).toContain(".");
    }
  });

  it("only ever emits sbx-legal characters [A-Za-z0-9.+-]", () => {
    for (const thread of SAMPLES) {
      expect(isCharsetSafe(sandboxName(thread))).toBe(true);
    }
  });
});

describe("parseSandboxName (round-trip + namespacing)", () => {
  it("round-trips every sample: parse(name(t)) === t", () => {
    for (const thread of SAMPLES) {
      expect(parseSandboxName(sandboxName(thread))).toEqual(thread);
    }
  });

  it("is injective: distinct threads -> distinct names", () => {
    const names = new Set(SAMPLES.map(sandboxName));
    expect(names.size).toBe(SAMPLES.length);
  });

  it("returns null for foreign / utility / malformed names", () => {
    for (const name of [
      "_login-tmp", // sbx utility sandbox
      "codex-myrepo", // default sbx name shape
      "t-", // prefix only
      "t-C0ABCDEF", // no thread_ts
      "t-C0ABCDEF-notats", // thread_ts not numeric
      "t-C0ABCDEF-1748600000", // missing fractional part
      "C0ABCDEF-1748600000.1", // missing prefix
    ]) {
      expect(parseSandboxName(name)).toBeNull();
    }
  });

  it("returns null for hash names (caller reads ~/.agent-state/thread)", () => {
    const hashed = hashSandboxName(SAMPLES[0] as ThreadId);
    expect(parseSandboxName(hashed)).toBeNull();
  });
});

describe("hash fallback", () => {
  const thread = SAMPLES[0] as ThreadId;

  it("is deterministic, charset-safe, and recognized as a hash name", () => {
    const a = hashSandboxName(thread);
    const b = hashSandboxName(thread);
    expect(a).toBe(b);
    expect(a.startsWith(SANDBOX_PREFIX)).toBe(true);
    expect(isCharsetSafe(a)).toBe(true);
    expect(isHashName(a)).toBe(true);
    expect(a).not.toContain("_");
  });

  it("maps distinct threads to distinct hashes", () => {
    expect(hashSandboxName(SAMPLES[0] as ThreadId)).not.toBe(
      hashSandboxName(SAMPLES[1] as ThreadId),
    );
  });

  it("avoids collisions across the channel/ts boundary", () => {
    // Without a separator, ("ab","c") and ("a","bc") could collide.
    expect(hashSandboxName({ channel: "AB", threadTs: "1.2" })).not.toBe(
      hashSandboxName({ channel: "A", threadTs: "B1.2" }),
    );
  });
});

describe("chooseSandboxName", () => {
  const thread = SAMPLES[0] as ThreadId;

  it("uses the plain reversible name when it fits", () => {
    const name = chooseSandboxName(thread);
    expect(name).toBe(sandboxName(thread));
    expect(parseSandboxName(name)).toEqual(thread);
  });

  it("falls back to a hash name when the plain name exceeds maxLen", () => {
    const name = chooseSandboxName(thread, 10);
    expect(isHashName(name)).toBe(true);
    expect(name).toBe(hashSandboxName(thread));
  });
});

describe("isHashName / isCharsetSafe", () => {
  it("distinguishes hash names from plain names", () => {
    expect(isHashName("t-0123456789abcdef")).toBe(true);
    expect(isHashName("t-C0ABCDEF-1748600000.123456")).toBe(false);
    expect(isHashName("t-0123456789ABCDEF")).toBe(false); // uppercase != hex digest
  });

  it("flags underscores as charset-unsafe", () => {
    expect(isCharsetSafe("t-C0ABCDEF-1748600000_123456")).toBe(false);
    expect(isCharsetSafe("t-C0ABCDEF-1748600000.123456")).toBe(true);
  });
});
