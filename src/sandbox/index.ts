/**
 * SandboxProvider — isolated execution-environment lifecycle. See spec §3, §4.4.
 *
 * v0: Docker Sandboxes (sbx) microVM. `exec` is the transport the router logs
 * at the agent boundary (§4.9); commands should be wrapped in `bash -c` so the
 * sandbox's persistent environment is loaded (§4.5).
 *
 * Fallback: plain Docker + iptables egress. Cloud/teams later: e2b / Daytona /
 * self-hosted Firecracker.
 */
export interface SandboxHandle {
  /** Deterministic, reversible name = f(threadId). See spec §4.1. */
  name: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Streaming options for a single exec call (§4.1/§4.9). */
export interface ExecCallOptions {
  /** Receive raw stdout/stderr chunks as they arrive (the router logs them, §4.9). */
  onChunk?: (stream: "stdout" | "stderr", chunk: string) => void;
  /** Optional input to write before closing stdin. Stdin is always closed (§9.15). */
  stdin?: string;
}

export interface SandboxProvider {
  create(name: string, repoRef: string): Promise<SandboxHandle>;

  /**
   * Drive the agent CLI per turn (argv wrapped in `bash -c`); the router streams
   * and logs this raw output (§4.9). The reader drains stdout+stderr to exit and
   * closes stdin (§9.15).
   */
  exec(handle: SandboxHandle, argv: string[], opts?: ExecCallOptions): Promise<ExecResult>;

  /** Run a raw shell command (utility ops: file reads, mkdir, $HOME, find). */
  execShell(handle: SandboxHandle, command: string, opts?: ExecCallOptions): Promise<ExecResult>;

  getFile(handle: SandboxHandle, path: string): Promise<Uint8Array>;
  putFile(handle: SandboxHandle, path: string, contents: Uint8Array): Promise<void>;

  stop(handle: SandboxHandle): Promise<void>;
  destroy(handle: SandboxHandle): Promise<void>;

  /** The registry — `sbx ls`. See spec §4.1, §4.6. */
  list(): Promise<SandboxHandle[]>;
}
