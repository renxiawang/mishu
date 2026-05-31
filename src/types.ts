/** Shared types for the seams. See spec §3. */

/** A Slack thread identity: channel + root-message ts. */
export interface ThreadId {
  channel: string;
  threadTs: string;
}

/** A normalized inbound mention handed to the router. See spec §4.1. */
export interface Mention {
  thread: ThreadId;
  /** ts of the triggering message — used for idempotent dispatch (§4.1). */
  ts: string;
  user: string;
  text: string;
}

/** One message in a thread's transcript. See spec §4.2. */
export interface ThreadMessage {
  ts: string;
  user: string;
  text: string;
}
