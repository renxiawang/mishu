/**
 * SandboxProvider — isolated execution-environment lifecycle.
 *
 * v0: Docker Sandboxes (sbx) microVM. `exec` is the transport the router logs
 * at the agent boundary; commands should be wrapped in `bash -c` so the
 * sandbox's persistent environment is loaded.
 *
 * Fallback: plain Docker + iptables egress. Cloud/teams later: e2b / Daytona /
 * self-hosted Firecracker.
 */
export interface SandboxHandle {
  /** Deterministic, reversible name = f(threadId). */
  name: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Streaming options for a single exec call. */
export interface ExecCallOptions {
  /** Receive raw stdout/stderr chunks as they arrive (the router logs them). */
  onChunk?: (stream: "stdout" | "stderr", chunk: string) => void;
  /** Optional input to write before closing stdin. Stdin is always closed. */
  stdin?: string;
  /** Working directory inside the sandbox (e.g. the provisioned repo clone). */
  cwd?: string;
  /** Environment values injected into the process; never logged by the router. */
  env?: Record<string, string>;
}

export interface SandboxProvider {
  create(name: string, repoRef: string): Promise<SandboxHandle>;

  /**
   * Drive the agent CLI per turn (argv wrapped in `bash -c`); the router streams
   * and logs this raw output. The reader drains stdout+stderr to exit and
   * closes stdin.
   */
  exec(handle: SandboxHandle, argv: string[], opts?: ExecCallOptions): Promise<ExecResult>;

  /** Run a raw shell command (utility ops: file reads, mkdir, $HOME, find). */
  execShell(handle: SandboxHandle, command: string, opts?: ExecCallOptions): Promise<ExecResult>;

  getFile(handle: SandboxHandle, path: string): Promise<Uint8Array>;
  putFile(handle: SandboxHandle, path: string, contents: Uint8Array): Promise<void>;

  stop(handle: SandboxHandle): Promise<void>;
  destroy(handle: SandboxHandle): Promise<void>;

  /** The registry — `sbx ls`. */
  list(): Promise<SandboxHandle[]>;
}
