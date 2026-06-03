export type ThreadFsmState = "idle" | "running" | "runningPending";

export type FsmEvent = { kind: "mention" } | { kind: "turnFinished" };

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
