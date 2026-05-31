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

export interface SandboxProvider {
  create(name: string, repoRef: string): Promise<SandboxHandle>;

  /** Drive the agent CLI per turn; the router streams and logs this raw output (§4.9). */
  exec(handle: SandboxHandle, argv: string[]): Promise<ExecResult>;

  getFile(handle: SandboxHandle, path: string): Promise<Uint8Array>;
  putFile(handle: SandboxHandle, path: string, contents: Uint8Array): Promise<void>;

  stop(handle: SandboxHandle): Promise<void>;
  destroy(handle: SandboxHandle): Promise<void>;

  /** The registry — `sbx ls`. See spec §4.1, §4.6. */
  list(): Promise<SandboxHandle[]>;
}
