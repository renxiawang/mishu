import type { SandboxHandle } from "../sandbox/index.js";
import type { ThreadMessage } from "../types.js";
import { AgentStateStore, type SandboxFsLike } from "./agent-state-store.js";

const handle: SandboxHandle = { name: "t-C0ABCDEF-1748600000.123456" };
const msg = (ts: string, user: string, text: string): ThreadMessage => ({ ts, user, text });

class FakeSandboxFs implements SandboxFsLike {
  readonly files = new Map<string, string>();
  writes = 0;
  constructor(private readonly home = "/home/agent") {}
  async homeDir(): Promise<string> {
    return this.home;
  }
  async readFile(_h: SandboxHandle, absPath: string): Promise<string | null> {
    return this.files.get(absPath) ?? null;
  }
  async writeFile(_h: SandboxHandle, absPath: string, content: string): Promise<void> {
    this.writes += 1;
    this.files.set(absPath, content);
  }
}

describe("AgentStateStore — transcript", () => {
  it("reads an empty ledger as [] (turn-1 signal)", async () => {
    const store = new AgentStateStore(new FakeSandboxFs(), handle);
    expect(await store.readTranscript()).toEqual([]);
  });

  it("appends a delta and reads it back under $HOME/.agent-state", async () => {
    const fs = new FakeSandboxFs();
    const store = new AgentStateStore(fs, handle);
    const delta = [msg("1.1", "U1", "hello"), msg("1.2", "U2", "world")];
    await store.appendDelta(delta);
    expect(await store.readTranscript()).toEqual(delta);
    expect(fs.files.has("/home/agent/.agent-state/transcript.jsonl")).toBe(true);
  });

  it("appends incrementally, preserving prior lines (read-modify-write)", async () => {
    const store = new AgentStateStore(new FakeSandboxFs(), handle);
    await store.appendDelta([msg("1.1", "U1", "a")]);
    await store.appendDelta([msg("1.2", "U2", "b")]);
    expect(await store.readTranscript()).toEqual([msg("1.1", "U1", "a"), msg("1.2", "U2", "b")]);
  });

  it("does not write when the delta is empty (no spurious file)", async () => {
    const fs = new FakeSandboxFs();
    await new AgentStateStore(fs, handle).appendDelta([]);
    expect(fs.writes).toBe(0);
  });
});

describe("AgentStateStore — session id", () => {
  it("is null until written, then round-trips (trimmed)", async () => {
    const fs = new FakeSandboxFs();
    const store = new AgentStateStore(fs, handle);
    expect(await store.readSessionId()).toBeNull();
    await store.writeSessionId("7f3e9c21-4b6a-4c2d-9e1f-2a3b4c5d6e7f");
    expect(await store.readSessionId()).toBe("7f3e9c21-4b6a-4c2d-9e1f-2a3b4c5d6e7f");
    // stored with a trailing newline at the canonical path
    expect(fs.files.get("/home/agent/.agent-state/session")).toBe(
      "7f3e9c21-4b6a-4c2d-9e1f-2a3b4c5d6e7f\n",
    );
  });
});

describe("AgentStateStore — thread reverse map", () => {
  it("round-trips the original channel+thread_ts (hash-name fallback, §4.1)", async () => {
    const store = new AgentStateStore(new FakeSandboxFs(), handle);
    expect(await store.readThread()).toBeNull();
    await store.writeThread("C0ABCDEF 1748600000.123456");
    expect(await store.readThread()).toBe("C0ABCDEF 1748600000.123456");
  });
});

describe("AgentStateStore — home resolution", () => {
  it("uses the sandbox's reported $HOME for absolute paths", async () => {
    const fs = new FakeSandboxFs("/root");
    const store = new AgentStateStore(fs, handle);
    await store.writeSessionId("abc");
    expect(fs.files.has("/root/.agent-state/session")).toBe(true);
  });
});
