/**
 * Per-thread coordination state machine (spec §4.1).
 *
 * Pure, total reducer `(state, event) -> {state, effects}`. No timers, no I/O,
 * no message payload — "Slack is the queue" (§4.1), so the FSM only tracks
 * whether a turn is running and whether one more is pending; the dispatcher
 * recomputes the delta covering every coalesced mention.
 *
 * Held in router memory only (transient bucket, §3): lost on restart, which is
 * fine — an in-flight turn is abandoned and re-driven idempotently on the next
 * mention.
 *
 * State table (§4.1):
 *   idle           + mention      -> running         [ackRunning, dispatchTurn]
 *   running        + mention      -> runningPending  [ackPending]   (set pending, no dispatch)
 *   runningPending + mention      -> runningPending  [ackPending]   (idempotent)
 *   running        + turnFinished -> idle            [goIdle]
 *   runningPending + turnFinished -> running         [dispatchTurn] (the ONE coalesced follow-up)
 *   idle           + turnFinished -> idle            []             (defensive no-op)
 */

/** `runningPending` is the spec's "running + pending". */
export type ThreadFsmState = "idle" | "running" | "runningPending";

export type FsmEvent = { kind: "mention" } | { kind: "turnFinished" };

/**
 * An instruction for the router to execute. `ackRunning`/`ackPending` both add
 * the 👀 reaction (§4.1) but are distinct so the router can log the dispatch
 * path vs the coalesce path differently (§4.9).
 */
export type FsmEffect = "ackRunning" | "ackPending" | "dispatchTurn" | "goIdle";

export interface Transition {
  state: ThreadFsmState;
  effects: FsmEffect[];
}

export const INITIAL_STATE: ThreadFsmState = "idle";

export function reduce(state: ThreadFsmState, event: FsmEvent): Transition {
  switch (state) {
    case "idle":
      return event.kind === "mention"
        ? { state: "running", effects: ["ackRunning", "dispatchTurn"] }
        : { state: "idle", effects: [] };
    case "running":
      return event.kind === "mention"
        ? { state: "runningPending", effects: ["ackPending"] }
        : { state: "idle", effects: ["goIdle"] };
    case "runningPending":
      return event.kind === "mention"
        ? { state: "runningPending", effects: ["ackPending"] }
        : { state: "running", effects: ["dispatchTurn"] };
  }
}
