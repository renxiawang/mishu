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

export interface DispatcherDeps {
  platform: Pick<PlatformAdapter, "fetchThread" | "postReply" | "addReaction" | "removeReaction">;
  sandbox: SandboxProvider & SandboxFsLike;
  backend: CodingBackend;
  repoRef: string;
  logSink?: LogSink;
  botUser?: string;
  level?: LogLevel;
  failureMessage?: string;
  /** Optional setup run once after sandbox creation. */
  provisionScript?: string;
  now?: () => number;
  newTurnId?: () => string;
}

const DEFAULT_FAILURE = "The coding agent did not finish that turn. Mention me again to retry.";

const SBX_CLONE_SOURCE = "/run/sandbox/source";
const IN_VM_REPO_DIR = "repo";
const WORK_BRANCH = "slack/work";
const BARE_SHELL_WORD = /^[A-Za-z0-9_/.:=@%+,-]+$/;

function shellQuote(value: string): string {
  if (value === "") {
    return "''";
  }
  if (BARE_SHELL_WORD.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Render thread messages into the prompt passed to the coding agent. */
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
    let replyPosted = false;
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

      const sessionId = await store.readSessionId();
      const delta = await this.assembleDelta(thread, store, sessionId);
      if (delta.length === 0) {
        this.router(ctx, "turn.skipped", { reason: "empty delta" });
        await this.swapReaction(trigger, true);
        return { ok: true };
      }

      const prompt = formatPrompt(delta);
      const argv = this.backend.turnArgs(prompt, sessionId ?? undefined);

      const home = await this.sandbox.homeDir(handle);
      const repoPath = `${home}/${IN_VM_REPO_DIR}`;
      await this.provisionRepo(handle, repoPath, ctx);

      this.write(
        buildTurnIn(ctx, this.ts(), {
          sessionId,
          argv,
          cwd: repoPath,
          prompt,
          level: this.level,
        }),
      );

      const start = this.now();
      const { stdout, stderr, exitCode } = await this.sandbox.exec(handle, argv, {
        cwd: repoPath,
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
        const reply = result.finalText.trim() !== "" ? result.finalText : this.failureMessage;
        await this.relay(thread, reply);
        replyPosted = true;
        await this.swapReaction(trigger, false);
        return { ok: false };
      }

      if (sessionId === null) {
        const id =
          this.backend.parseSessionId?.(stdout) ?? (await this.backend.captureSessionId(handle));
        await store.writeSessionId(id);
      }
      await this.relay(thread, result.finalText);
      replyPosted = true;
      await store.appendDelta(delta);
      await this.swapReaction(trigger, true);
      this.router(ctx, RouterKind.ResultRelayed, { ok: true, chars: result.finalText.length });
      return { ok: true };
    } catch (err) {
      this.router(ctx, RouterKind.TurnAbandoned, { error: errorMessage(err) });
      if (!replyPosted) {
        await this.relayFailure(thread);
      }
      await this.swapReaction(trigger, false);
      return { ok: false };
    }
  }

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
    // Reverse-map the full id so a hash-named sandbox is reversible.
    await new AgentStateStore(this.sandbox, handle).writeThread(
      `${thread.channel} ${thread.threadTs}`,
    );
    if (this.provisionScript !== undefined) {
      await this.sandbox.execShell(handle, this.provisionScript);
    }
    return handle;
  }

  private async provisionRepo(
    handle: SandboxHandle,
    repoPath: string,
    ctx: LogContext,
  ): Promise<void> {
    const source = shellQuote(SBX_CLONE_SOURCE);
    const repo = shellQuote(repoPath);
    const fallbackOrigin = shellQuote(this.repoRef);
    const branch = shellQuote(WORK_BRANCH);
    const script = [
      `test -d ${repo}/.git || git clone -q ${source} ${repo}`,
      `origin="$(git -C ${source} remote get-url origin 2>/dev/null || printf %s ${fallbackOrigin})"`,
      `{ git -C ${repo} remote get-url origin >/dev/null 2>&1 && git -C ${repo} remote set-url origin "$origin" || git -C ${repo} remote add origin "$origin"; }`,
      `git -C ${repo} checkout -q -B ${branch}`,
    ].join(" && ");
    const result = await this.sandbox.execShell(handle, script);
    if (result.exitCode !== 0) {
      this.router(ctx, "provision.failed", { stderrSnippet: result.stderr.slice(0, 300) });
      throw new Error(`repo provisioning failed: ${result.stderr.trim() || "unknown error"}`);
    }
  }

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

  private async relayFailure(thread: ThreadId): Promise<void> {
    try {
      await this.relay(thread, this.failureMessage);
    } catch {
      // The reaction still gives the user a failure signal if posting is unavailable.
    }
  }

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
