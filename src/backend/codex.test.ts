import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExecResult, SandboxHandle } from "../sandbox/index.js";
import {
  CODEX_NONBLOCKING_FLAGS,
  CodexBackend,
  codexTurnArgs,
  parseCodexResult,
  parseRolloutId,
  parseSessionId,
} from "./codex.js";
import type { SandboxShellExecutor } from "./index.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

const stream = fixture("codex-json-stream.jsonl");
const errorStream = fixture("codex-error.jsonl");
const emptyStream = fixture("codex-empty.stdout.txt");
const findOutput = fixture("codex-find-output.txt");

describe("codexTurnArgs", () => {
  it("turn 1: exec --json + non-blocking flags + `--` guard, no --ephemeral/-i", () => {
    const argv = codexTurnArgs("fix the bug");
    expect(argv).toEqual([
      "codex",
      "exec",
      "--json",
      "--skip-git-repo-check",
      ...CODEX_NONBLOCKING_FLAGS,
      "--",
      "fix the bug",
    ]);
    expect(argv).not.toContain("--ephemeral");
    expect(argv).not.toContain("-i");
  });

  it("keeps the native sandbox on and approvals non-blocking (§4.5)", () => {
    const argv = codexTurnArgs("x");
    expect(argv.join(" ")).toContain("sandbox_mode=workspace-write");
    expect(argv.join(" ")).toContain("approval_policy=never");
  });

  it("follow-up: exec resume <id> <prompt> with the same flags", () => {
    expect(codexTurnArgs("more", "sess-abc")).toEqual([
      "codex",
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      ...CODEX_NONBLOCKING_FLAGS,
      "--",
      "sess-abc",
      "more",
    ]);
  });

  it("treats null/undefined sessionId as a fresh turn", () => {
    expect(codexTurnArgs("x", null)).toContain("exec");
    expect(codexTurnArgs("x", null)).not.toContain("resume");
  });
});

describe("parseCodexResult", () => {
  it("extracts the final assistant message and marks ok (success fixture)", () => {
    expect(parseCodexResult(stream)).toEqual({
      finalText: "Fixed the login timeout in auth.go and added a regression test.",
      ok: true,
    });
  });

  it("flags empty output as a failed turn (§9.14 headless regression)", () => {
    expect(parseCodexResult(emptyStream)).toEqual({ finalText: "", ok: false });
    expect(parseCodexResult("")).toEqual({ finalText: "", ok: false });
  });

  it("surfaces the codex error message on a failed turn (real fixture)", () => {
    const result = parseCodexResult(errorStream);
    expect(result.ok).toBe(false);
    expect(result.finalText).toContain("usage limit"); // relayed to the user
  });

  it("tolerates interleaved non-JSON progress lines", () => {
    const noisy = `progress: thinking...\n${stream}`;
    expect(parseCodexResult(noisy).ok).toBe(true);
  });

  it("handles the older msg-wrapped agent_message shape", () => {
    const old = '{"id":"1","msg":{"type":"agent_message","message":"done via msg shape"}}';
    expect(parseCodexResult(old)).toEqual({ finalText: "done via msg shape", ok: true });
  });

  it("handles a task_complete last_agent_message", () => {
    const done = '{"type":"turn.completed","last_agent_message":"shipped"}';
    expect(parseCodexResult(done)).toEqual({ finalText: "shipped", ok: true });
  });
});

describe("parseSessionId", () => {
  it("reads the session/thread id from the turn-1 stream", () => {
    expect(parseSessionId(stream)).toBe("7f3e9c21-4b6a-4c2d-9e1f-2a3b4c5d6e7f");
  });

  it("finds the id even on an errored turn (real thread.started, session still created)", () => {
    expect(parseSessionId(errorStream)).toBe("019e800c-958e-79e0-b7c9-9a5502563f58");
  });

  it("returns null when no id is present", () => {
    expect(
      parseSessionId('{"type":"item.completed","item":{"type":"assistant_message","text":"hi"}}'),
    ).toBeNull();
    expect(parseSessionId("")).toBeNull();
  });
});

describe("parseRolloutId", () => {
  it("extracts the UUID from a rollout filename", () => {
    expect(parseRolloutId(fixture("codex-rollout-filename.txt").trim())).toBe(
      "7f3e9c21-4b6a-4c2d-9e1f-2a3b4c5d6e7f",
    );
  });

  it("returns null for a non-rollout filename", () => {
    expect(parseRolloutId("config.toml")).toBeNull();
  });
});

describe("CodexBackend.captureSessionId (I/O via injected executor)", () => {
  const handle: SandboxHandle = { name: "t-C0-1.2" };

  const fakeExecutor = (stdout: string): SandboxShellExecutor & { lastCommand: string } => {
    const calls = { lastCommand: "" };
    return {
      get lastCommand() {
        return calls.lastCommand;
      },
      async execShell(_handle: SandboxHandle, command: string): Promise<ExecResult> {
        calls.lastCommand = command;
        return { stdout, stderr: "", exitCode: 0 };
      },
    };
  };

  it("finds the newest rollout and parses its id; $HOME stays unquoted", async () => {
    const exec = fakeExecutor(findOutput);
    const backend = new CodexBackend(exec);
    expect(await backend.captureSessionId(handle)).toBe("7f3e9c21-4b6a-4c2d-9e1f-2a3b4c5d6e7f");
    expect(exec.lastCommand).toContain("$HOME/.codex/sessions");
    expect(exec.lastCommand).toContain("rollout-*.jsonl");
  });

  it("throws when no rollout file exists", async () => {
    const backend = new CodexBackend(fakeExecutor(""));
    await expect(backend.captureSessionId(handle)).rejects.toThrow(/no rollout file/);
  });

  it("exposes the pure helpers through the interface", () => {
    const backend = new CodexBackend(fakeExecutor(""));
    expect(backend.configHome()).toBe("~/.codex");
    expect(backend.parseSessionId(stream)).toBe("7f3e9c21-4b6a-4c2d-9e1f-2a3b4c5d6e7f");
    expect(backend.parseResult(emptyStream).ok).toBe(false);
    expect(backend.events(stream)).toHaveLength(4);
  });
});
