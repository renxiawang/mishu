import type { ThreadMessage } from "../types.js";

/**
 * Per-thread durable state — pure layer.
 *
 * The thread's seen-message ledger is `~/.agent-state/transcript.jsonl` in the
 * sandbox: one JSON line per message the agent has been fed, `{ts, user, text}`.
 * It is both the **high-water mark** (largest `ts`) and a durable audit of
 * exactly what the agent saw. This file holds only the *pure* logic over message
 * arrays; the sbx-backed read/write store lives in agent-state.store.ts.
 *
 * Paths are relative to the sandbox user's `$HOME` (resolved by the store).
 */
export const AGENT_STATE_DIR = ".agent-state";
export const TRANSCRIPT_PATH = `${AGENT_STATE_DIR}/transcript.jsonl`;
export const SESSION_PATH = `${AGENT_STATE_DIR}/session`;
export const THREAD_PATH = `${AGENT_STATE_DIR}/thread`;

/**
 * Largest `ts` in the ledger, or `null` when empty (which is how the router
 * knows it's turn 1).
 *
 * Slack `ts` is `"<10-digit secs>.<6-digit micros>"`, zero-padded, so plain
 * string comparison is chronological (verified by test). This holds until the
 * seconds field gains an 11th digit (year 2286).
 */
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
  /** The bot's own Slack user id; its posts are never fed back to the agent. */
  botUser?: string;
}

/**
 * The messages to feed this turn: everything after the high-water mark, minus
 * the bot's own posts.
 *
 * - Turn 1 (`hwm === null`): the whole thread minus bot posts — the primer.
 * - Follow-up: messages with `ts > hwm` minus bot posts — the exact delta.
 *
 * On "minus the trigger": the *previous* turn's trigger is already
 * excluded by `ts > hwm` (it's in the ledger). The *current* trigger carries the
 * user's new request and MUST be included — the delta covers all of
 * them [the mentions]. So the only author we drop is the bot itself.
 */
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

/**
 * Parse JSONL back to messages, tolerating a trailing newline and blank lines.
 * Malformed lines throw (the ledger has a single writer and is append-only, so
 * corruption is a real signal, not something to silently swallow).
 */
export function parseTranscript(text: string): ThreadMessage[] {
  const messages: ThreadMessage[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const parsed = JSON.parse(line) as ThreadMessage;
    messages.push({ ts: parsed.ts, user: parsed.user, text: parsed.text });
  }
  return messages;
}
