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

export function shellJoin(argv: string[]): string {
  return argv.map(shellQuote).join(" ");
}

export function ptyCommand(command: string): string {
  return `script -qec ${shellQuote(command)} /dev/null`;
}

export interface CreateOptions {
  agent?: string;
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
  if (template !== undefined && template !== "") {
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
  login?: boolean;
  pty?: boolean;
  stdinFromNull?: boolean;
}

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

export function execAgentArgv(name: string, agentArgv: string[], opts: ExecOptions = {}): string[] {
  return execArgv(name, shellJoin(agentArgv), opts);
}

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

export function secretLsArgv(): string[] {
  return ["secret", "ls"];
}

export interface SecretSetOptions {
  global?: boolean;
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
