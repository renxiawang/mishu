import {
  type FsmEffect,
  type FsmEvent,
  INITIAL_STATE,
  reduce,
  type ThreadFsmState,
} from "./state-machine.js";

const mention: FsmEvent = { kind: "mention" };
const turnFinished: FsmEvent = { kind: "turnFinished" };

/** Fold a sequence of events from a start state, collecting every effect. */
function run(
  start: ThreadFsmState,
  events: FsmEvent[],
): { state: ThreadFsmState; effects: FsmEffect[] } {
  let state = start;
  const effects: FsmEffect[] = [];
  for (const event of events) {
    const t = reduce(state, event);
    state = t.state;
    effects.push(...t.effects);
  }
  return { state, effects };
}

describe("reduce — every state x event cell", () => {
  it("idle + mention -> running [ackRunning, dispatchTurn]", () => {
    expect(reduce("idle", mention)).toEqual({
      state: "running",
      effects: ["ackRunning", "dispatchTurn"],
    });
  });

  it("running + mention -> runningPending [ackPending] (no dispatch)", () => {
    expect(reduce("running", mention)).toEqual({
      state: "runningPending",
      effects: ["ackPending"],
    });
  });

  it("runningPending + mention -> runningPending [ackPending] (idempotent)", () => {
    expect(reduce("runningPending", mention)).toEqual({
      state: "runningPending",
      effects: ["ackPending"],
    });
  });

  it("running + turnFinished -> idle [goIdle]", () => {
    expect(reduce("running", turnFinished)).toEqual({ state: "idle", effects: ["goIdle"] });
  });

  it("runningPending + turnFinished -> running [dispatchTurn] (coalesced follow-up)", () => {
    expect(reduce("runningPending", turnFinished)).toEqual({
      state: "running",
      effects: ["dispatchTurn"],
    });
  });

  it("idle + turnFinished -> idle [] (defensive no-op)", () => {
    expect(reduce("idle", turnFinished)).toEqual({ state: "idle", effects: [] });
  });
});

describe("coalescing", () => {
  it("dispatches exactly once per turn regardless of mentions arriving mid-turn", () => {
    // 1 initial mention + 5 mid-turn mentions, then the turn finishes, then the
    // coalesced follow-up finishes. Expect exactly 2 dispatches total.
    const events: FsmEvent[] = [
      mention, // -> running, dispatch #1
      mention, // -> pending
      mention,
      mention,
      mention,
      mention, // still pending (idempotent)
      turnFinished, // -> running, dispatch #2 (coalesced)
      turnFinished, // -> idle, no dispatch
    ];
    const { state, effects } = run(INITIAL_STATE, events);
    expect(effects.filter((e) => e === "dispatchTurn")).toHaveLength(2);
    expect(state).toBe("idle");
  });

  it("a single mention with no mid-turn mentions yields exactly one dispatch", () => {
    const { state, effects } = run(INITIAL_STATE, [mention, turnFinished]);
    expect(effects.filter((e) => e === "dispatchTurn")).toHaveLength(1);
    expect(state).toBe("idle");
  });

  it("acks every mention but only dispatches when idle (👀 on each)", () => {
    const { effects } = run(INITIAL_STATE, [mention, mention, mention]);
    const acks = effects.filter((e) => e === "ackRunning" || e === "ackPending");
    expect(acks).toHaveLength(3); // one 👀 per mention
    expect(effects.filter((e) => e === "dispatchTurn")).toHaveLength(1); // only the first dispatched
  });

  it("orders the ack before the dispatch on idle+mention", () => {
    const { effects } = reduce("idle", mention);
    expect(effects.indexOf("ackRunning")).toBeLessThan(effects.indexOf("dispatchTurn"));
  });
});

describe("invariants", () => {
  it("never dispatches a turn while one is already in flight", () => {
    // Drive an interleaving of mentions and completions; a turnFinished clears
    // the in-flight turn, after which the FSM may dispatch the coalesced one.
    let state = INITIAL_STATE;
    let inFlight = false;
    const seq: FsmEvent[] = [
      mention,
      mention,
      turnFinished,
      mention,
      turnFinished,
      turnFinished,
      mention,
      turnFinished,
    ];
    for (const event of seq) {
      const t = reduce(state, event);
      if (event.kind === "turnFinished") {
        inFlight = false; // the in-flight turn completed
      }
      for (const eff of t.effects) {
        if (eff === "dispatchTurn") {
          expect(inFlight).toBe(false); // never dispatch while a turn is in flight
          inFlight = true;
        }
      }
      state = t.state;
    }
    expect(state).toBe("idle");
    expect(inFlight).toBe(false);
  });
});
