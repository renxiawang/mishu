import type { SandboxHandle } from "../sandbox/index.js";
import type { CodingBackend, SandboxShellExecutor, TurnResult } from "./index.js";
import { asString, isRecord, newestByMtime, parseJsonlEvents } from "./parsing.js";

export const PI_HOME = "~/.pi/agent";
export const PI_SESSIONS_PATH = "$HOME/.pi/agent/sessions";

export interface PiBackendOptions {
  env?: Record<string, string>;
  model?: string;
  provider?: string;
}

export function piTurnArgs(
  message: string,
  sessionId?: string | null,
  opts: { model?: string; provider?: string } = {},
): string[] {
  const common = ["--mode", "json"];
  if (opts.provider !== undefined) {
    common.push("--provider", opts.provider);
  }
  if (opts.model !== undefined) {
    common.push("--model", opts.model);
  }
  if (sessionId === undefined || sessionId === null) {
    return ["pi", ...common, message];
  }
  return ["pi", ...common, "--session", sessionId, message];
}

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  let text = "";
  for (const block of content) {
    if (typeof block === "string") {
      text += block;
      continue;
    }
    if (isRecord(block)) {
      text += asString(block.text) ?? asString(block.content) ?? asString(block.delta) ?? "";
    }
  }
  return text;
}

function messageText(message: unknown): string | null {
  if (!isRecord(message)) {
    return null;
  }
  const direct = asString(message.text) ?? asString(message.result);
  if (direct !== null) {
    return direct;
  }
  const content = contentToText(message.content);
  return content === "" ? null : content;
}

function errorText(event: Record<string, unknown>): string | null {
  const type = asString(event.type) ?? "";
  if (type.includes("error")) {
    return asString(event.message) ?? asString(event.error);
  }
  const message = isRecord(event.message) ? event.message : null;
  if (message !== null && asString(message.stopReason) === "error") {
    return (
      messageText(message) ?? asString(message.errorMessage) ?? asString(message.error) ?? "error"
    );
  }
  return null;
}

export function parsePiResult(captured: string): TurnResult {
  if (captured.trim() === "") {
    return { finalText: "", ok: false };
  }
  let finalText = "";
  let assistantText = "";
  let error = "";
  let plainText = "";
  for (const line of captured.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      plainText += `${line}\n`;
      continue;
    }
    if (!isRecord(event)) {
      continue;
    }
    const eventError = errorText(event);
    if (eventError !== null && eventError !== "") {
      error = eventError;
    }
    const type = asString(event.type);
    if (type === "turn_end") {
      const text = messageText(event.message);
      if (text !== null) {
        finalText = text;
      }
      continue;
    }
    if (type === "message_end") {
      const message = isRecord(event.message) ? event.message : null;
      if (message !== null && asString(message.role) === "assistant") {
        const text = messageText(message);
        if (text !== null) {
          assistantText = text;
        }
      }
    }
  }
  if (error.trim() !== "") {
    return { finalText: error, ok: false };
  }
  if (finalText.trim() !== "") {
    return { finalText, ok: true };
  }
  if (assistantText.trim() !== "") {
    return { finalText: assistantText, ok: true };
  }
  if (plainText.trim() !== "") {
    return { finalText: plainText.trim(), ok: false };
  }
  return { finalText: "", ok: false };
}

export function parsePiSessionId(captured: string): string | null {
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
    if (isRecord(event) && asString(event.type) === "session") {
      return asString(event.id);
    }
  }
  return null;
}

const SESSION_FILENAME_RE = /^([0-9a-f-]+)\.jsonl$/i;

export function parsePiSessionFilename(filename: string): string | null {
  const match = SESSION_FILENAME_RE.exec(filename);
  return match?.[1] ?? null;
}

export class PiBackend implements CodingBackend {
  constructor(
    private readonly executor: SandboxShellExecutor,
    private readonly opts: PiBackendOptions = {},
  ) {}

  configHome(): string {
    return PI_HOME;
  }

  turnArgs(message: string, sessionId?: string): string[] {
    return piTurnArgs(message, sessionId, {
      model: this.opts.model,
      provider: this.opts.provider,
    });
  }

  turnEnv(): Record<string, string> {
    return this.opts.env ?? {};
  }

  parseResult(captured: string): TurnResult {
    return parsePiResult(captured);
  }

  parseSessionId(captured: string): string | null {
    return parsePiSessionId(captured);
  }

  events(captured: string): unknown[] {
    return parseJsonlEvents(captured);
  }

  async captureSessionId(handle: SandboxHandle): Promise<string> {
    const command = `find ${PI_SESSIONS_PATH} -name '*.jsonl' -printf '%T@\\t%p\\n' 2>/dev/null`;
    const { stdout } = await this.executor.execShell(handle, command);
    const newest = newestByMtime(stdout);
    if (newest === null) {
      throw new Error("pi: no session transcript found to capture the session id");
    }
    const filename = newest.slice(newest.lastIndexOf("/") + 1);
    const id = parsePiSessionFilename(filename);
    if (id === null) {
      throw new Error(`pi: could not parse the session id from transcript file "${filename}"`);
    }
    return id;
  }
}
