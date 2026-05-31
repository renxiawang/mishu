/**
 * Pure argv builders for the `sbx` CLI (spec §4.4/§4.5).
 *
 * The SandboxProvider I/O shell (sbx-provider.ts) shells out `sbx <argv>`; this
 * file owns the argv construction so it's testable without the daemon. Verified
 * against sbx v0.31.1 — re-check on every upgrade (§9, substrate risk).
 *
 * Two load-bearing rules baked in here:
 *  - `--clone` on create: the agent works on a private in-VM clone, never the
 *    live host working tree (§4.4).
 *  - `exec` is wrapped in `bash -c`: `sbx exec` runs with no shell and does not
 *    source the sandbox's persistent environment, so the toolchain/agent PATH
 *    may be missing otherwise (§4.5). We also never pass `-i` (the provider
 *    closes stdin so codex can't hang — §9.15).
 */

// ---------------------------------------------------------------------------
// Shell quoting (the bug-prone part — a wrong quote makes "works interactively
// / fails headless" bugs). POSIX single-quoting so `bash -c <shellJoin(argv)>`
// reparses to exactly `argv`.
// ---------------------------------------------------------------------------

/** Chars safe to leave unquoted in a POSIX shell word. */
const BARE_WORD = /^[A-Za-z0-9_/.:=@%+,-]+$/;

export function shellQuote(arg: string): string {
  if (arg === "") {
    return "''";
  }
  if (BARE_WORD.test(arg)) {
    return arg;
  }
  // Close the quote, emit an escaped ', reopen: ' -> '\''
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Quote an argv into a single shell command string. */
export function shellJoin(argv: string[]): string {
  return argv.map(shellQuote).join(" ");
}

/**
 * Wrap a command so the child gets a pseudo-TTY, mitigating codex's headless
 * empty-output regression (§9.14). util-linux `script` syntax (Linux/in-VM);
 * confirm live which mitigation we keep.
 */
export function ptyCommand(command: string): string {
  return `script -qec ${shellQuote(command)} /dev/null`;
}

// ---------------------------------------------------------------------------
// create / exec
// ---------------------------------------------------------------------------

export interface CreateOptions {
  /** Agent kind sbx wires auth for. Default "codex" (§4.5). */
  agent?: string;
  /** Private in-VM clone vs the rw bind-mount. Default true — never edit the host tree (§4.4). */
  clone?: boolean;
  template?: string;
  kits?: string[];
}

export function createArgv(name: string, repoRef: string, opts: CreateOptions = {}): string[] {
  const { agent = "codex", clone = true, template, kits = [] } = opts;
  const argv = ["create"];
  if (clone) {
    argv.push("--clone");
  }
  argv.push("--name", name);
  if (template !== undefined) {
    argv.push("--template", template);
  }
  for (const kit of kits) {
    argv.push("--kit", kit);
  }
  argv.push(agent, repoRef);
  return argv;
}

export interface ExecOptions {
  env?: Record<string, string>;
  workdir?: string;
  /** Login shell (`bash -lc`) to source profile-level env if `-c` isn't enough (§4.5). */
  login?: boolean;
  /** Wrap the command in a PTY (§9.14). */
  pty?: boolean;
}

/**
 * `sbx exec <name> -- bash -c '<command>'`. `command` is a shell string (build
 * it from an agent argv with shellJoin). No `-i`: stdin stays closed (§9.15).
 * The `--` stops sbx flag parsing so the command's own flags pass through.
 */
export function execArgv(name: string, command: string, opts: ExecOptions = {}): string[] {
  const argv = ["exec"];
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    argv.push("-e", `${key}=${value}`);
  }
  if (opts.workdir !== undefined) {
    argv.push("-w", opts.workdir);
  }
  const inner = opts.pty === true ? ptyCommand(command) : command;
  argv.push(name, "--", "bash", opts.login === true ? "-lc" : "-c", inner);
  return argv;
}

/** Build an `exec` argv directly from an agent argv (quote + wrap). */
export function execAgentArgv(name: string, agentArgv: string[], opts: ExecOptions = {}): string[] {
  return execArgv(name, shellJoin(agentArgv), opts);
}

// ---------------------------------------------------------------------------
// ls (the registry, §4.1)
// ---------------------------------------------------------------------------

export function lsArgv(): string[] {
  return ["ls", "--json"];
}

export function lsNamesArgv(): string[] {
  return ["ls", "-q"];
}

export interface SbxListEntry {
  name: string;
  status?: string;
  agent?: string;
  workspace?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function strOrUndef(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Parse `sbx ls --json`. The exact field names are confirmed live (§9); this is
 * tolerant of both a top-level array and a `{ sandboxes: [...] }` wrapper, and
 * skips entries without a string `name`.
 */
export function parseLsJson(stdout: string): SbxListEntry[] {
  const trimmed = stdout.trim();
  if (trimmed === "") {
    return [];
  }
  const data: unknown = JSON.parse(trimmed);
  const items: unknown[] = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.sandboxes)
      ? data.sandboxes
      : [];
  const entries: SbxListEntry[] = [];
  for (const item of items) {
    if (isRecord(item) && typeof item.name === "string") {
      entries.push({
        name: item.name,
        status: strOrUndef(item.status),
        agent: strOrUndef(item.agent),
        workspace: strOrUndef(item.workspace),
      });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// cp (getFile / putFile, §4.6) / stop / rm
// ---------------------------------------------------------------------------

/** `SANDBOX:PATH` addressing for `sbx cp`. */
export function remotePath(name: string, path: string): string {
  return `${name}:${path}`;
}

export function cpArgv(src: string, dst: string): string[] {
  return ["cp", src, dst];
}

export function stopArgv(...names: string[]): string[] {
  return ["stop", ...names];
}

export function rmArgv(names: string[], opts: { force?: boolean } = {}): string[] {
  return ["rm", ...(opts.force === true ? ["--force"] : []), ...names];
}

// ---------------------------------------------------------------------------
// secret (onboarding/auth detection, §4.7/§4.8)
// ---------------------------------------------------------------------------

export function secretLsArgv(): string[] {
  return ["secret", "ls"];
}

export interface SecretSetOptions {
  /** Host-global (shared by every future sandbox). Default true (§4.8). */
  global?: boolean;
  /** OAuth/browser flow (e.g. `openai --oauth`); else the value is piped via stdin. */
  oauth?: boolean;
}

export function secretSetArgv(service: string, opts: SecretSetOptions = {}): string[] {
  const { global = true, oauth = false } = opts;
  const argv = ["secret", "set"];
  if (global) {
    argv.push("-g");
  }
  if (oauth) {
    argv.push("--oauth");
  }
  argv.push(service);
  return argv;
}

export function secretRmArgv(service: string, opts: { global?: boolean } = {}): string[] {
  return ["secret", "rm", ...(opts.global === true ? ["-g"] : []), service];
}
