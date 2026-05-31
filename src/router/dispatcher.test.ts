import type { CodingBackend, TurnResult } from "../backend/index.js";
import type { ExecCallOptions, ExecResult, SandboxHandle } from "../sandbox/index.js";
import type { Mention, ThreadId, ThreadMessage } from "../types.js";
import { serializeTranscript } from "./agent-state.js";
import { Dispatcher, formatPrompt } from "./dispatcher.js";
import { createRecordingSink } from "./log.js";

const msg = (ts: string, user: string, text: string): ThreadMessage => ({ ts, user, text });
const trigger: Mention = {
  thread: { channel: "C0ABCDEF", threadTs: "1748600000.100000" },
  ts: "1748600000.500000",
  user: "U1",
  text: "@bot fix the bug",
};
const SANDBOX = "t-C0ABCDEF-1748600000.100000";
const HOME = "/home/agent";

class FakePlatform {
  replies: string[] = [];
  constructor(
    private readonly trace: string[],
    private readonly whole: ThreadMessage[],
    private readonly delta: ThreadMessage[] = [],
  ) {}
  async fetchThread(_thread: ThreadId, sinceTs?: string): Promise<ThreadMessage[]> {
    this.trace.push(`fetch:${sinceTs ?? "all"}`);
    return sinceTs === undefined ? this.whole : this.delta;
  }
  async postReply(_thread: ThreadId, text: string): Promise<void> {
    this.trace.push("reply");
    this.replies.push(text);
  }
  async addReaction(_c: string, _ts: string, emoji: string): Promise<void> {
    this.trace.push(`+${emoji}`);
  }
  async removeReaction(_c: string, _ts: string, emoji: string): Promise<void> {
    this.trace.push(`-${emoji}`);
  }
  async uploadFile(): Promise<void> {}
}

class FakeSandbox {
  readonly files = new Map<string, string>();
  readonly existing: SandboxHandle[];
  execArgs: string[][] = [];
  constructor(
    private readonly trace: string[],
    private readonly execResult: ExecResult,
    existing: string[] = [],
  ) {
    this.existing = existing.map((name) => ({ name }));
  }
  async list(): Promise<SandboxHandle[]> {
    return this.existing;
  }
  async create(name: string, _repoRef: string): Promise<SandboxHandle> {
    this.trace.push(`create:${name}`);
    this.existing.push({ name });
    return { name };
  }
  async exec(_h: SandboxHandle, argv: string[], opts?: ExecCallOptions): Promise<ExecResult> {
    this.trace.push("exec");
    this.execArgs.push(argv);
    opts?.onChunk?.("stdout", this.execResult.stdout);
    opts?.onChunk?.("stderr", this.execResult.stderr);
    return this.execResult;
  }
  async execShell(_h: SandboxHandle, command: string): Promise<ExecResult> {
    this.trace.push(`shell:${command.split(" ")[0]}`);
    return { stdout: "", stderr: "", exitCode: 0 };
  }
  async homeDir(): Promise<string> {
    return HOME;
  }
  async readFile(_h: SandboxHandle, absPath: string): Promise<string | null> {
    return this.files.get(absPath) ?? null;
  }
  async writeFile(_h: SandboxHandle, absPath: string, content: string): Promise<void> {
    this.trace.push(`write:${absPath.split("/").pop()}`);
    this.files.set(absPath, content);
  }
  async getFile(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async putFile(): Promise<void> {}
  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}
}

class FakeBackend implements CodingBackend {
  turnArgsCalls: (string | undefined)[] = [];
  constructor(
    private readonly trace: string[],
    private readonly result: TurnResult,
    private readonly streamId: string | null = "sess-new",
  ) {}
  configHome(): string {
    return "~/.codex";
  }
  turnArgs(message: string, sessionId?: string): string[] {
    this.turnArgsCalls.push(sessionId);
    return ["codex", "exec", ...(sessionId ? ["resume", sessionId] : []), message];
  }
  parseResult(): TurnResult {
    return this.result;
  }
  parseSessionId(): string | null {
    return this.streamId;
  }
  async captureSessionId(): Promise<string> {
    this.trace.push("captureSessionId");
    return "captured-id";
  }
  events(): unknown[] {
    return [];
  }
}

interface Built {
  dispatcher: Dispatcher;
  trace: string[];
  platform: FakePlatform;
  sandbox: FakeSandbox;
  backend: FakeBackend;
  sink: ReturnType<typeof createRecordingSink>;
}

function build(opts: {
  whole?: ThreadMessage[];
  delta?: ThreadMessage[];
  exec?: ExecResult;
  result?: TurnResult;
  existing?: string[];
  streamId?: string | null;
  seedFiles?: Record<string, string>;
  level?: "summary" | "verbose";
}): Built {
  const trace: string[] = [];
  const platform = new FakePlatform(
    trace,
    opts.whole ?? [msg("1748600000.100000", "U1", "start"), msg("1748600000.500000", "U1", "fix")],
    opts.delta ?? [],
  );
  const sandbox = new FakeSandbox(
    trace,
    opts.exec ?? { stdout: '{"type":"item.completed"}', stderr: "", exitCode: 0 },
    opts.existing ?? [],
  );
  for (const [path, content] of Object.entries(opts.seedFiles ?? {})) {
    sandbox.files.set(path, content);
  }
  const backend = new FakeBackend(
    trace,
    opts.result ?? { finalText: "Fixed it.", ok: true },
    opts.streamId === undefined ? "sess-new" : opts.streamId,
  );
  const sink = createRecordingSink();
  const dispatcher = new Dispatcher({
    platform,
    sandbox,
    backend,
    repoRef: "/repo",
    logSink: sink,
    level: opts.level ?? "summary",
    now: () => 1_700_000_000_000,
    newTurnId: () => "turn-test",
  });
  return { dispatcher, trace, platform, sandbox, backend, sink };
}

describe("formatPrompt", () => {
  it("renders messages plainly, no editorializing (router is plumbing)", () => {
    expect(formatPrompt([msg("1", "U1", "a"), msg("2", "U2", "b")])).toBe("U1: a\n\nU2: b");
  });
});

describe("dispatchTurn — turn 1 happy path", () => {
  it("creates the sandbox, primes, execs, persists, relays, and ✅s — in order", async () => {
    const b = build({});
    const out = await b.dispatcher.dispatchTurn(trigger);

    expect(out).toEqual({ ok: true });
    expect(b.platform.replies).toEqual(["Fixed it."]);
    expect(b.backend.turnArgsCalls).toEqual([undefined]); // fresh turn

    const t = b.trace;
    const at = (label: string) => t.indexOf(label);
    expect(at(`create:${SANDBOX}`)).toBeGreaterThanOrEqual(0);
    expect(at("fetch:all")).toBeGreaterThan(at(`create:${SANDBOX}`)); // whole-thread primer
    expect(at("exec")).toBeGreaterThan(at("fetch:all"));
    // session persisted BEFORE the reply; transcript appended AFTER it (§4.6)
    expect(at("write:session")).toBeGreaterThan(at("exec"));
    expect(at("write:session")).toBeLessThan(at("reply"));
    expect(at("write:transcript.jsonl")).toBeGreaterThan(at("reply"));
    // 👀 -> ✅ swap is last
    expect(t.slice(-2)).toEqual(["-eyes", "+white_check_mark"]);
  });

  it("reuses an existing sandbox instead of creating one", async () => {
    const b = build({ existing: [SANDBOX] });
    await b.dispatcher.dispatchTurn(trigger);
    expect(b.trace).not.toContain(`create:${SANDBOX}`);
    expect(b.trace).toContain("exec");
  });

  it("falls back to captureSessionId when the stream has no id", async () => {
    const b = build({ streamId: null });
    await b.dispatcher.dispatchTurn(trigger);
    expect(b.trace).toContain("captureSessionId");
    expect(b.sandbox.files.get(`${HOME}/.agent-state/session`)).toBe("captured-id\n");
  });

  it("emits boundary logs: sandbox.create, turn.in, turn.exit, result.relayed", async () => {
    const b = build({});
    await b.dispatcher.dispatchTurn(trigger);
    const kinds = b.sink.records.map((r) => r.kind);
    expect(kinds).toContain("sandbox.create");
    expect(kinds).toContain("turn.in");
    expect(kinds).toContain("turn.exit");
    expect(kinds).toContain("result.relayed");
    const turnIn = b.sink.records.find((r) => r.kind === "turn.in");
    expect(turnIn?.sessionId).toBeNull();
    expect(turnIn?.resume).toBe(false);
  });
});

describe("dispatchTurn — follow-up (resume)", () => {
  it("resumes the session and feeds only the delta after the hwm", async () => {
    const seeded = serializeTranscript([
      msg("1748600000.100000", "U1", "start"),
      msg("1748600000.500000", "U1", "fix"),
    ]);
    const b = build({
      existing: [SANDBOX],
      seedFiles: {
        [`${HOME}/.agent-state/session`]: "sess-1\n",
        [`${HOME}/.agent-state/transcript.jsonl`]: seeded,
      },
      delta: [msg("1748600000.700000", "U2", "also add a test")],
    });
    const out = await b.dispatcher.dispatchTurn(trigger);

    expect(out).toEqual({ ok: true });
    expect(b.backend.turnArgsCalls).toEqual(["sess-1"]); // resume
    expect(b.trace).toContain("fetch:1748600000.500000"); // sinceTs = hwm
    expect(b.trace).not.toContain("write:session"); // not turn 1
    expect(b.trace).toContain("write:transcript.jsonl"); // delta appended
  });
});

describe("dispatchTurn — failure & skip", () => {
  it("on !ok: posts the failure message, ❌s, and does NOT persist (re-feed)", async () => {
    const b = build({ result: { finalText: "", ok: false } });
    const out = await b.dispatcher.dispatchTurn(trigger);

    expect(out).toEqual({ ok: false });
    expect(b.platform.replies[0]).toMatch(/didn't return a result/);
    expect(b.trace).not.toContain("write:session");
    expect(b.trace).not.toContain("write:transcript.jsonl");
    expect(b.trace.slice(-2)).toEqual(["-eyes", "+x"]);
    expect(b.sink.records.map((r) => r.kind)).toContain("turn.abandoned");
  });

  it("on empty delta: skips exec entirely and ✅s", async () => {
    const b = build({
      existing: [SANDBOX],
      seedFiles: {
        [`${HOME}/.agent-state/session`]: "sess-1\n",
        // a transcript sets the hwm so the follow-up fetch uses sinceTs (-> empty delta)
        [`${HOME}/.agent-state/transcript.jsonl`]: serializeTranscript([
          msg("1748600000.500000", "U1", "fix"),
        ]),
      },
      delta: [], // nothing new since the hwm
    });
    const out = await b.dispatcher.dispatchTurn(trigger);
    expect(out).toEqual({ ok: true });
    expect(b.trace).not.toContain("exec");
    expect(b.trace.slice(-2)).toEqual(["-eyes", "+white_check_mark"]);
  });

  it("never rejects, even when a seam throws (turn abandoned, ❌)", async () => {
    const b = build({});
    b.sandbox.list = async () => {
      throw new Error("daemon down");
    };
    const out = await b.dispatcher.dispatchTurn(trigger);
    expect(out).toEqual({ ok: false });
    expect(b.sink.records.map((r) => r.kind)).toContain("turn.abandoned");
  });
});

describe("dispatchTurn — verbose logging", () => {
  it("streams raw out chunks only at verbose level", async () => {
    const verbose = build({
      level: "verbose",
      exec: { stdout: "raw-bytes", stderr: "", exitCode: 0 },
    });
    await verbose.dispatcher.dispatchTurn(trigger);
    expect(verbose.sink.records.some((r) => r.kind === "turn.out.chunk")).toBe(true);

    const summary = build({});
    await summary.dispatcher.dispatchTurn(trigger);
    expect(summary.sink.records.some((r) => r.kind === "turn.out.chunk")).toBe(false);
  });
});
