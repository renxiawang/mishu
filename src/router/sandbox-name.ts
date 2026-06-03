import { createHash } from "node:crypto";
import type { ThreadId } from "../types.js";

export const SANDBOX_PREFIX = "t-";

/** Single-label hostname limit. Longer thread ids use a hash fallback. */
export const SBX_NAME_MAX_LEN = 63;

const CHARSET_RE = /^[A-Za-z0-9-]+$/;
const PLAIN_RE = /^t-([A-Za-z0-9]+)-(\d+)-(\d+)$/;
const HASH_RE = /^t-[0-9a-f]{16}$/;

export function sandboxName(thread: ThreadId): string {
  return `${SANDBOX_PREFIX}${thread.channel}-${thread.threadTs.replace(".", "-")}`;
}

export function isCharsetSafe(name: string): boolean {
  return CHARSET_RE.test(name);
}

export function isHashName(name: string): boolean {
  return HASH_RE.test(name);
}

export function hashSandboxName(thread: ThreadId): string {
  const digest = createHash("sha256").update(`${thread.channel} ${thread.threadTs}`).digest("hex");
  return `${SANDBOX_PREFIX}${digest.slice(0, 16)}`;
}

export function chooseSandboxName(thread: ThreadId, maxLen: number = SBX_NAME_MAX_LEN): string {
  const plain = sandboxName(thread);
  if (plain.length <= maxLen && isCharsetSafe(plain)) {
    return plain;
  }
  return hashSandboxName(thread);
}

export function parseSandboxName(name: string): ThreadId | null {
  const match = PLAIN_RE.exec(name);
  if (match === null) {
    return null;
  }
  const channel = match[1];
  const secs = match[2];
  const micros = match[3];
  if (channel === undefined || secs === undefined || micros === undefined) {
    return null;
  }
  return { channel, threadTs: `${secs}.${micros}` };
}
