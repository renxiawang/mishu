import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExecResult, SandboxHandle } from "../sandbox/index.js";
import type { SandboxShellExecutor } from "./index.js";
import {
  PiBackend,
  parsePiResult,
  parsePiSessionFilename,
  parsePiSessionId,
  piTurnArgs,
} from "./pi.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

const stream = fixture("pi-stream.jsonl");
const errorStream = fixture("pi-error.jsonl");
const findOutput = fixture("pi-find-output.txt");
const SESSION_ID = "019f2dc0-89bd-7ca1-a2d5-9bcb2d72e143";

describe("piTurnArgs", () => {
  it("turn 1: json mode, no session flag", () => {
    expect(piTurnArgs("fix the bug")).toEqual(["pi", "--mode", "json", "fix the bug"]);
  });

  it("follow-up: resumes the same Pi session", () => {
    expect(piTurnArgs("more", "sess-abc")).toEqual([
      "pi",
      "--mode",
      "json",
      "--session",
      "sess-abc",
      "more",
    ]);
  });

  it("adds the selected provider and model when configured", () => {
    expect(piTurnArgs("x", null, { model: "openai/gpt-4o-mini", provider: "openai" })).toEqual([
      "pi",
      "--mode",
      "json",
      "--provider",
      "openai",
      "--model",
      "openai/gpt-4o-mini",
      "x",
    ]);
  });
});

describe("parsePiResult", () => {
  it("extracts the final turn_end assistant text", () => {
    expect(parsePiResult(stream)).toEqual({
      finalText: "Fixed the issue and added tests.",
      ok: true,
    });
  });

  it("falls back to the last assistant message_end text", () => {
    const captured =
      '{"type":"message_end","message":{"role":"assistant","content":"partial answer"}}';
    expect(parsePiResult(captured)).toEqual({ finalText: "partial answer", ok: true });
  });

  it("surfaces an errored turn as a failed result", () => {
    expect(parsePiResult(errorStream)).toEqual({
      finalText: "Missing provider API key",
      ok: false,
    });
  });

  it("surfaces Pi provider errorMessage values", () => {
    const captured = [
      `{"type":"session","version":3,"id":"${SESSION_ID}","cwd":"/tmp"}`,
      '{"type":"turn_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"401 invalid x-api-key"},"toolResults":[]}',
    ].join("\n");
    expect(parsePiResult(captured)).toEqual({
      finalText: "401 invalid x-api-key",
      ok: false,
    });
  });

  it("surfaces Pi plain-text startup errors after a JSON session header", () => {
    const captured = [
      `{"type":"session","version":3,"id":"${SESSION_ID}","cwd":"/tmp"}`,
      "No API key found for the selected model.",
      "",
      "Use /login to log into a provider via OAuth or API key.",
    ].join("\n");
    expect(parsePiResult(captured)).toEqual({
      finalText:
        "No API key found for the selected model.\nUse /login to log into a provider via OAuth or API key.",
      ok: false,
    });
  });

  it("flags empty output as a failed turn", () => {
    expect(parsePiResult("")).toEqual({ finalText: "", ok: false });
  });
});

describe("parsePiSessionId", () => {
  it("reads the documented session header id", () => {
    expect(parsePiSessionId(stream)).toBe(SESSION_ID);
  });

  it("returns null when no session header is present", () => {
    expect(parsePiSessionId('{"type":"turn_start"}')).toBeNull();
  });
});

describe("parsePiSessionFilename", () => {
  it("extracts the id from a session filename", () => {
    expect(parsePiSessionFilename(fixture("pi-session-filename.txt").trim())).toBe(SESSION_ID);
  });

  it("returns null for a non-session filename", () => {
    expect(parsePiSessionFilename("settings.json")).toBeNull();
  });
});

describe("PiBackend", () => {
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

  it("returns configured API-key env without putting it in argv", () => {
    const backend = new PiBackend(fakeExecutor(""), {
      env: { ANTHROPIC_API_KEY: "secret-value" },
      model: "anthropic/claude-sonnet-4.5",
      provider: "anthropic",
    });
    expect(backend.turnEnv()).toEqual({ ANTHROPIC_API_KEY: "secret-value" });
    expect(backend.turnArgs("x")).toEqual([
      "pi",
      "--mode",
      "json",
      "--provider",
      "anthropic",
      "--model",
      "anthropic/claude-sonnet-4.5",
      "x",
    ]);
    expect(backend.turnArgs("x").join(" ")).not.toContain("secret-value");
  });

  it("finds the newest session transcript and parses its id", async () => {
    const exec = fakeExecutor(findOutput);
    const backend = new PiBackend(exec);
    expect(await backend.captureSessionId(handle)).toBe(SESSION_ID);
    expect(exec.lastCommand).toContain("$HOME/.pi/agent/sessions");
  });

  it("throws when no transcript exists", async () => {
    const backend = new PiBackend(fakeExecutor(""));
    await expect(backend.captureSessionId(handle)).rejects.toThrow(/no session transcript/);
  });
});
