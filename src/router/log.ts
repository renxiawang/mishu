import { createHash } from "node:crypto";

/**
 * Boundary logging (spec §4.9).
 *
 * The router logs both edges of every turn at the agent boundary, treating the
 * agent's output as opaque bytes — format-agnostic, so it survives Codex schema
 * changes and catches the agent misbehaving (e.g. silent empty output, §9.14).
 *
 * - `direction: "in"`  — router -> agent (argv, target session, prompt)
 * - `direction: "out"` — agent -> router (raw stdout/stderr chunks; exit summary)
 * - `direction: "router"` — the router's own lifecycle actions
 *
 * Two levels: always-on **summaries** (cap/hash large prompts and output) and a
 * **verbose** toggle for full raw bytes. Logs are a sink, never read back for
 * correctness, and writes are best-effort — they must never stall or fail a turn.
 * Credentials are proxy-side and never enter argv/prompt, so they are never
 * logged (§4.7).
 */

export type Direction = "in" | "out" | "router";
export type LogLevel = "summary" | "verbose";

/** Stable per-turn/per-thread correlation fields carried by every record. */
export interface LogContext {
  threadId: string;
  channel: string;
  thread_ts: string;
  sandbox: string;
  turnId: string;
}

interface EnvelopeBase extends LogContext {
  ts: string;
  direction: Direction;
  kind: string;
}

/** Common envelope + kind-specific payload spread at the top level (§4.9). */
export type LogEnvelope = EnvelopeBase & Record<string, unknown>;

/** Router-direction record kinds — the gaps raw agent I/O can't explain (§4.9). */
export const RouterKind = {
  MentionReceived: "mention.received",
  MentionDeduped: "mention.deduped",
  AckReaction: "ack.reaction",
  QueuedPending: "queued.pending",
  SandboxCreate: "sandbox.create",
  SandboxStart: "sandbox.start",
  SandboxStop: "sandbox.stop",
  TurnAbandoned: "turn.abandoned",
  ResultRelayed: "result.relayed",
  FileUploaded: "file.uploaded",
  Error: "error",
} as const;

const SUMMARY_HEAD_CHARS = 200;
const SUMMARY_SNIPPET_CHARS = 500;

// ---------------------------------------------------------------------------
// Pure safeguards
// ---------------------------------------------------------------------------

/** Truncate long strings for summaries, noting how much was dropped. */
export function capForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}…(+${text.length - maxChars} chars)`;
}

export function hashString(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Size + hash + head of a (possibly huge) prompt — never the whole thing. */
export function summarizePrompt(prompt: string): {
  bytes: number;
  sha256: string;
  head: string;
} {
  return {
    bytes: Buffer.byteLength(prompt, "utf8"),
    sha256: hashString(prompt),
    head: capForSummary(prompt, SUMMARY_HEAD_CHARS),
  };
}

/** Cap each argv element so a giant prompt-arg can't flood a summary record. */
export function capArgv(argv: string[], maxChars: number = SUMMARY_HEAD_CHARS): string[] {
  return argv.map((arg) => capForSummary(arg, maxChars));
}

// ---------------------------------------------------------------------------
// Pure record builders
// ---------------------------------------------------------------------------

function base(ctx: LogContext, ts: string, direction: Direction, kind: string): EnvelopeBase {
  return {
    ts,
    threadId: ctx.threadId,
    channel: ctx.channel,
    thread_ts: ctx.thread_ts,
    sandbox: ctx.sandbox,
    turnId: ctx.turnId,
    direction,
    kind,
  };
}

export interface TurnInInput {
  /** Target session id: null => fresh turn, else resume (§4.5). */
  sessionId: string | null;
  argv: string[];
  cwd: string;
  prompt: string;
  level: LogLevel;
}

export function buildTurnIn(ctx: LogContext, ts: string, input: TurnInInput): LogEnvelope {
  const { sessionId, argv, cwd, prompt, level } = input;
  if (level === "verbose") {
    return {
      ...base(ctx, ts, "in", "turn.in"),
      resume: sessionId !== null,
      sessionId,
      argv,
      cwd,
      prompt,
    };
  }
  return {
    ...base(ctx, ts, "in", "turn.in"),
    resume: sessionId !== null,
    sessionId,
    argv: capArgv(argv),
    cwd,
    prompt: summarizePrompt(prompt),
  };
}

export function buildOutChunk(
  ctx: LogContext,
  ts: string,
  input: { stream: "stdout" | "stderr"; chunk: string },
): LogEnvelope {
  return { ...base(ctx, ts, "out", "turn.out.chunk"), stream: input.stream, chunk: input.chunk };
}

export interface TurnExitInput {
  exitCode: number;
  durationMs: number;
  finalSnippet: string;
  ok: boolean;
}

export function buildTurnExit(ctx: LogContext, ts: string, input: TurnExitInput): LogEnvelope {
  return {
    ...base(ctx, ts, "out", "turn.exit"),
    exitCode: input.exitCode,
    durationMs: input.durationMs,
    finalSnippet: capForSummary(input.finalSnippet, SUMMARY_SNIPPET_CHARS),
    ok: input.ok,
  };
}

export function buildRouterEvent(
  ctx: LogContext,
  ts: string,
  kind: string,
  payload: Record<string, unknown> = {},
): LogEnvelope {
  return { ...base(ctx, ts, "router", kind), ...payload };
}

// ---------------------------------------------------------------------------
// Sinks (best-effort, never throwing)
// ---------------------------------------------------------------------------

export interface LogSink {
  write(env: LogEnvelope): void;
}

/** Discards everything (default when logging is off / in tests). */
export const nullSink: LogSink = { write() {} };

/** In-memory sink for tests. */
export function createRecordingSink(): LogSink & { records: LogEnvelope[] } {
  const records: LogEnvelope[] = [];
  return {
    records,
    write(env) {
      records.push(env);
    },
  };
}

/**
 * Serialize each record to a JSONL line and hand it to `writeLine` (which does
 * the actual stdout/file I/O, injected by the composition root). Swallows all
 * errors — a full disk or slow shipper must never stall a turn (§4.9).
 */
export function createJsonlSink(writeLine: (line: string) => void): LogSink {
  return {
    write(env) {
      try {
        writeLine(`${JSON.stringify(env)}\n`);
      } catch {
        // best-effort: logging is never allowed to fail a turn
      }
    },
  };
}

/** Write to a sink without ever letting a misbehaving sink throw into a turn. */
export function safeWrite(sink: LogSink, env: LogEnvelope): void {
  try {
    sink.write(env);
  } catch {
    // best-effort
  }
}
