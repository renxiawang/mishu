import type { Mention, ThreadId, ThreadMessage } from "../types.js";

/**
 * PlatformAdapter — ingress/egress of human conversation.
 *
 * v0: Slack via Socket Mode. The implementation MUST acknowledge the Socket
 * Mode envelope immediately (<3s) and invoke the handler asynchronously — it
 * must never block the ACK on sandbox/turn work. Acks to the user
 * are reactions, not replies.
 *
 * Later platforms (Discord, Teams, Linear comments) implement the same shape.
 */
export interface PlatformAdapter {
  /** Register the mention handler. The adapter ACKs the transport, then calls this. */
  onMention(handler: (mention: Mention) => void): void;

  /** Whole thread (sinceTs omitted) or only messages after sinceTs — the delta. */
  fetchThread(thread: ThreadId, sinceTs?: string): Promise<ThreadMessage[]>;

  postReply(thread: ThreadId, text: string): Promise<void>;
  uploadFile(thread: ThreadId, path: string): Promise<void>;

  addReaction(channel: string, ts: string, emoji: string): Promise<void>;
  removeReaction(channel: string, ts: string, emoji: string): Promise<void>;
}
