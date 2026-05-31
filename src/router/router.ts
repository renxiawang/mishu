import type { PlatformAdapter } from "../platform/index.js";
import type { Mention, ThreadId } from "../types.js";
import { createTtlSet, type TtlSet } from "./dedupe.js";
import {
  buildRouterEvent,
  type LogContext,
  type LogSink,
  nullSink,
  RouterKind,
  safeWrite,
} from "./log.js";
import { chooseSandboxName } from "./sandbox-name.js";
import { INITIAL_STATE, reduce, type ThreadFsmState } from "./state-machine.js";

/**
 * Router glue (spec §4.1) — plumbing, not an LLM. Owns the transient
 * per-thread coordination: the idle/running/pending FSM, ts-dedupe, the 👀 ack
 * on every mention, and a per-thread mutex so the state read-modify-write is
 * atomic. All durable state lives in the sandbox (§4.6); these maps are
 * memory-only and reset on restart, which is fine — an in-flight turn is
 * abandoned and re-driven idempotently on the next mention (§4.1).
 *
 * Dispatching is fire-and-forget: the turn (and its stream-reader) outlives the
 * dispatch so the router is free to service other threads, while this thread's
 * turn keeps draining (§4.1). Cross-thread turns run in parallel; turns within a
 * thread serialize and coalesce.
 */

/** What the router needs from the dispatcher (the real Dispatcher fits). */
export interface TurnDispatcher {
  dispatchTurn(trigger: Mention): Promise<{ ok: boolean }>;
}

export interface RouterOptions {
  dedupeTtlMs?: number;
  now?: () => number;
  logSink?: LogSink;
}

function threadKey(thread: ThreadId): string {
  return `${thread.channel}:${thread.threadTs}`;
}

export class Router {
  private readonly states = new Map<string, ThreadFsmState>();
  private readonly latestMention = new Map<string, Mention>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly dedupe: TtlSet;
  private readonly logSink: LogSink;

  constructor(
    private readonly platform: Pick<PlatformAdapter, "onMention" | "addReaction">,
    private readonly dispatcher: TurnDispatcher,
    options: RouterOptions = {},
  ) {
    this.dedupe = createTtlSet(options.dedupeTtlMs, options.now);
    this.logSink = options.logSink ?? nullSink;
  }

  start(): void {
    this.platform.onMention((mention) => {
      void this.onMention(mention);
    });
  }

  async onMention(mention: Mention): Promise<void> {
    const key = threadKey(mention.thread);

    // 1. Idempotent dispatch on ts — drop already-accepted triggers (§4.1).
    if (this.dedupe.has(mention.ts)) {
      this.logRouter(mention.thread, mention.ts, RouterKind.MentionDeduped, { ts: mention.ts });
      return;
    }
    this.dedupe.add(mention.ts);
    this.logRouter(mention.thread, mention.ts, RouterKind.MentionReceived, { user: mention.user });
    this.latestMention.set(key, mention);

    // 2. Atomic state read-modify-write under the per-thread lock (§4.1).
    const effects = await this.withLock(key, () => {
      const { state, effects } = reduce(this.stateOf(key), { kind: "mention" });
      this.states.set(key, state);
      return effects;
    });

    // 3. Effects run outside the lock (they don't touch FSM state).
    for (const effect of effects) {
      if (effect === "ackRunning" || effect === "ackPending") {
        void this.ack(mention);
      } else if (effect === "dispatchTurn") {
        this.dispatch(key, mention);
      }
    }
  }

  /** Fire-and-forget a turn; on completion, advance the FSM (coalescing, §4.1). */
  private dispatch(key: string, trigger: Mention): void {
    void this.dispatcher.dispatchTurn(trigger).then(
      () => this.onTurnFinished(key),
      () => this.onTurnFinished(key),
    );
  }

  private onTurnFinished(key: string): void {
    void this.withLock(key, () => {
      const { state, effects } = reduce(this.stateOf(key), { kind: "turnFinished" });
      this.states.set(key, state);
      return effects;
    }).then((effects) => {
      for (const effect of effects) {
        if (effect === "dispatchTurn") {
          const trigger = this.latestMention.get(key);
          if (trigger !== undefined) {
            this.dispatch(key, trigger);
          }
        }
      }
    });
  }

  private stateOf(key: string): ThreadFsmState {
    return this.states.get(key) ?? INITIAL_STATE;
  }

  /** Best-effort 👀 ack on the mention — never blocks or fails the turn (§4.1). */
  private async ack(mention: Mention): Promise<void> {
    try {
      await this.platform.addReaction(mention.thread.channel, mention.ts, "eyes");
      this.logRouter(mention.thread, mention.ts, RouterKind.AckReaction, { emoji: "eyes" });
    } catch {
      // best-effort
    }
  }

  /** Serialize handler bodies per thread so the state RMW is atomic (§4.1). */
  private withLock<T>(key: string, fn: () => T): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    this.locks.set(
      key,
      result.then(
        () => {},
        () => {},
      ),
    );
    return result;
  }

  private logRouter(
    thread: ThreadId,
    turnId: string,
    kind: string,
    payload: Record<string, unknown>,
  ): void {
    const name = chooseSandboxName(thread);
    const ctx: LogContext = {
      threadId: name,
      channel: thread.channel,
      thread_ts: thread.threadTs,
      sandbox: name,
      turnId,
    };
    safeWrite(this.logSink, buildRouterEvent(ctx, new Date().toISOString(), kind, payload));
  }
}
