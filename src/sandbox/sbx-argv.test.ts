import { execFileSync } from "node:child_process";
import {
  cpArgv,
  createArgv,
  execAgentArgv,
  execArgv,
  lsArgv,
  lsNamesArgv,
  parseLsJson,
  ptyCommand,
  remotePath,
  rmArgv,
  secretLsArgv,
  secretRmArgv,
  secretSetArgv,
  shellJoin,
  shellQuote,
  stopArgv,
} from "./sbx-argv.js";

describe("createArgv", () => {
  it("always uses --clone and the codex agent by default", () => {
    expect(createArgv("t-C0-1.2", "/repo")).toEqual([
      "create",
      "--clone",
      "--name",
      "t-C0-1.2",
      "codex",
      "/repo",
    ]);
  });

  it("threads template + kits and can disable clone", () => {
    expect(
      createArgv("box", "/repo", {
        agent: "claude",
        clone: false,
        template: "myreg/codex-snowball",
        kits: ["./kit-a", "./kit-b"],
      }),
    ).toEqual([
      "create",
      "--name",
      "box",
      "--template",
      "myreg/codex-snowball",
      "--kit",
      "./kit-a",
      "--kit",
      "./kit-b",
      "claude",
      "/repo",
    ]);
  });

  it("omits --template for an empty template value", () => {
    expect(createArgv("box", "/repo", { template: "" })).toEqual([
      "create",
      "--clone",
      "--name",
      "box",
      "codex",
      "/repo",
    ]);
  });
});

describe("execArgv", () => {
  it("wraps in `bash -c`, uses `--`, redirects stdin from /dev/null, no -i", () => {
    expect(execArgv("box", "codex exec --json")).toEqual([
      "exec",
      "box",
      "--",
      "bash",
      "-c",
      "codex exec --json < /dev/null",
    ]);
    expect(execArgv("box", "x")).not.toContain("-i");
  });

  it("stdinFromNull:false omits the /dev/null redirect", () => {
    expect(execArgv("box", "cmd", { stdinFromNull: false }).at(-1)).toBe("cmd");
  });

  it("supports login shell, workdir, env, and the PTY mitigation", () => {
    expect(execArgv("box", "cmd", { login: true })).toContain("-lc");
    expect(execArgv("box", "cmd", { workdir: "/repo" })).toEqual([
      "exec",
      "-w",
      "/repo",
      "box",
      "--",
      "bash",
      "-c",
      "cmd < /dev/null",
    ]);
    expect(execArgv("box", "cmd", { env: { FOO: "bar" } })).toEqual([
      "exec",
      "-e",
      "FOO=bar",
      "box",
      "--",
      "bash",
      "-c",
      "cmd < /dev/null",
    ]);
    // Under pty the TTY supplies stdin — no /dev/null redirect.
    const pty = execArgv("box", "codex exec", { pty: true });
    expect(pty[pty.length - 1]).toBe(ptyCommand("codex exec"));
  });

  it("execAgentArgv quotes an agent argv into the bash -c string (+ stdin redirect)", () => {
    expect(execAgentArgv("box", ["codex", "exec", "fix the bug"])).toEqual([
      "exec",
      "box",
      "--",
      "bash",
      "-c",
      "codex exec 'fix the bug' < /dev/null",
    ]);
  });
});

describe("shellQuote / shellJoin", () => {
  it("leaves safe words bare and quotes the rest", () => {
    expect(shellQuote("codex")).toBe("codex");
    expect(shellQuote("--json")).toBe("--json");
    expect(shellQuote("/home/u/.codex")).toBe("/home/u/.codex");
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("$HOME")).toBe("'$HOME'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  // The strong guarantee: bash must reparse shellJoin(argv) back into argv.
  const reparse = (argv: string[]): string[] => {
    const out = execFileSync("bash", ["-c", `printf '%s\\0' ${shellJoin(argv)}`], {
      encoding: "utf8",
    });
    const parts = out.split("\0");
    parts.pop(); // trailing "" after the final NUL
    return parts;
  };

  it("round-trips a hostile argv table through real bash", () => {
    const table: string[][] = [
      ["codex", "exec", "--json"],
      ["a b", "it's", 'say "hi"'],
      ["use $HOME", "back`tick`", "semi;colon", "and && or", "pipe|x"],
      ["line\nbreak", "tab\there", "glob*?[x]", "-n", "--", ""],
      ["fix the bug: $(rm -rf /)", "emoji 🚀", "{brace}", "~tilde"],
    ];
    for (const argv of table) {
      expect(reparse(argv)).toEqual(argv);
    }
  });
});

describe("ls + parseLsJson", () => {
  it("builds ls argv variants", () => {
    expect(lsArgv()).toEqual(["ls", "--json"]);
    expect(lsNamesArgv()).toEqual(["ls", "-q"]);
  });

  it("parses a top-level array", () => {
    const json = JSON.stringify([
      { name: "t-C0-1.2", status: "running", agent: "codex", workspace: "/repo" },
      { name: "_login-tmp", status: "stopped" },
    ]);
    expect(parseLsJson(json)).toEqual([
      { name: "t-C0-1.2", status: "running", agent: "codex", workspace: "/repo" },
      { name: "_login-tmp", status: "stopped", agent: undefined, workspace: undefined },
    ]);
  });

  it("parses a { sandboxes: [...] } wrapper and skips entries without a name", () => {
    const json = JSON.stringify({ sandboxes: [{ name: "box" }, { status: "running" }] });
    expect(parseLsJson(json)).toEqual([
      { name: "box", status: undefined, agent: undefined, workspace: undefined },
    ]);
  });

  it("returns [] for empty output", () => {
    expect(parseLsJson("")).toEqual([]);
    expect(parseLsJson("   \n")).toEqual([]);
  });

  it("tolerates sbx info lines prepended before the JSON", () => {
    const noisy =
      'Starting sandboxd daemon...\nDaemon started.\n{"sandboxes":[{"name":"t-C0-1.2"}]}';
    expect(parseLsJson(noisy)).toEqual([
      { name: "t-C0-1.2", status: undefined, agent: undefined, workspace: undefined },
    ]);
  });

  it("returns [] (never throws) on output with no JSON", () => {
    expect(parseLsJson("Starting sandboxd daemon...\nno json here")).toEqual([]);
  });
});

describe("cp / stop / rm", () => {
  it("addresses sandbox paths and builds cp argv", () => {
    expect(remotePath("box", "/home/u/.agent-state/session")).toBe(
      "box:/home/u/.agent-state/session",
    );
    expect(cpArgv("box:/a", "./a")).toEqual(["cp", "box:/a", "./a"]);
  });

  it("stops one or many, removes with --force for non-interactive use", () => {
    expect(stopArgv("box")).toEqual(["stop", "box"]);
    expect(stopArgv("a", "b")).toEqual(["stop", "a", "b"]);
    expect(rmArgv(["box"], { force: true })).toEqual(["rm", "--force", "box"]);
    expect(rmArgv(["box"])).toEqual(["rm", "box"]);
  });
});

describe("secret (onboarding/auth)", () => {
  it("lists, sets (global oauth / global stdin), and removes", () => {
    expect(secretLsArgv()).toEqual(["secret", "ls"]);
    expect(secretSetArgv("openai", { oauth: true })).toEqual([
      "secret",
      "set",
      "-g",
      "--oauth",
      "openai",
    ]);
    expect(secretSetArgv("openai")).toEqual(["secret", "set", "-g", "openai"]);
    expect(secretSetArgv("openai", { global: false })).toEqual(["secret", "set", "openai"]);
    expect(secretRmArgv("openai", { global: true })).toEqual(["secret", "rm", "-g", "openai"]);
  });
});
