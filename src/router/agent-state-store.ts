import type { SandboxHandle } from "../sandbox/index.js";
import type { ThreadMessage } from "../types.js";
import {
  parseTranscript,
  SESSION_PATH,
  serializeTranscript,
  THREAD_PATH,
  TRANSCRIPT_PATH,
} from "./agent-state.js";

/**
 * I/O layer of the per-thread durable state. Reads/writes the tiny
 * `~/.agent-state/` dir that lives inside each thread's sandbox — the router
 * keeps no state of its own. A single writer per file is guaranteed by
 * per-thread serialization.
 *
 * Depends on a narrow sandbox-fs capability (not the full provider) so it fakes
 * trivially in tests; the real SbxProvider implements it via `sbx exec`/`cp`.
 */
export interface SandboxFsLike {
  /** The sandbox user's `$HOME` (paths under it persist with the VM). */
  homeDir(handle: SandboxHandle): Promise<string>;
  /** File contents, or null if the file does not exist. */
  readFile(handle: SandboxHandle, absPath: string): Promise<string | null>;
  /** Write contents, creating parent directories as needed. */
  writeFile(handle: SandboxHandle, absPath: string, content: string): Promise<void>;
}

export class AgentStateStore {
  constructor(
    private readonly fs: SandboxFsLike,
    private readonly handle: SandboxHandle,
  ) {}

  private async abs(relPath: string): Promise<string> {
    return `${await this.fs.homeDir(this.handle)}/${relPath}`;
  }

  /** The seen-message ledger (empty on turn 1). */
  async readTranscript(): Promise<ThreadMessage[]> {
    const text = await this.fs.readFile(this.handle, await this.abs(TRANSCRIPT_PATH));
    return text === null ? [] : parseTranscript(text);
  }

  /**
   * Append the delta after a successful turn (write-after-success) so an
   * abandoned turn re-feeds cleanly. Read-modify-write of the whole file — the
   * ledger is small and has a single writer.
   */
  async appendDelta(delta: ThreadMessage[]): Promise<void> {
    if (delta.length === 0) {
      return;
    }
    const existing = await this.readTranscript();
    await this.fs.writeFile(
      this.handle,
      await this.abs(TRANSCRIPT_PATH),
      serializeTranscript([...existing, ...delta]),
    );
  }

  /** The coding-agent session id captured on turn 1, or null if unset. */
  async readSessionId(): Promise<string | null> {
    const text = await this.fs.readFile(this.handle, await this.abs(SESSION_PATH));
    const trimmed = text?.trim() ?? "";
    return trimmed === "" ? null : trimmed;
  }

  async writeSessionId(id: string): Promise<void> {
    await this.fs.writeFile(this.handle, await this.abs(SESSION_PATH), `${id}\n`);
  }

  /** Original channel+thread_ts, for reverse lookup of a hash-named sandbox. */
  async readThread(): Promise<string | null> {
    const text = await this.fs.readFile(this.handle, await this.abs(THREAD_PATH));
    const trimmed = text?.trim() ?? "";
    return trimmed === "" ? null : trimmed;
  }

  async writeThread(value: string): Promise<void> {
    await this.fs.writeFile(this.handle, await this.abs(THREAD_PATH), `${value}\n`);
  }
}
