import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandRunOptions {
  timeoutMs?: number;
}

export type CommandRunner = (
  command: string,
  args: string[],
  opts?: CommandRunOptions,
) => Promise<CommandResult>;

export interface DockerfileTemplateOptions {
  runner?: CommandRunner;
  log?: (message: string) => void;
}

export interface PreparedDockerfileTemplate {
  dockerfile: string;
  tag: string;
}

const TEMPLATE_REPO = "mishu-local-template";
const DOCKER_INFO_TIMEOUT_MS = 10_000;

export function templateTagForDockerfile(dockerfile: string): string {
  const absolute = resolve(dockerfile);
  const hash = createHash("sha256").update(absolute).digest("hex").slice(0, 16);
  return `${TEMPLATE_REPO}:${hash}`;
}

export const defaultCommandRunner: CommandRunner = (command, args, opts = {}) =>
  new Promise((resolveCommand, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill();
          }, opts.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      const timeoutMessage = timedOut ? `Timed out after ${opts.timeoutMs}ms` : "";
      resolveCommand({
        stdout,
        stderr: [stderr, timeoutMessage].filter((part) => part !== "").join("\n"),
        exitCode: timedOut ? -1 : (code ?? -1),
      });
    });
  });

function commandForLog(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

async function runOrThrow(
  runner: CommandRunner,
  command: string,
  args: string[],
  opts?: CommandRunOptions,
): Promise<void> {
  const result = await runner(command, args, opts);
  if (result.exitCode !== 0) {
    const output = [result.stderr.trim(), result.stdout.trim()].filter((part) => part !== "");
    const detail = output.length > 0 ? `: ${output.join("\n")}` : "";
    throw new Error(`${commandForLog(command, args)} failed (exit ${result.exitCode})${detail}`);
  }
}

async function assertDockerDaemonAvailable(runner: CommandRunner): Promise<void> {
  const result = await runner("docker", ["image", "ls", "--format", "{{.ID}}"], {
    timeoutMs: DOCKER_INFO_TIMEOUT_MS,
  });
  if (result.exitCode === 0) {
    return;
  }

  const output = [result.stderr.trim(), result.stdout.trim()].filter((part) => part !== "");
  const detail = output.length > 0 ? `\n${output.join("\n")}` : "";
  throw new Error(
    `Docker daemon is not available. Start Docker Desktop, then restart Mishu.${detail}`,
  );
}

export async function prepareDockerfileTemplate(
  dockerfile: string,
  opts: DockerfileTemplateOptions = {},
): Promise<PreparedDockerfileTemplate> {
  const runner = opts.runner ?? defaultCommandRunner;
  const absoluteDockerfile = resolve(dockerfile);
  const contextDir = dirname(absoluteDockerfile);
  const tag = templateTagForDockerfile(absoluteDockerfile);

  await access(absoluteDockerfile);
  await assertDockerDaemonAvailable(runner);

  opts.log?.(`[mishu] building sandbox template ${tag} from ${absoluteDockerfile}`);
  await runOrThrow(runner, "docker", ["build", "-f", absoluteDockerfile, "-t", tag, contextDir]);

  const tempDir = await mkdtemp(join(tmpdir(), "mishu-template-"));
  const tarPath = join(tempDir, "template.tar");
  try {
    opts.log?.(`[mishu] exporting sandbox template ${tag}`);
    await runOrThrow(runner, "docker", ["save", "-o", tarPath, tag]);

    opts.log?.(`[mishu] loading sandbox template ${tag} into sbx`);
    await runner("sbx", ["template", "rm", tag]);
    await runOrThrow(runner, "sbx", ["template", "load", tarPath]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  return { dockerfile: absoluteDockerfile, tag };
}
