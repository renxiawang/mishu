import { randomUUID } from "node:crypto";
import type { CodingBackend } from "../backend/index.js";
import type { PlatformAdapter } from "../platform/index.js";
import type { SandboxHandle, SandboxProvider } from "../sandbox/index.js";
import type { Mention, ThreadId, ThreadMessage } from "../types.js";
import { computeDelta, highWaterMark } from "./agent-state.js";
import { AgentStateStore, type SandboxFsLike } from "./agent-state-store.js";
import {
  buildOutChunk,
  buildRouterEvent,
  buildTurnExit,
  buildTurnIn,
  type LogContext,
  type LogLevel,
  type LogSink,
  nullSink,
  RouterKind,
  safeWrite,
} from "./log.js";
import { chooseSandboxName } from "./sandbox-name.js";

/**
 * The one-turn lifecycle (spec §4.1/§4.5/§4.9) — the keystone that ties the
 * three seams together for a single turn. Order matters:
 *
 *   resolve-or-create sandbox (deterministic name) → turn-1-vs-resume (session
 *   file, §4.5) → fetch primer/delta (§4.2) → exec (reader drains stdout+stderr,
 *   stays attached, logs at the boundary §4.9) → parseResult → write-after-success
 *   (persist session BEFORE posting, append transcript AFTER the reply, §4.6) →
 *   relay → swap 👀→✅/❌.
 *
 * Reactions: the router adds 👀 on every mention; the dispatcher swaps the
 * trigger's 👀 to ✅/❌ on completion. dispatchTurn never rejects — it resolves
 * with {ok} so the router's coalescing always advances.
 */

export interface DispatcherDeps {
  platform: Pick<PlatformAdapter, "fetchThread" | "postReply" | "addReaction" | "removeReaction">;
  /** Provider (create/exec/list) + file helpers for the agent-state store. */
  sandbox: SandboxProvider & SandboxFsLike;
  backend: CodingBackend;
  repoRef: string;
  logSink?: LogSink;
  /** The bot's own Slack user id; its posts never re-enter the delta (§4.2). */
  botUser?: string;
  level?: LogLevel;
  failureMessage?: string;
  /** Optional in-VM bootstrap run once after create (branch off base, §4.3; confirm live). */
  provisionScript?: string;
  now?: () => number;
  newTurnId?: () => string;
}

const DEFAULT_FAILURE =
  "⚠️ The coding agent didn't return a result for that turn. Your request is still queued — mention me again to retry.";

/** Render messages into a single prompt. Plumbing, not authorship — no editorializing. */
export function formatPrompt(messages: ThreadMessage[]): string {
  return messages.map((m) => `${m.user}: ${m.text}`).join("\n\n");
}

export class Dispatcher {
  private readonly platform: DispatcherDeps["platform"];
  private readonly sandbox: SandboxProvider & SandboxFsLike;
  private readonly backend: CodingBackend;
  private readonly repoRef: string;
  private readonly logSink: LogSink;
  private readonly botUser: string | undefined;
  private readonly level: LogLevel;
  private readonly failureMessage: string;
  private readonly provisionScript: string | undefined;
  private readonly now: () => number;
  private readonly newTurnId: () => string;

  constructor(deps: DispatcherDeps) {
    this.platform = deps.platform;
    this.sandbox = deps.sandbox;
    this.backend = deps.backend;
    this.repoRef = deps.repoRef;
    this.logSink = deps.logSink ?? nullSink;
    this.botUser = deps.botUser;
    this.level = deps.level ?? "summary";
    this.failureMessage = deps.failureMessage ?? DEFAULT_FAILURE;
    this.provisionScript = deps.provisionScript;
    this.now = deps.now ?? Date.now;
    this.newTurnId = deps.newTurnId ?? (() => randomUUID());
  }

  async dispatchTurn(trigger: Mention): Promise<{ ok: boolean }> {
    const thread = trigger.thread;
    const name = chooseSandboxName(thread);
    const ctx: LogContext = {
      threadId: name,
      channel: thread.channel,
      thread_ts: thread.threadTs,
      sandbox: name,
      turnId: this.newTurnId(),
    };
    try {
      const handle = await this.resolveSandbox(thread, name, ctx);
      const store = new AgentStateStore(this.sandbox, handle);

      // Turn-1 vs resume is the session file's presence (§4.5).
      const sessionId = await store.readSessionId();
      const delta = await this.assembleDelta(thread, store, sessionId);
      if (delta.length === 0) {
        this.router(ctx, "turn.skipped", { reason: "empty delta" });
        await this.swapReaction(trigger, true);
        return { ok: true };
      }

      const prompt = formatPrompt(delta);
      const argv = this.backend.turnArgs(prompt, sessionId ?? undefined);
      this.write(
        buildTurnIn(ctx, this.ts(), {
          sessionId,
          argv,
          cwd: this.repoRef,
          prompt,
          level: this.level,
        }),
      );

      const start = this.now();
      const { stdout, stderr, exitCode } = await this.sandbox.exec(handle, argv, {
        onChunk: (stream, chunk) => {
          if (this.level === "verbose") {
            this.write(buildOutChunk(ctx, this.ts(), { stream, chunk }));
          }
        },
      });
      const result = this.backend.parseResult(stdout);
      this.write(
        buildTurnExit(ctx, this.ts(), {
          exitCode,
          durationMs: this.now() - start,
          finalSnippet: result.finalText,
          ok: result.ok,
        }),
      );

      if (!result.ok) {
        this.router(ctx, RouterKind.TurnAbandoned, {
          reason: "agent returned no result",
          exitCode,
          stderrSnippet: stderr.slice(0, 500),
        });
        // Relay the agent's own error (e.g. a usage limit) when it gave one,
        // else a generic message. Either way the transcript is NOT appended, so
        // the request re-feeds on the next mention (§4.6).
        const reply = result.finalText.trim() !== "" ? result.finalText : this.failureMessage;
        await this.relay(thread, reply);
        await this.swapReaction(trigger, false);
        return { ok: false };
      }

      // Write-after-success (§4.6): persist the session id BEFORE posting (so a
      // crash still resumes), append the transcript AFTER the reply (so a failed
      // post re-feeds — at-least-once).
      if (sessionId === null) {
        const id =
          this.backend.parseSessionId?.(stdout) ?? (await this.backend.captureSessionId(handle));
        await store.writeSessionId(id);
      }
      await this.relay(thread, result.finalText);
      await store.appendDelta(delta);
      await this.swapReaction(trigger, true);
      this.router(ctx, RouterKind.ResultRelayed, { ok: true, chars: result.finalText.length });
      return { ok: true };
    } catch (err) {
      this.router(ctx, RouterKind.TurnAbandoned, { error: errorMessage(err) });
      await this.swapReaction(trigger, false);
      return { ok: false };
    }
  }

  /** Find the thread's sandbox by deterministic name, or create + seed it (§4.1/§4.3). */
  private async resolveSandbox(
    thread: ThreadId,
    name: string,
    ctx: LogContext,
  ): Promise<SandboxHandle> {
    const existing = (await this.sandbox.list()).find((h) => h.name === name);
    if (existing !== undefined) {
      return existing;
    }
    this.router(ctx, RouterKind.SandboxCreate, { name });
    const handle = await this.sandbox.create(name, this.repoRef);
    // Reverse-map the full id so a hash-named sandbox is reversible (§4.1/§4.6).
    await new AgentStateStore(this.sandbox, handle).writeThread(
      `${thread.channel} ${thread.threadTs}`,
    );
    if (this.provisionScript !== undefined) {
      await this.sandbox.execShell(handle, this.provisionScript);
    }
    return handle;
  }

  /** Turn 1 (no session): whole-thread primer. Follow-up: messages after the hwm. */
  private async assembleDelta(
    thread: ThreadId,
    store: AgentStateStore,
    sessionId: string | null,
  ): Promise<ThreadMessage[]> {
    if (sessionId === null) {
      const fetched = await this.platform.fetchThread(thread);
      return computeDelta(fetched, null, { botUser: this.botUser });
    }
    const hwm = highWaterMark(await store.readTranscript());
    const fetched = await this.platform.fetchThread(thread, hwm ?? undefined);
    return computeDelta(fetched, hwm, { botUser: this.botUser });
  }

  private async relay(thread: ThreadId, text: string): Promise<void> {
    await this.platform.postReply(thread, text);
  }

  /** Best-effort 👀→✅/❌ swap on the trigger (reactions never fail a turn, §4.1). */
  private async swapReaction(trigger: Mention, ok: boolean): Promise<void> {
    try {
      await this.platform.removeReaction(trigger.thread.channel, trigger.ts, "eyes");
      await this.platform.addReaction(
        trigger.thread.channel,
        trigger.ts,
        ok ? "white_check_mark" : "x",
      );
    } catch {
      // best-effort
    }
  }

  private ts(): string {
    return new Date(this.now()).toISOString();
  }

  private write(env: ReturnType<typeof buildTurnIn>): void {
    safeWrite(this.logSink, env);
  }

  private router(ctx: LogContext, kind: string, payload: Record<string, unknown>): void {
    safeWrite(this.logSink, buildRouterEvent(ctx, this.ts(), kind, payload));
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
