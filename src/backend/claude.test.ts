import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExecResult, SandboxHandle } from "../sandbox/index.js";
import {
  CLAUDE_NONBLOCKING_FLAGS,
  ClaudeBackend,
  claudeEvents,
  claudeTurnArgs,
  newestSessionPath,
  parseClaudeResult,
  parseClaudeSessionFilename,
  parseClaudeSessionId,
} from "./claude.js";
import type { SandboxShellExecutor } from "./index.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

const stream = fixture("claude-stream.jsonl");
const errorStream = fixture("claude-error.jsonl");
const emptyStream = fixture("claude-empty.stdout.txt");
const findOutput = fixture("claude-find-output.txt");

const SESSION_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

describe("claudeTurnArgs", () => {
  it("turn 1: -p stream-json + --verbose + non-blocking flags + `--` guard, no --resume", () => {
    const argv = claudeTurnArgs("fix the bug");
    expect(argv).toEqual([
      "claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      ...CLAUDE_NONBLOCKING_FLAGS,
      "--",
      "fix the bug",
    ]);
    expect(argv).not.toContain("--resume");
  });

  it("requires --verbose with stream-json and skips permission prompts headlessly", () => {
    const argv = claudeTurnArgs("x");
    expect(argv).toContain("--verbose");
    expect(argv.join(" ")).toContain("--output-format stream-json");
    expect(argv).toContain("--dangerously-skip-permissions");
  });

  it("follow-up: --resume <id> -- <prompt> with the same flags", () => {
    expect(claudeTurnArgs("more", "sess-abc")).toEqual([
      "claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      ...CLAUDE_NONBLOCKING_FLAGS,
      "--resume",
      "sess-abc",
      "--",
      "more",
    ]);
  });

  it("treats null/undefined sessionId as a fresh turn", () => {
    expect(claudeTurnArgs("x", null)).not.toContain("--resume");
    expect(claudeTurnArgs("x", undefined)).not.toContain("--resume");
  });
});

describe("parseClaudeResult", () => {
  it("extracts the final result text and marks ok (success fixture)", () => {
    expect(parseClaudeResult(stream)).toEqual({
      finalText: "Fixed the login timeout in auth.go and added a regression test.",
      ok: true,
    });
  });

  it("flags empty output as a failed turn (headless empty-output regression)", () => {
    expect(parseClaudeResult(emptyStream)).toEqual({ finalText: "", ok: false });
    expect(parseClaudeResult("")).toEqual({ finalText: "", ok: false });
  });

  it("surfaces the claude error message on a failed turn (real fixture)", () => {
    // Real capture: an is_error:true result whose subtype is nonetheless "success"
    // (so we key on is_error, never subtype). The result text is relayed.
    const result = parseClaudeResult(errorStream);
    expect(result.ok).toBe(false);
    expect(result.finalText).toContain("Not logged in"); // relayed to the user
  });

  it("tolerates interleaved non-JSON progress lines", () => {
    const noisy = `warming up...\n${stream}`;
    expect(parseClaudeResult(noisy).ok).toBe(true);
  });

  it("falls back to the last assistant text when no result event is present", () => {
    const aborted =
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"partial answer"}]},"session_id":"x"}';
    expect(parseClaudeResult(aborted)).toEqual({ finalText: "partial answer", ok: true });
  });

  it("synthesizes an error from the subtype when an errored result carries no text", () => {
    const maxTurns =
      '{"type":"result","subtype":"error_max_turns","is_error":true,"session_id":"x"}';
    expect(parseClaudeResult(maxTurns)).toEqual({ finalText: "error_max_turns", ok: false });
  });
});

describe("parseClaudeSessionId", () => {
  it("reads the session id from the init line of the stream", () => {
    expect(parseClaudeSessionId(stream)).toBe(SESSION_ID);
  });

  it("finds the id even on an errored turn (session still created)", () => {
    expect(parseClaudeSessionId(errorStream)).toBe("baa1bd5f-51eb-4ee1-8b52-4d2872998728");
  });

  it("returns null when no id is present", () => {
    expect(parseClaudeSessionId('{"type":"assistant","message":{"content":[]}}')).toBeNull();
    expect(parseClaudeSessionId("")).toBeNull();
  });
});

describe("parseClaudeSessionFilename / newestSessionPath", () => {
  it("extracts the UUID from a transcript filename", () => {
    expect(parseClaudeSessionFilename(fixture("claude-session-filename.txt").trim())).toBe(
      SESSION_ID,
    );
  });

  it("returns null for a non-session filename", () => {
    expect(parseClaudeSessionFilename("config.json")).toBeNull();
    expect(parseClaudeSessionFilename("notes.jsonl")).toBeNull();
  });

  it("picks the path with the greatest mtime", () => {
    expect(newestSessionPath(findOutput)).toBe(
      `/root/.claude/projects/-root-repo/${SESSION_ID}.jsonl`,
    );
    expect(newestSessionPath("")).toBeNull();
  });
});

describe("claudeEvents", () => {
  it("parses every JSON line and degrades gracefully on garbage", () => {
    expect(claudeEvents(stream)).toHaveLength(5);
    expect(claudeEvents("not json\n{bad}\n")).toEqual([]);
  });
});

describe("ClaudeBackend.captureSessionId (I/O via injected executor)", () => {
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

  it("finds the newest transcript and parses its id; $HOME stays unquoted", async () => {
    const exec = fakeExecutor(findOutput);
    const backend = new ClaudeBackend(exec);
    expect(await backend.captureSessionId(handle)).toBe(SESSION_ID);
    expect(exec.lastCommand).toContain("$HOME/.claude/projects");
    expect(exec.lastCommand).toContain("*.jsonl");
  });

  it("throws when no transcript file exists", async () => {
    const backend = new ClaudeBackend(fakeExecutor(""));
    await expect(backend.captureSessionId(handle)).rejects.toThrow(/no session transcript/);
  });

  it("exposes the pure helpers through the interface", () => {
    const backend = new ClaudeBackend(fakeExecutor(""));
    expect(backend.configHome()).toBe("~/.claude");
    expect(backend.parseSessionId(stream)).toBe(SESSION_ID);
    expect(backend.parseResult(emptyStream).ok).toBe(false);
    expect(backend.events(stream)).toHaveLength(5);
  });
});
