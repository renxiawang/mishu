import type { Mention } from "../types.js";
import { Router, type TurnDispatcher } from "./router.js";

const thread = { channel: "C0ABCDEF", threadTs: "1748600000.100000" };
const mention = (ts: string): Mention => ({ thread, ts, user: "U1", text: `@bot ${ts}` });
const m1 = mention("1748600000.100001");
const m2 = mention("1748600000.100002");
const m3 = mention("1748600000.100003");

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A dispatcher whose turns stay in flight until finishOne() is called. */
class FakeDispatcher implements TurnDispatcher {
  calls: Mention[] = [];
  private resolvers: (() => void)[] = [];
  async dispatchTurn(trigger: Mention): Promise<{ ok: boolean }> {
    this.calls.push(trigger);
    await new Promise<void>((resolve) => this.resolvers.push(resolve));
    return { ok: true };
  }
  finishOne(): void {
    this.resolvers.shift()?.();
  }
  get inFlight(): number {
    return this.resolvers.length;
  }
}

class FakePlatform {
  reactions: string[] = [];
  onMention(): void {}
  async addReaction(channel: string, ts: string, emoji: string): Promise<void> {
    this.reactions.push(`${channel}:${ts}:${emoji}`);
  }
}

function build(): { router: Router; dispatcher: FakeDispatcher; platform: FakePlatform } {
  const dispatcher = new FakeDispatcher();
  const platform = new FakePlatform();
  const router = new Router(platform, dispatcher);
  return { router, dispatcher, platform };
}

describe("dedupe", () => {
  it("drops a re-delivered ts (no second dispatch)", async () => {
    const { router, dispatcher } = build();
    await router.onMention(m1);
    await router.onMention({ ...m1 }); // same ts re-delivered
    expect(dispatcher.calls).toHaveLength(1);
  });

  it("does not dedupe the same ts across different channels", async () => {
    const { router, dispatcher } = build();
    const other = {
      ...m1,
      thread: { channel: "COTHER", threadTs: m1.thread.threadTs },
    };
    await router.onMention(m1);
    await router.onMention(other);
    expect(dispatcher.calls).toEqual([m1, other]);
  });
});

describe("idle/running/pending", () => {
  it("dispatches on the first mention and 👀s it", async () => {
    const { router, dispatcher, platform } = build();
    await router.onMention(m1);
    expect(dispatcher.calls).toEqual([m1]);
    expect(platform.reactions).toContain(`${thread.channel}:${m1.ts}:eyes`);
  });

  it("a mention during a running turn sets pending + 👀s, but does NOT dispatch", async () => {
    const { router, dispatcher, platform } = build();
    await router.onMention(m1); // dispatch #1 (stays in flight)
    await router.onMention(m2); // running -> pending
    expect(dispatcher.calls).toEqual([m1]); // no new dispatch
    expect(platform.reactions).toContain(`${thread.channel}:${m2.ts}:eyes`); // still 👀'd
  });

  it("👀s every mention", async () => {
    const { router, platform } = build();
    await router.onMention(m1);
    await router.onMention(m2);
    await router.onMention(m3);
    expect(platform.reactions).toEqual([
      `${thread.channel}:${m1.ts}:eyes`,
      `${thread.channel}:${m2.ts}:eyes`,
      `${thread.channel}:${m3.ts}:eyes`,
    ]);
  });
});

describe("coalescing", () => {
  it("N mentions during a turn produce exactly ONE coalesced follow-up (latest trigger)", async () => {
    const { router, dispatcher } = build();
    await router.onMention(m1); // dispatch #1
    await router.onMention(m2); // pending
    await router.onMention(m3); // still pending (idempotent)
    expect(dispatcher.calls).toHaveLength(1);

    dispatcher.finishOne(); // turn 1 done -> coalesced follow-up
    await flush();
    expect(dispatcher.calls).toEqual([m1, m3]); // exactly one follow-up, latest mention as trigger

    dispatcher.finishOne(); // follow-up done -> idle
    await flush();
    expect(dispatcher.calls).toHaveLength(2); // nothing more
  });

  it("a single mention with no mid-turn mentions yields exactly one dispatch", async () => {
    const { router, dispatcher } = build();
    await router.onMention(m1);
    dispatcher.finishOne();
    await flush();
    expect(dispatcher.calls).toEqual([m1]);
  });
});

describe("atomicity at the finish boundary", () => {
  it("a mention landing as a turn finishes is never lost", async () => {
    const { router, dispatcher } = build();
    await router.onMention(m1); // dispatch #1

    // Finish the turn and deliver m2 without awaiting in between — the per-thread
    // mutex must serialize the turnFinished reduce and the mention reduce so m2
    // can't slip between "go idle" and "set pending".
    dispatcher.finishOne();
    await router.onMention(m2);
    await flush();

    expect(dispatcher.calls).toContain(m2);
    expect(dispatcher.calls).toHaveLength(2);
  });
});

describe("restart", () => {
  it("a fresh Router starts idle (no persisted state) and dispatches", async () => {
    const { router, dispatcher } = build();
    await router.onMention(m1);
    expect(dispatcher.calls).toEqual([m1]);
  });
});
