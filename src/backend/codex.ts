import type { SandboxHandle } from "../sandbox/index.js";
import type { CodingBackend, SandboxShellExecutor, TurnResult } from "./index.js";
import { asString, isRecord, newestByMtime, parseJsonlEvents } from "./parsing.js";

export const CODEX_HOME = "~/.codex";
export const CODEX_SESSIONS_PATH = "$HOME/.codex/sessions";

export const CODEX_NONBLOCKING_FLAGS = [
  "-c",
  "sandbox_mode=workspace-write",
  "-c",
  "approval_policy=never",
];

export function codexTurnArgs(message: string, sessionId?: string | null): string[] {
  const common = ["--json", "--skip-git-repo-check", ...CODEX_NONBLOCKING_FLAGS];
  if (sessionId === undefined || sessionId === null) {
    return ["codex", "exec", ...common, "--", message];
  }
  return ["codex", "exec", "resume", ...common, "--", sessionId, message];
}

function extractAssistantText(event: Record<string, unknown>): string | null {
  const last =
    asString(event.last_agent_message) ??
    (isRecord(event.msg) ? asString(event.msg.last_agent_message) : null);
  if (last !== null) {
    return last;
  }
  const item = isRecord(event.item) ? event.item : null;
  if (item !== null) {
    const itemType = asString(item.type) ?? asString(item.item_type);
    if (itemType === "assistant_message" || itemType === "agent_message") {
      return asString(item.text) ?? asString(item.message);
    }
  }
  const msg = isRecord(event.msg) ? event.msg : null;
  if (msg !== null && asString(msg.type) === "agent_message") {
    return asString(msg.message) ?? asString(msg.text);
  }
  const type = asString(event.type);
  if (type === "assistant_message" || type === "agent_message") {
    return asString(event.text) ?? asString(event.message);
  }
  return null;
}

function extractErrorMessage(event: Record<string, unknown>): string | null {
  const type = asString(event.type) ?? "";
  if (
    type !== "error" &&
    type !== "turn.failed" &&
    !type.includes("error") &&
    !type.includes("failed")
  ) {
    return null;
  }
  return asString(event.message) ?? (isRecord(event.error) ? asString(event.error.message) : null);
}

export function parseCodexResult(captured: string): TurnResult {
  if (captured.trim() === "") {
    return { finalText: "", ok: false };
  }
  let finalText = "";
  let errorText = "";
  for (const line of captured.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event)) {
      continue;
    }
    const text = extractAssistantText(event);
    if (text !== null && text !== "") {
      finalText = text;
    }
    const error = extractErrorMessage(event);
    if (error !== null && error !== "") {
      errorText = error;
    }
  }
  if (finalText.trim() !== "") {
    return { finalText, ok: true };
  }
  return { finalText: errorText, ok: false };
}

function findSessionId(record: Record<string, unknown>): string | null {
  return (
    asString(record.thread_id) ?? asString(record.session_id) ?? asString(record.conversation_id)
  );
}

export function parseSessionId(captured: string): string | null {
  for (const line of captured.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event)) {
      continue;
    }
    const id = findSessionId(event) ?? (isRecord(event.msg) ? findSessionId(event.msg) : null);
    if (id !== null) {
      return id;
    }
  }
  return null;
}

const ROLLOUT_UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export function parseRolloutId(filename: string): string | null {
  const match = ROLLOUT_UUID_RE.exec(filename);
  return match?.[1] ?? null;
}

export class CodexBackend implements CodingBackend {
  constructor(private readonly executor: SandboxShellExecutor) {}

  configHome(): string {
    return CODEX_HOME;
  }

  turnArgs(message: string, sessionId?: string): string[] {
    return codexTurnArgs(message, sessionId);
  }

  parseResult(captured: string): TurnResult {
    return parseCodexResult(captured);
  }

  parseSessionId(captured: string): string | null {
    return parseSessionId(captured);
  }

  events(captured: string): unknown[] {
    return parseJsonlEvents(captured);
  }

  async captureSessionId(handle: SandboxHandle): Promise<string> {
    const command = `find ${CODEX_SESSIONS_PATH} -name 'rollout-*.jsonl' -printf '%T@\\t%p\\n' 2>/dev/null`;
    const { stdout } = await this.executor.execShell(handle, command);
    const newest = newestByMtime(stdout);
    if (newest === null) {
      throw new Error("codex: no rollout file found to capture the session id");
    }
    const filename = newest.slice(newest.lastIndexOf("/") + 1);
    const id = parseRolloutId(filename);
    if (id === null) {
      throw new Error(`codex: could not parse the session id from rollout file "${filename}"`);
    }
    return id;
  }
}
