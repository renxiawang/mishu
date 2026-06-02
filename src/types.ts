/** Shared types for the seams. */

/** A Slack thread identity: channel + root-message ts. */
export interface ThreadId {
  channel: string;
  threadTs: string;
}

/** A normalized inbound mention handed to the router. */
export interface Mention {
  thread: ThreadId;
  /** ts of the triggering message — used for idempotent dispatch. */
  ts: string;
  user: string;
  text: string;
}

/** One message in a thread's transcript. */
export interface ThreadMessage {
  ts: string;
  user: string;
  text: string;
}
