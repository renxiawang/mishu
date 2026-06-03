import type { SandboxHandle } from "../sandbox/index.js";
import type { ThreadId, ThreadMessage } from "../types.js";
import { IdleSweeper, parseThreadRef, selectIdle, tsToMs } from "./idle-sweep.js";

const msg = (ts: string): ThreadMessage => ({ ts, user: "U1", text: "x" });

describe("tsToMs", () => {
  it("converts Slack ts to epoch ms", () => {
    expect(tsToMs("1748600000.123456")).toBeCloseTo(1748600000123.456, 0);
  });
});

describe("parseThreadRef", () => {
  it("parses a 'channel threadTs' reverse-map line", () => {
    expect(parseThreadRef("C0ABCDEF 1748600000.123456\n")).toEqual({
      channel: "C0ABCDEF",
      threadTs: "1748600000.123456",
    });
  });
  it("returns null for malformed input", () => {
    expect(parseThreadRef("nospace")).toBeNull();
    expect(parseThreadRef("")).toBeNull();
  });
});

describe("selectIdle", () => {
  const now = 1_000_000;
  const idleMs = 1000;
  it("selects only sandboxes idle for >= idleMs", () => {
    expect(
      selectIdle(
        [
          { name: "old", lastActivityMs: now - 2000 },
          { name: "fresh", lastActivityMs: now - 500 },
          { name: "exactly", lastActivityMs: now - 1000 },
        ],
        now,
        idleMs,
      ),
    ).toEqual(["old", "exactly"]);
  });
  it("never evicts sandboxes with unknown activity", () => {
    expect(selectIdle([{ name: "unknown", lastActivityMs: null }], now, idleMs)).toEqual([]);
  });
});

class FakeSweepSandbox {
  stopped: string[] = [];
  failStops = new Set<string>();
  readonly files = new Map<string, string>();
  constructor(private readonly handles: SandboxHandle[]) {}
  async list(): Promise<SandboxHandle[]> {
    return this.handles;
  }
  async stop(handle: SandboxHandle): Promise<void> {
    if (this.failStops.has(handle.name)) {
      throw new Error(`stop failed: ${handle.name}`);
    }
    this.stopped.push(handle.name);
  }
  async homeDir(): Promise<string> {
    return "/home/agent";
  }
  async readFile(handle: SandboxHandle, absPath: string): Promise<string | null> {
    return this.files.get(`${handle.name}:${absPath}`) ?? this.files.get(absPath) ?? null;
  }
  async writeFile(): Promise<void> {}
  // unused provider surface
  async create(): Promise<SandboxHandle> {
    return { name: "x" };
  }
  async exec(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
  async execShell(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
  async getFile(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async putFile(): Promise<void> {}
  async destroy(): Promise<void> {}
}

class FakeSweepPlatform {
  fetched: ThreadId[] = [];
  constructor(private readonly byThread: Map<string, ThreadMessage[]>) {}
  async fetchThread(thread: ThreadId): Promise<ThreadMessage[]> {
    this.fetched.push(thread);
    return this.byThread.get(`${thread.channel}:${thread.threadTs}`) ?? [];
  }
}

describe("IdleSweeper.sweepOnce", () => {
  const NOW = tsToMs("1748600100.000000");

  it("stops idle threads, keeps fresh ones, and ignores foreign sandboxes", async () => {
    const handles: SandboxHandle[] = [
      { name: "t-C0ABCDEF-1748600000-000000" }, // idle (100s ago)
      { name: "t-C0FRESH-1748600099-000000" }, // fresh (1s ago)
      { name: "_login-tmp" }, // foreign — never touch
    ];
    const sandbox = new FakeSweepSandbox(handles);
    const platform = new FakeSweepPlatform(
      new Map([
        ["C0ABCDEF:1748600000.000000", [msg("1748600000.000000")]],
        ["C0FRESH:1748600099.000000", [msg("1748600099.000000")]],
      ]),
    );
    const sweeper = new IdleSweeper({ sandbox, platform, idleMs: 10_000, now: () => NOW });

    const { stopped } = await sweeper.sweepOnce();
    expect(stopped).toEqual(["t-C0ABCDEF-1748600000-000000"]);
    expect(sandbox.stopped).toEqual(["t-C0ABCDEF-1748600000-000000"]);
  });

  it("reverses a hash-named sandbox via ~/.agent-state/thread", async () => {
    const hashName = "t-0123456789abcdef";
    const sandbox = new FakeSweepSandbox([{ name: hashName }]);
    sandbox.files.set("/home/agent/.agent-state/thread", "C0HASH 1748600000.000000\n");
    const platform = new FakeSweepPlatform(
      new Map([["C0HASH:1748600000.000000", [msg("1748600000.000000")]]]),
    );
    const sweeper = new IdleSweeper({ sandbox, platform, idleMs: 10_000, now: () => NOW });

    expect((await sweeper.sweepOnce()).stopped).toEqual([hashName]);
  });

  it("ignores hash-named sandboxes with missing or malformed reverse-map state", async () => {
    const malformed = "t-0123456789abcdef";
    const missing = "t-fedcba9876543210";
    const sandbox = new FakeSweepSandbox([{ name: malformed }, { name: missing }]);
    sandbox.files.set(`${malformed}:/home/agent/.agent-state/thread`, "malformed");
    const platform = new FakeSweepPlatform(new Map());
    const sweeper = new IdleSweeper({ sandbox, platform, idleMs: 10_000, now: () => NOW });

    expect((await sweeper.sweepOnce()).stopped).toEqual([]);
    expect(platform.fetched).toEqual([]);
  });

  it("continues sweeping when one idle sandbox fails to stop", async () => {
    const handles: SandboxHandle[] = [
      { name: "t-C0A-1748600000-000000" },
      { name: "t-C0B-1748600000-000000" },
    ];
    const sandbox = new FakeSweepSandbox(handles);
    sandbox.failStops.add("t-C0A-1748600000-000000");
    const platform = new FakeSweepPlatform(
      new Map([
        ["C0A:1748600000.000000", [msg("1748600000.000000")]],
        ["C0B:1748600000.000000", [msg("1748600000.000000")]],
      ]),
    );
    const sweeper = new IdleSweeper({ sandbox, platform, idleMs: 10_000, now: () => NOW });

    expect((await sweeper.sweepOnce()).stopped).toEqual(["t-C0B-1748600000-000000"]);
    expect(sandbox.stopped).toEqual(["t-C0B-1748600000-000000"]);
  });
});
