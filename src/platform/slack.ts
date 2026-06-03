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

export interface SlackAdapterConfig {
  appToken: string;
  botToken: string;
  botUserId?: string;
}

interface SocketModeEventArgs {
  ack: () => Promise<void>;
  event: SlackAppMentionEvent;
  retry_num?: number;
}

function slackErrorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("data" in err)) {
    return undefined;
  }
  const data = (err as { data?: unknown }).data;
  if (typeof data !== "object" || data === null || !("error" in data)) {
    return undefined;
  }
  const error = (data as { error?: unknown }).error;
  return typeof error === "string" ? error : undefined;
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

  async whoAmI(): Promise<string | undefined> {
    if (this.botUserId === undefined) {
      const auth = await this.web.auth.test();
      this.botUserId = typeof auth.user_id === "string" ? auth.user_id : undefined;
    }
    return this.botUserId;
  }

  async start(): Promise<void> {
    await this.whoAmI();
    this.socket.on("app_mention", (args: SocketModeEventArgs) => {
      void args.ack().catch(() => {});
      if (typeof args.retry_num === "number" && args.retry_num > 0) {
        return;
      }
      const mention = mentionFromEvent(args.event, this.botUserId);
      if (mention !== null && this.handler !== null) {
        this.handler(mention);
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
        throw err;
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
