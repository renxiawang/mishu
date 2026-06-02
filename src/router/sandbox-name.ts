import { createHash } from "node:crypto";
import type { ThreadId } from "../types.js";

/**
 * Deterministic, reversible sandbox naming.
 *
 * The sandbox name is a pure function of the thread id, so the router can find a
 * thread's sandbox via `sbx ls` + this function without any persisted mapping,
 * and reverse a running sandbox's name back to its thread for the idle sweep.
 *
 * IMPORTANT — charset. The binding constraint (verified LIVE) is that sbx uses
 * the name as the container HOSTNAME, which rejects BOTH `_` AND `.`:
 *  - `_`: an earlier sample did `thread_ts.replace(".", "_")` — `_` is
 *    illegal for `sbx create --name`.
 *  - `.`: accepted by `--name` but `sbx create` then fails with
 *    "hostname: value must be a valid hostname".
 * Slack `thread_ts` is `<secs>.<micros>`, so we encode the `.` as `-`
 * (uppercase channel is fine as a hostname). The result is `[A-Za-z0-9-]`, and
 * it stays reversible because the channel contains no `-` and the ts is exactly
 * two numeric groups.
 */

export const SANDBOX_PREFIX = "t-";

/**
 * Max sandbox-name length before we fall back to a hash name. 63 is the
 * single-label hostname limit; our dot-less name is a single label, so this is
 * the right ceiling. The hash fallback keeps naming correct past it.
 */
export const SBX_NAME_MAX_LEN = 63;

/** Hostname-safe charset we emit — letters, numbers, `-` (NO `.`, NO `_`). */
const CHARSET_RE = /^[A-Za-z0-9-]+$/;

/** A plain (reversible) name: `t-<channel>-<secs>-<micros>`. */
const PLAIN_RE = /^t-([A-Za-z0-9]+)-(\d+)-(\d+)$/;

/** A hash-fallback name: `t-<16 hex>` (not reversible from the name alone). */
const HASH_RE = /^t-[0-9a-f]{16}$/;

/** `name = "t-" + channel + "-" + thread_ts` with the `.` encoded as `-` (hostname-safe). */
export function sandboxName(thread: ThreadId): string {
  return `${SANDBOX_PREFIX}${thread.channel}-${thread.threadTs.replace(".", "-")}`;
}

/** True iff every char is legal in a sandbox name / container hostname. */
export function isCharsetSafe(name: string): boolean {
  return CHARSET_RE.test(name);
}

/** True iff `name` is one of our hash-fallback names (`t-<16 hex>`). */
export function isHashName(name: string): boolean {
  return HASH_RE.test(name);
}

/**
 * Length/charset fallback: a charset-safe, fixed-length name derived from the
 * thread id. Not reversible from the name — the full id is stored in the
 * sandbox's `~/.agent-state/thread` for reverse lookup.
 */
export function hashSandboxName(thread: ThreadId): string {
  const digest = createHash("sha256").update(`${thread.channel} ${thread.threadTs}`).digest("hex");
  return `${SANDBOX_PREFIX}${digest.slice(0, 16)}`;
}

/**
 * The name the router actually uses: the plain reversible name when it's legal
 * and within the length budget, else the hash fallback.
 */
export function chooseSandboxName(thread: ThreadId, maxLen: number = SBX_NAME_MAX_LEN): string {
  const plain = sandboxName(thread);
  if (plain.length <= maxLen && isCharsetSafe(plain)) {
    return plain;
  }
  return hashSandboxName(thread);
}

/**
 * Reverse a plain name back to its thread id, or `null` if the name isn't one of
 * ours in reversible form. Returns `null` for hash names (caller should read
 * `~/.agent-state/thread`) and for foreign/utility names like `_login-tmp` —
 * the `t-` prefix namespaces our sandboxes away from those.
 */
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
