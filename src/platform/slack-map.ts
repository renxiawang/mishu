import type { Mention, ThreadMessage } from "../types.js";

/**
 * Pure Slack-event mapping — the subtle bits that hold the bugs,
 * isolated from the Socket Mode / Web API I/O so they're unit-testable:
 *  - a root mention uses its own `ts` as the thread id (it opens the thread);
 *    a reply uses the parent `thread_ts`;
 *  - the bot's own posts and other bots never trigger a turn.
 */

/** The fields we read off a Slack `app_mention` event. */
export interface SlackAppMentionEvent {
  type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  channel?: string;
  thread_ts?: string;
  subtype?: string;
}

/**
 * Normalize an `app_mention` into a Mention, or null if it shouldn't trigger a
 * turn (missing fields, a bot's message, or the bot's own post).
 */
export function mentionFromEvent(event: SlackAppMentionEvent, botUserId?: string): Mention | null {
  if (event.ts === undefined || event.channel === undefined || event.user === undefined) {
    return null;
  }
  if (event.bot_id !== undefined) {
    return null; // another bot — don't loop
  }
  if (botUserId !== undefined && event.user === botUserId) {
    return null; // our own post
  }
  // A root mention has no thread_ts; its own ts opens the thread.
  const threadTs = event.thread_ts ?? event.ts;
  return {
    thread: { channel: event.channel, threadTs },
    ts: event.ts,
    user: event.user,
    text: event.text ?? "",
  };
}

/** The fields we read off a message in `conversations.replies`. */
export interface SlackMessage {
  ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  subtype?: string;
}

/** Map a Slack thread message to a ThreadMessage, or null if it has no ts. */
export function threadMessageFromSlack(message: SlackMessage): ThreadMessage | null {
  if (message.ts === undefined) {
    return null;
  }
  return {
    ts: message.ts,
    user: message.user ?? message.bot_id ?? "unknown",
    text: message.text ?? "",
  };
}

/** Map a `conversations.replies` page to ThreadMessages, dropping unmappable ones. */
export function threadMessagesFromReplies(messages: SlackMessage[]): ThreadMessage[] {
  const result: ThreadMessage[] = [];
  for (const message of messages) {
    const mapped = threadMessageFromSlack(message);
    if (mapped !== null) {
      result.push(mapped);
    }
  }
  return result;
}
