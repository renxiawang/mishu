import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecCallOptions, ExecResult, SandboxHandle, SandboxProvider } from "./index.js";
import {
  type CreateOptions,
  cpArgv,
  createArgv,
  execAgentArgv,
  execArgv,
  lsArgv,
  parseLsJson,
  remotePath,
  rmArgv,
  secretLsArgv,
  shellQuote,
  stopArgv,
} from "./sbx-argv.js";

/**
 * SandboxProvider over the `sbx` CLI (spec §4.4) — the I/O shell. All argv
 * construction lives in sbx-argv.ts; this file only spawns and drains. The
 * spawn fn is injected so the streaming/stdin/exit handling is unit-testable
 * without the daemon.
 *
 * Also provides homeDir/readFile/writeFile (structurally satisfying the router's
 * SandboxFsLike) and execShell (the codex backend's SandboxShellExecutor) — no
 * upward imports, just compatible method shapes.
 */

/** Minimal child-process surface the drain loop needs (real ChildProcess fits). */
export interface ChildLike {
  stdout: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  stderr: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  stdin: { write(chunk: string): unknown; end(): unknown } | null;
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export type SpawnFn = (command: string, args: string[]) => ChildLike;

const defaultSpawn: SpawnFn = (command, args) =>
  nodeSpawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });

export interface SbxProviderConfig {
  spawnFn?: SpawnFn;
  bin?: string;
  createOptions?: CreateOptions;
  /** `bash -lc` to source profile-level env if `-c` isn't enough (§4.5/§9.9). */
  login?: boolean;
  /** Wrap the agent command in a PTY (codex empty-output mitigation, §9.14). */
  pty?: boolean;
}

export class SbxProvider implements SandboxProvider {
  private readonly spawnFn: SpawnFn;
  private readonly bin: string;
  private readonly createOptions: CreateOptions;
  private readonly login: boolean;
  private readonly pty: boolean;

  constructor(config: SbxProviderConfig = {}) {
    this.spawnFn = config.spawnFn ?? defaultSpawn;
    this.bin = config.bin ?? "sbx";
    this.createOptions = config.createOptions ?? {};
    this.login = config.login ?? false;
    this.pty = config.pty ?? false;
  }

  /** Spawn `sbx <argv>`, drain stdout+stderr to exit, close stdin (§9.15). */
  private run(argv: string[], opts: ExecCallOptions = {}): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = this.spawnFn(this.bin, argv);
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => {
        const text = String(chunk);
        stdout += text;
        opts.onChunk?.("stdout", text);
      });
      child.stderr?.on("data", (chunk) => {
        const text = String(chunk);
        stderr += text;
        opts.onChunk?.("stderr", text);
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
      // Close stdin so a headless agent can't hang waiting on it (§9.15).
      if (opts.stdin !== undefined) {
        child.stdin?.write(opts.stdin);
      }
      child.stdin?.end();
    });
  }

  private async runOrThrow(argv: string[], what: string): Promise<ExecResult> {
    const result = await this.run(argv);
    if (result.exitCode !== 0) {
      throw new Error(`sbx ${what} failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    return result;
  }

  async create(name: string, repoRef: string): Promise<SandboxHandle> {
    await this.runOrThrow(createArgv(name, repoRef, this.createOptions), `create ${name}`);
    return { name };
  }

  exec(handle: SandboxHandle, argv: string[], opts: ExecCallOptions = {}): Promise<ExecResult> {
    return this.run(execAgentArgv(handle.name, argv, { login: this.login, pty: this.pty }), opts);
  }

  execShell(
    handle: SandboxHandle,
    command: string,
    opts: ExecCallOptions = {},
  ): Promise<ExecResult> {
    return this.run(execArgv(handle.name, command, { login: this.login }), opts);
  }

  async stop(handle: SandboxHandle): Promise<void> {
    await this.runOrThrow(stopArgv(handle.name), `stop ${handle.name}`);
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    await this.runOrThrow(rmArgv([handle.name], { force: true }), `rm ${handle.name}`);
  }

  async list(): Promise<SandboxHandle[]> {
    const { stdout } = await this.runOrThrow(lsArgv(), "ls");
    return parseLsJson(stdout).map((entry) => ({ name: entry.name }));
  }

  /** Raw `sbx secret ls` output — drives the onboarding credential check (§4.8). */
  async secretLs(): Promise<string> {
    const { stdout } = await this.runOrThrow(secretLsArgv(), "secret ls");
    return stdout;
  }

  // --- SandboxFsLike (structural) ---------------------------------------

  async homeDir(handle: SandboxHandle): Promise<string> {
    const { stdout } = await this.execShell(handle, 'printf %s "$HOME"');
    // Defensive: take the last line in case sbx ever prefixes a start-up info
    // line on stdout (it normally routes those to stderr).
    const lines = stdout.trim().split("\n");
    return (lines[lines.length - 1] ?? "").trim() || "/root";
  }

  /** File contents, or null if the file does not exist (non-zero `cat` exit). */
  async readFile(handle: SandboxHandle, absPath: string): Promise<string | null> {
    const { stdout, exitCode } = await this.execShell(handle, `cat ${shellQuote(absPath)}`);
    return exitCode === 0 ? stdout : null;
  }

  async writeFile(handle: SandboxHandle, absPath: string, content: string): Promise<void> {
    const dir = absPath.slice(0, absPath.lastIndexOf("/"));
    if (dir !== "") {
      await this.execShell(handle, `mkdir -p ${shellQuote(dir)}`);
    }
    await this.putFile(handle, absPath, new TextEncoder().encode(content));
  }

  // --- binary file transfer via `sbx cp` + a host temp file -------------

  private tempPath(): string {
    return join(tmpdir(), `sbx-${randomUUID()}`);
  }

  async getFile(handle: SandboxHandle, path: string): Promise<Uint8Array> {
    const tmp = this.tempPath();
    await this.runOrThrow(cpArgv(remotePath(handle.name, path), tmp), `cp (get) ${path}`);
    try {
      return await readFile(tmp);
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async putFile(handle: SandboxHandle, path: string, contents: Uint8Array): Promise<void> {
    const tmp = this.tempPath();
    await writeFile(tmp, contents);
    try {
      await this.runOrThrow(cpArgv(tmp, remotePath(handle.name, path)), `cp (put) ${path}`);
    } finally {
      await rm(tmp, { force: true });
    }
  }
}
