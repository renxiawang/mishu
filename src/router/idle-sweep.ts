import type { PlatformAdapter } from "../platform/index.js";
import type { SandboxHandle, SandboxProvider } from "../sandbox/index.js";
import type { ThreadId } from "../types.js";
import { highWaterMark } from "./agent-state.js";
import { AgentStateStore, type SandboxFsLike } from "./agent-state-store.js";
import {
  buildRouterEvent,
  type LogContext,
  type LogSink,
  nullSink,
  RouterKind,
  safeWrite,
} from "./log.js";
import { isHashName, parseSandboxName } from "./sandbox-name.js";

/**
 * Idle eviction without stored timestamps: periodically `sbx ls` the
 * running sandboxes, reverse each name back to its thread, read the last
 * message time from Slack, and `sbx stop` the idle ones. `stop` is lossless and
 * recoverable, so coarse timing is harmless; the router NEVER auto-`rm`s.
 *
 * One Slack call per running sandbox per sweep — fine at v0 scale.
 */

/** sbx's documented idle-eviction window. */
export const DEFAULT_IDLE_MS = 24 * 60 * 60 * 1000;

/** Slack ts ("secs.micros") → epoch ms. */
export function tsToMs(ts: string): number {
  return Number.parseFloat(ts) * 1000;
}

/** Parse a `~/.agent-state/thread` reverse-map line ("channel threadTs"). */
export function parseThreadRef(raw: string): ThreadId | null {
  const trimmed = raw.trim();
  const space = trimmed.indexOf(" ");
  if (space < 0) {
    return null;
  }
  const channel = trimmed.slice(0, space);
  const threadTs = trimmed.slice(space + 1).trim();
  return channel !== "" && threadTs !== "" ? { channel, threadTs } : null;
}

export interface SandboxActivity {
  name: string;
  /** Epoch ms of the thread's last message, or null if unknown (never evicted). */
  lastActivityMs: number | null;
}

/** Names whose last activity is at least `idleMs` ago. Unknown activity is kept. */
export function selectIdle(activities: SandboxActivity[], nowMs: number, idleMs: number): string[] {
  return activities
    .filter((a) => a.lastActivityMs !== null && nowMs - a.lastActivityMs >= idleMs)
    .map((a) => a.name);
}

export interface IdleSweeperDeps {
  sandbox: SandboxProvider & SandboxFsLike;
  platform: Pick<PlatformAdapter, "fetchThread">;
  idleMs?: number;
  now?: () => number;
  logSink?: LogSink;
}

export class IdleSweeper {
  private readonly sandbox: SandboxProvider & SandboxFsLike;
  private readonly platform: Pick<PlatformAdapter, "fetchThread">;
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly logSink: LogSink;

  constructor(deps: IdleSweeperDeps) {
    this.sandbox = deps.sandbox;
    this.platform = deps.platform;
    this.idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
    this.now = deps.now ?? Date.now;
    this.logSink = deps.logSink ?? nullSink;
  }

  /** Map a sandbox handle back to its thread (deterministic name, then the reverse-map file). */
  private async threadOf(handle: SandboxHandle): Promise<ThreadId | null> {
    const parsed = parseSandboxName(handle.name);
    if (parsed !== null) {
      return parsed;
    }
    if (!isHashName(handle.name)) {
      return null; // foreign/utility sandbox (e.g. _login-tmp)
    }
    const raw = await new AgentStateStore(this.sandbox, handle).readThread();
    return raw === null ? null : parseThreadRef(raw);
  }

  /** One pass: stop every idle sandbox. Best-effort per sandbox. */
  async sweepOnce(): Promise<{ stopped: string[] }> {
    const handles = await this.sandbox.list();
    const activities: SandboxActivity[] = [];
    for (const handle of handles) {
      const thread = await this.threadOf(handle);
      if (thread === null) {
        continue; // not one of ours — never touch it
      }
      const lastTs = highWaterMark(await this.platform.fetchThread(thread));
      activities.push({
        name: handle.name,
        lastActivityMs: lastTs === null ? null : tsToMs(lastTs),
      });
    }
    const stopped: string[] = [];
    for (const name of selectIdle(activities, this.now(), this.idleMs)) {
      try {
        await this.sandbox.stop({ name });
        this.logStop(name);
        stopped.push(name);
      } catch {
        // best-effort: a failed stop is retried next sweep
      }
    }
    return { stopped };
  }

  /** Run sweepOnce on an interval; returns a stop function. */
  start(intervalMs: number): () => void {
    const timer = setInterval(() => {
      void this.sweepOnce().catch(() => {});
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private logStop(name: string): void {
    const ctx: LogContext = {
      threadId: name,
      channel: "",
      thread_ts: "",
      sandbox: name,
      turnId: "idle-sweep",
    };
    safeWrite(
      this.logSink,
      buildRouterEvent(ctx, new Date().toISOString(), RouterKind.SandboxStop, { reason: "idle" }),
    );
  }
}
