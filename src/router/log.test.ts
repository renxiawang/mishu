import {
  buildOutChunk,
  buildRouterEvent,
  buildTurnExit,
  buildTurnIn,
  capArgv,
  capForSummary,
  createJsonlSink,
  createRecordingSink,
  hashString,
  type LogContext,
  type LogSink,
  RouterKind,
  safeWrite,
  summarizePrompt,
} from "./log.js";

const ctx: LogContext = {
  threadId: "t-C0ABCDEF-1748600000.123456",
  channel: "C0ABCDEF",
  thread_ts: "1748600000.123456",
  sandbox: "t-C0ABCDEF-1748600000.123456",
  turnId: "turn-1",
};
const TS = "2026-05-31T00:00:00.000Z";

describe("envelope shape & correlation fields", () => {
  it("every builder carries the common envelope", () => {
    const env = buildRouterEvent(ctx, TS, RouterKind.MentionReceived, { user: "U1" });
    expect(env).toMatchObject({
      ts: TS,
      threadId: ctx.threadId,
      channel: ctx.channel,
      thread_ts: ctx.thread_ts,
      sandbox: ctx.sandbox,
      turnId: ctx.turnId,
      direction: "router",
      kind: "mention.received",
      user: "U1",
    });
  });

  it("assigns the right direction per builder", () => {
    expect(
      buildTurnIn(ctx, TS, {
        sessionId: null,
        argv: ["codex"],
        cwd: "/w",
        prompt: "p",
        level: "summary",
      }).direction,
    ).toBe("in");
    expect(buildOutChunk(ctx, TS, { stream: "stdout", chunk: "x" }).direction).toBe("out");
    expect(
      buildTurnExit(ctx, TS, { exitCode: 0, durationMs: 5, finalSnippet: "done", ok: true })
        .direction,
    ).toBe("out");
    expect(buildRouterEvent(ctx, TS, RouterKind.AckReaction).direction).toBe("router");
  });
});

describe("buildTurnIn — summary vs verbose", () => {
  const longPrompt = "x".repeat(1000);

  it("summary caps argv and hashes/sizes the prompt (no full prompt)", () => {
    const env = buildTurnIn(ctx, TS, {
      sessionId: null,
      argv: ["codex", "exec", longPrompt],
      cwd: "/w",
      prompt: longPrompt,
      level: "summary",
    });
    expect(env.kind).toBe("turn.in");
    expect(env.resume).toBe(false);
    expect(env.sessionId).toBeNull();
    // prompt is summarized, not embedded whole
    expect(env.prompt).toEqual({
      bytes: 1000,
      sha256: hashString(longPrompt),
      head: capForSummary(longPrompt, 200),
    });
    // the giant prompt-arg in argv is capped too
    const argv = env.argv as string[];
    expect(argv[2]?.length).toBeLessThan(longPrompt.length);
  });

  it("verbose embeds the full prompt and full argv", () => {
    const env = buildTurnIn(ctx, TS, {
      sessionId: "sess-123",
      argv: ["codex", "exec", "resume", "sess-123", longPrompt],
      cwd: "/w",
      prompt: longPrompt,
      level: "verbose",
    });
    expect(env.resume).toBe(true);
    expect(env.sessionId).toBe("sess-123");
    expect(env.prompt).toBe(longPrompt);
    expect((env.argv as string[])[4]).toBe(longPrompt);
  });
});

describe("buildTurnExit / buildOutChunk", () => {
  it("turn.exit carries exit/duration/ok and caps the snippet", () => {
    const env = buildTurnExit(ctx, TS, {
      exitCode: 1,
      durationMs: 1234,
      finalSnippet: "y".repeat(2000),
      ok: false,
    });
    expect(env).toMatchObject({ kind: "turn.exit", exitCode: 1, durationMs: 1234, ok: false });
    expect((env.finalSnippet as string).length).toBeLessThan(2000);
  });

  it("turn.out.chunk carries the raw stream + bytes", () => {
    const env = buildOutChunk(ctx, TS, { stream: "stderr", chunk: "boom" });
    expect(env).toMatchObject({ kind: "turn.out.chunk", stream: "stderr", chunk: "boom" });
  });
});

describe("safeguards", () => {
  it("capForSummary truncates only when over the limit", () => {
    expect(capForSummary("short", 10)).toBe("short");
    expect(capForSummary("abcdefghij", 3)).toBe("abc…(+7 chars)");
  });

  it("hashString is deterministic 64-hex", () => {
    expect(hashString("a")).toBe(hashString("a"));
    expect(hashString("a")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("summarizePrompt counts utf8 bytes (not chars)", () => {
    expect(summarizePrompt("é").bytes).toBe(2); // 2 utf-8 bytes
  });

  it("capArgv shortens long elements", () => {
    expect(capArgv(["short", "z".repeat(500)], 10)[1]).toContain("…");
  });
});

describe("sinks — best-effort, never throwing", () => {
  it("recording sink collects records", () => {
    const sink = createRecordingSink();
    sink.write(buildRouterEvent(ctx, TS, RouterKind.AckReaction));
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]?.kind).toBe("ack.reaction");
  });

  it("jsonl sink serializes one line per record", () => {
    const lines: string[] = [];
    const sink = createJsonlSink((line) => lines.push(line));
    sink.write(buildRouterEvent(ctx, TS, RouterKind.SandboxStop, { reason: "idle" }));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith("\n")).toBe(true);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ kind: "sandbox.stop", reason: "idle" });
  });

  it("jsonl sink swallows a throwing writer (logging never fails a turn)", () => {
    const sink = createJsonlSink(() => {
      throw new Error("disk full");
    });
    expect(() => sink.write(buildRouterEvent(ctx, TS, RouterKind.Error))).not.toThrow();
  });

  it("safeWrite swallows a throwing sink", () => {
    const bad: LogSink = {
      write() {
        throw new Error("boom");
      },
    };
    expect(() => safeWrite(bad, buildRouterEvent(ctx, TS, RouterKind.Error))).not.toThrow();
  });
});
