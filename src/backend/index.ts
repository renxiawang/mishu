import type { SandboxHandle } from "../sandbox/index.js";

/**
 * CodingBackend — per-agent knowledge: the ONLY place agent-format details
 * live. See spec §3, §4.9. Transport (SandboxProvider.exec) is router-owned
 * and format-agnostic; only turnArgs / parseResult / events know the agent's
 * format.
 *
 * v0: Codex. Then Claude Code, then Pi (the `pi` CLI — a third-party binary
 * run inside the sandbox, not a code dependency; see spec §10).
 */
export interface TurnResult {
  finalText: string;
  ok: boolean;
}

export interface CodingBackend {
  /** e.g. ~/.codex, ~/.claude, ~/.pi/agent */
  configHome(): string;

  /** Build the CLI invocation. sessionId omitted → fresh session, else resume (§4.5). */
  turnArgs(message: string, sessionId?: string): string[];

  /** Interpret the raw captured stream into the result to relay (agent-specific, §4.9). */
  parseResult(captured: string): TurnResult;

  /** After a fresh turn, read the new session's id (Codex: newest rollout filename) (§4.5). */
  captureSessionId(handle: SandboxHandle): Promise<string>;

  /** OPTIONAL: normalized events to enrich logs; router degrades to raw bytes if absent. */
  events?(captured: string): unknown[];
}
