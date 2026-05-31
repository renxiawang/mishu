import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type { Mention, ThreadId, ThreadMessage } from "../types.js";
import type { PlatformAdapter } from "./index.js";
import {
  mentionFromEvent,
  type SlackAppMentionEvent,
  type SlackMessage,
  threadMessagesFromReplies,
} from "./slack-map.js";

/**
 * Slack PlatformAdapter via Socket Mode + Web API (spec §4.1) — the I/O shell.
 * The mapping logic lives in slack-map.ts; this only wires the SDKs.
 *
 * Discipline (§4.1): the Socket Mode envelope is ACKed immediately on receipt,
 * BEFORE any work, and the handler runs async to the ACK; retries
 * (retry_num > 0) are dropped so a slow turn can't trigger double-dispatch.
 * Acks to the user are reactions, not replies (§4.1/§4.2).
 */

export interface SlackAdapterConfig {
  /** App-level token (xapp-…, connections:write) → Socket Mode. */
  appToken: string;
  /** Bot token (xoxb-…). */
  botToken: string;
  /** Bot user id; resolved via auth.test() at start() if omitted. */
  botUserId?: string;
}

/** The arg shape SocketModeClient emits for an events_api event. */
interface SocketModeEventArgs {
  ack: () => Promise<void>;
  event: SlackAppMentionEvent;
  retry_num?: number;
}

function slackErrorCode(err: unknown): string | undefined {
  const data = (err as { data?: { error?: string } }).data;
  return data?.error;
}

export class SlackAdapter implements PlatformAdapter {
  private readonly socket: SocketModeClient;
  private readonly web: WebClient;
  private botUserId: string | undefined;
  private handler: ((mention: Mention) => void) | null = null;

  constructor(config: SlackAdapterConfig) {
    this.socket = new SocketModeClient({ appToken: config.appToken });
    this.web = new WebClient(config.botToken);
    this.botUserId = config.botUserId;
  }

  onMention(handler: (mention: Mention) => void): void {
    this.handler = handler;
  }

  /** Resolve the bot's identity, wire the listener, and open the socket. */
  async start(): Promise<void> {
    if (this.botUserId === undefined) {
      const auth = await this.web.auth.test();
      this.botUserId = typeof auth.user_id === "string" ? auth.user_id : undefined;
    }
    this.socket.on("app_mention", (args: SocketModeEventArgs) => {
      // ACK at the WebSocket layer on receipt — never block the ~3s deadline (§4.1).
      void args.ack();
      if (typeof args.retry_num === "number" && args.retry_num > 0) {
        return; // a retry of an event we already accepted (§4.1)
      }
      const mention = mentionFromEvent(args.event, this.botUserId);
      if (mention !== null && this.handler !== null) {
        this.handler(mention); // async to the ACK
      }
    });
    await this.socket.start();
  }

  async fetchThread(thread: ThreadId, sinceTs?: string): Promise<ThreadMessage[]> {
    const messages: SlackMessage[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.web.conversations.replies({
        channel: thread.channel,
        ts: thread.threadTs,
        oldest: sinceTs,
        inclusive: false,
        limit: 200,
        cursor,
      });
      messages.push(...((res.messages ?? []) as SlackMessage[]));
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor !== undefined);
    return threadMessagesFromReplies(messages);
  }

  async postReply(thread: ThreadId, text: string): Promise<void> {
    await this.web.chat.postMessage({
      channel: thread.channel,
      thread_ts: thread.threadTs,
      text,
    });
  }

  async uploadFile(thread: ThreadId, path: string): Promise<void> {
    await this.web.filesUploadV2({
      channel_id: thread.channel,
      thread_ts: thread.threadTs,
      file: path,
    });
  }

  async addReaction(channel: string, ts: string, emoji: string): Promise<void> {
    try {
      await this.web.reactions.add({ channel, timestamp: ts, name: emoji });
    } catch (err) {
      if (slackErrorCode(err) !== "already_reacted") {
        throw err; // idempotent: re-adding our own 👀 is fine (§4.1)
      }
    }
  }

  async removeReaction(channel: string, ts: string, emoji: string): Promise<void> {
    try {
      await this.web.reactions.remove({ channel, timestamp: ts, name: emoji });
    } catch (err) {
      if (slackErrorCode(err) !== "no_reaction") {
        throw err;
      }
    }
  }
}
