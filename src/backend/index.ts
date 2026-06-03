import type { ExecResult, SandboxHandle } from "../sandbox/index.js";

export interface TurnResult {
  finalText: string;
  ok: boolean;
}

export interface CodingBackend {
  configHome(): string;

  turnArgs(message: string, sessionId?: string): string[];

  parseResult(captured: string): TurnResult;

  captureSessionId(handle: SandboxHandle): Promise<string>;

  parseSessionId?(captured: string): string | null;

  events?(captured: string): unknown[];
}

export interface SandboxShellExecutor {
  execShell(handle: SandboxHandle, command: string): Promise<ExecResult>;
}
