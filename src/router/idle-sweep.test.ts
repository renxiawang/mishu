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
  readonly files = new Map<string, string>();
  constructor(private readonly handles: SandboxHandle[]) {}
  async list(): Promise<SandboxHandle[]> {
    return this.handles;
  }
  async stop(handle: SandboxHandle): Promise<void> {
    this.stopped.push(handle.name);
  }
  async homeDir(): Promise<string> {
    return "/home/agent";
  }
  async readFile(_h: SandboxHandle, absPath: string): Promise<string | null> {
    return this.files.get(absPath) ?? null;
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
  constructor(private readonly byThread: Map<string, ThreadMessage[]>) {}
  async fetchThread(thread: ThreadId): Promise<ThreadMessage[]> {
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
});
