import type { ThreadMessage } from "../types.js";

export const AGENT_STATE_DIR = ".agent-state";
export const TRANSCRIPT_PATH = `${AGENT_STATE_DIR}/transcript.jsonl`;
export const SESSION_PATH = `${AGENT_STATE_DIR}/session`;
export const THREAD_PATH = `${AGENT_STATE_DIR}/thread`;

export function highWaterMark(transcript: ThreadMessage[]): string | null {
  let max: string | null = null;
  for (const message of transcript) {
    if (max === null || message.ts > max) {
      max = message.ts;
    }
  }
  return max;
}

export interface DeltaOptions {
  botUser?: string;
}

export function computeDelta(
  fetched: ThreadMessage[],
  hwm: string | null,
  opts: DeltaOptions = {},
): ThreadMessage[] {
  const { botUser } = opts;
  return fetched.filter((message) => {
    if (botUser !== undefined && message.user === botUser) {
      return false;
    }
    if (hwm !== null && message.ts <= hwm) {
      return false;
    }
    return true;
  });
}

/** Serialize messages to JSONL (one `{ts, user, text}` per line, trailing \n). */
export function serializeTranscript(messages: ThreadMessage[]): string {
  if (messages.length === 0) {
    return "";
  }
  return `${messages
    .map((m) => JSON.stringify({ ts: m.ts, user: m.user, text: m.text }))
    .join("\n")}\n`;
}

export function parseTranscript(text: string): ThreadMessage[] {
  const messages: ThreadMessage[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") {
      continue;
    }
    const parsed: unknown = JSON.parse(line);
    if (!isThreadMessage(parsed)) {
      throw new Error(`invalid transcript line ${index + 1}`);
    }
    messages.push(parsed);
  }
  return messages;
}

function isThreadMessage(value: unknown): value is ThreadMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ThreadMessage).ts === "string" &&
    typeof (value as ThreadMessage).user === "string" &&
    typeof (value as ThreadMessage).text === "string"
  );
}
