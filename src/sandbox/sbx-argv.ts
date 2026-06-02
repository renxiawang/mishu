/**
 * Pure argv builders for the `sbx` CLI.
 *
 * The SandboxProvider I/O shell (sbx-provider.ts) shells out `sbx <argv>`; this
 * file owns the argv construction so it's testable without the daemon. Verified
 * against sbx v0.31.1 — re-check on every upgrade (substrate risk).
 *
 * Two load-bearing rules baked in here:
 *  - `--clone` on create: the agent works on a private in-VM clone, never the
 *    live host working tree.
 *  - `exec` is wrapped in `bash -c`: `sbx exec` runs with no shell and does not
 *    source the sandbox's persistent environment, so the toolchain/agent PATH
 *    may be missing otherwise. We also never pass `-i` (the provider
 *    closes stdin so codex can't hang).
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
 * empty-output regression. util-linux `script` syntax (Linux/in-VM);
 * confirm live which mitigation we keep.
 */
export function ptyCommand(command: string): string {
  return `script -qec ${shellQuote(command)} /dev/null`;
}

// ---------------------------------------------------------------------------
// create / exec
// ---------------------------------------------------------------------------

export interface CreateOptions {
  /** Agent kind sbx wires auth for. Default "codex". */
  agent?: string;
  /** Private in-VM clone vs the rw bind-mount. Default true — never edit the host tree. */
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
  /** Login shell (`bash -lc`) to source profile-level env if `-c` isn't enough. */
  login?: boolean;
  /** Wrap the command in a PTY. */
  pty?: boolean;
  /**
   * Redirect the in-VM command's stdin from /dev/null (default true).
   *
   * VERIFIED LIVE: `sbx exec` keeps the VM process's stdin open even when
   * the host closes its end, so a headless agent like `codex exec` blocks on
   * "Reading additional input from stdin..." forever. Redirecting stdin from
   * /dev/null IN the VM gives it an immediate EOF. Closing host stdin (the
   * provider also does that) is necessary but NOT sufficient on its own. Ignored
   * under `pty` (the TTY supplies stdin).
   */
  stdinFromNull?: boolean;
}

/**
 * `sbx exec <name> -- bash -c '<command> < /dev/null'`. `command` is a shell
 * string (build it from an agent argv with shellJoin). No `-i`, and stdin is
 * redirected from /dev/null in-VM so headless agents can't hang. The
 * `--` stops sbx flag parsing so the command's own flags pass through.
 */
export function execArgv(name: string, command: string, opts: ExecOptions = {}): string[] {
  const argv = ["exec"];
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    argv.push("-e", `${key}=${value}`);
  }
  if (opts.workdir !== undefined) {
    argv.push("-w", opts.workdir);
  }
  let inner: string;
  if (opts.pty === true) {
    inner = ptyCommand(command);
  } else if (opts.stdinFromNull === false) {
    inner = command;
  } else {
    inner = `${command} < /dev/null`;
  }
  argv.push(name, "--", "bash", opts.login === true ? "-lc" : "-c", inner);
  return argv;
}

/** Build an `exec` argv directly from an agent argv (quote + wrap). */
export function execAgentArgv(name: string, agentArgv: string[], opts: ExecOptions = {}): string[] {
  return execArgv(name, shellJoin(agentArgv), opts);
}

// ---------------------------------------------------------------------------
// ls (the registry)
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
 * Parse `sbx ls --json`. Tolerant of both a top-level array and a
 * `{ sandboxes: [...] }` wrapper, and skips entries without a string `name`.
 *
 * VERIFIED LIVE: sbx prepends human-readable lines (e.g. "Starting sandboxd
 * daemon...") to stdout before the JSON when it auto-starts the daemon, so we
 * parse from the first `{`/`[` and never throw — a malformed list yields [].
 */
export function parseLsJson(stdout: string): SbxListEntry[] {
  const trimmed = stdout.trim();
  const start = trimmed.search(/[[{]/);
  if (start < 0) {
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(trimmed.slice(start));
  } catch {
    return [];
  }
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
// cp (getFile / putFile) / stop / rm
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
// secret (onboarding/auth detection)
// ---------------------------------------------------------------------------

export function secretLsArgv(): string[] {
  return ["secret", "ls"];
}

export interface SecretSetOptions {
  /** Host-global (shared by every future sandbox). Default true. */
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
