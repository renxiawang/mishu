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

function dedupeKey(mention: Mention): string {
  return `${mention.thread.channel}:${mention.ts}`;
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
    const dedupe = dedupeKey(mention);

    if (this.dedupe.has(dedupe)) {
      this.logRouter(mention.thread, mention.ts, RouterKind.MentionDeduped, { ts: mention.ts });
      return;
    }
    this.dedupe.add(dedupe);
    this.logRouter(mention.thread, mention.ts, RouterKind.MentionReceived, { user: mention.user });
    this.latestMention.set(key, mention);

    const effects = await this.withLock(key, () => {
      const { state, effects } = reduce(this.stateOf(key), { kind: "mention" });
      this.states.set(key, state);
      return effects;
    });

    for (const effect of effects) {
      if (effect === "ackRunning" || effect === "ackPending") {
        void this.ack(mention);
      } else if (effect === "dispatchTurn") {
        this.dispatch(key, mention);
      }
    }
  }

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

  private async ack(mention: Mention): Promise<void> {
    try {
      await this.platform.addReaction(mention.thread.channel, mention.ts, "eyes");
      this.logRouter(mention.thread, mention.ts, RouterKind.AckReaction, { emoji: "eyes" });
    } catch {
      // best-effort
    }
  }

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
