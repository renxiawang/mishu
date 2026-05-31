import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import type { SandboxHandle } from "./index.js";
import { type ChildLike, SbxProvider, type SpawnFn } from "./sbx-provider.js";

class FakeStdin {
  written = "";
  ended = false;
  write(chunk: string): boolean {
    this.written += chunk;
    return true;
  }
  end(): void {
    this.ended = true;
  }
}

class FakeChild extends EventEmitter implements ChildLike {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = new FakeStdin();
}

type Resp = { stdout?: string; stderr?: string; code?: number; error?: Error };

function fakeSpawn(responder: (args: string[]) => Resp): {
  spawnFn: SpawnFn;
  calls: { args: string[]; stdin: FakeStdin }[];
} {
  const calls: { args: string[]; stdin: FakeStdin }[] = [];
  const spawnFn: SpawnFn = (_command, args) => {
    const child = new FakeChild();
    calls.push({ args, stdin: child.stdin });
    const r = responder(args);
    setImmediate(() => {
      if (r.error) {
        child.emit("error", r.error);
        return;
      }
      if (r.stdout) {
        child.stdout.emit("data", Buffer.from(r.stdout));
      }
      if (r.stderr) {
        child.stderr.emit("data", Buffer.from(r.stderr));
      }
      child.emit("close", r.code ?? 0);
    });
    return child;
  };
  return { spawnFn, calls };
}

const handle: SandboxHandle = { name: "t-C0ABCDEF-1748600000.123456" };

describe("exec — drain, stdin close, streaming (§4.9/§9.15)", () => {
  it("wraps argv in bash -c (no -i), drains stdout+stderr, closes stdin, streams chunks", async () => {
    let recorded: string[] = [];
    let stdin: FakeStdin | undefined;
    const spawnFn: SpawnFn = (_c, args) => {
      recorded = args;
      const child = new FakeChild();
      stdin = child.stdin;
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from("Fixed "));
        child.stdout.emit("data", Buffer.from("the bug"));
        child.stderr.emit("data", Buffer.from("progress\n"));
        child.emit("close", 0);
      });
      return child;
    };
    const provider = new SbxProvider({ spawnFn });
    const chunks: string[] = [];
    const result = await provider.exec(handle, ["codex", "exec", "fix the bug"], {
      onChunk: (stream, chunk) => chunks.push(`${stream}:${chunk}`),
    });

    expect(result).toEqual({ stdout: "Fixed the bug", stderr: "progress\n", exitCode: 0 });
    expect(recorded).toEqual(["exec", handle.name, "--", "bash", "-c", "codex exec 'fix the bug'"]);
    expect(recorded).not.toContain("-i");
    expect(stdin?.ended).toBe(true);
    expect(chunks).toEqual(["stdout:Fixed ", "stdout:the bug", "stderr:progress\n"]);
  });

  it("propagates a non-zero exit code without throwing (agent failures interpreted upstream)", async () => {
    const { spawnFn } = fakeSpawn(() => ({ stdout: "", code: 3 }));
    const provider = new SbxProvider({ spawnFn });
    expect((await provider.exec(handle, ["codex", "exec", "x"])).exitCode).toBe(3);
  });

  it("rejects when the process emits an error (e.g. sbx not found)", async () => {
    const { spawnFn } = fakeSpawn(() => ({ error: new Error("ENOENT sbx") }));
    const provider = new SbxProvider({ spawnFn });
    await expect(provider.exec(handle, ["codex"])).rejects.toThrow(/ENOENT/);
  });
});

describe("create / stop / destroy / list", () => {
  it("create uses --clone + --name and returns a handle on success", async () => {
    const { spawnFn, calls } = fakeSpawn(() => ({ code: 0 }));
    const provider = new SbxProvider({ spawnFn });
    expect(await provider.create("t-C0-1.2", "/repo")).toEqual({ name: "t-C0-1.2" });
    expect(calls[0]?.args).toEqual(["create", "--clone", "--name", "t-C0-1.2", "codex", "/repo"]);
  });

  it("create throws on non-zero exit, surfacing stderr", async () => {
    const { spawnFn } = fakeSpawn(() => ({ stderr: "name already exists", code: 1 }));
    const provider = new SbxProvider({ spawnFn });
    await expect(provider.create("box", "/repo")).rejects.toThrow(/name already exists/);
  });

  it("list parses the { sandboxes: [...] } wrapper into handles", async () => {
    const { spawnFn, calls } = fakeSpawn(() => ({
      stdout: JSON.stringify({ sandboxes: [{ name: "a" }, { name: "b" }] }),
    }));
    const provider = new SbxProvider({ spawnFn });
    expect(await provider.list()).toEqual([{ name: "a" }, { name: "b" }]);
    expect(calls[0]?.args).toEqual(["ls", "--json"]);
  });

  it("stop and destroy build the right argv (rm --force for non-interactive)", async () => {
    const { spawnFn, calls } = fakeSpawn(() => ({ code: 0 }));
    const provider = new SbxProvider({ spawnFn });
    await provider.stop(handle);
    await provider.destroy(handle);
    expect(calls[0]?.args).toEqual(["stop", handle.name]);
    expect(calls[1]?.args).toEqual(["rm", "--force", handle.name]);
  });
});

describe("execShell + SandboxFsLike", () => {
  it("execShell runs `bash -c <command>` verbatim (no shellJoin)", async () => {
    const { spawnFn, calls } = fakeSpawn(() => ({ stdout: "" }));
    const provider = new SbxProvider({ spawnFn });
    await provider.execShell(handle, "find $HOME -name '*.jsonl'");
    expect(calls[0]?.args).toEqual([
      "exec",
      handle.name,
      "--",
      "bash",
      "-c",
      "find $HOME -name '*.jsonl'",
    ]);
  });

  it("homeDir trims the reported $HOME", async () => {
    const { spawnFn } = fakeSpawn(() => ({ stdout: "/root" }));
    expect(await new SbxProvider({ spawnFn }).homeDir(handle)).toBe("/root");
  });

  it("readFile returns content on exit 0 and null on non-zero (missing file)", async () => {
    const present = new SbxProvider({
      spawnFn: fakeSpawn(() => ({ stdout: "data", code: 0 })).spawnFn,
    });
    expect(await present.readFile(handle, "/home/u/.agent-state/session")).toBe("data");
    const missing = new SbxProvider({
      spawnFn: fakeSpawn(() => ({ stderr: "No such file", code: 1 })).spawnFn,
    });
    expect(await missing.readFile(handle, "/home/u/.agent-state/session")).toBeNull();
  });
});

describe("getFile / putFile — cp + host temp file round-trip", () => {
  // A virtual sandbox FS; the fake cp moves bytes between host temp files and it.
  function vfsSpawn(vfs: Map<string, string>) {
    return fakeSpawn((args) => {
      if (args[0] !== "cp") {
        return { code: 0 };
      }
      const src = args[1] ?? "";
      const dst = args[2] ?? "";
      if (src.includes(":") && !dst.includes(":")) {
        const content = vfs.get(src);
        if (content === undefined) {
          return { stderr: "no such file", code: 1 };
        }
        writeFileSync(dst, content);
        return { code: 0 };
      }
      if (!src.includes(":") && dst.includes(":")) {
        vfs.set(dst, readFileSync(src, "utf8"));
        return { code: 0 };
      }
      return { code: 1, stderr: "bad cp" };
    });
  }

  it("putFile writes then getFile reads the same bytes (via cp tempfiles)", async () => {
    const vfs = new Map<string, string>();
    const { spawnFn, calls } = vfsSpawn(vfs);
    const provider = new SbxProvider({ spawnFn });
    const path = "/home/agent/.agent-state/session";

    await provider.putFile(handle, path, new TextEncoder().encode("sess-123\n"));
    const got = await provider.getFile(handle, path);
    expect(new TextDecoder().decode(got)).toBe("sess-123\n");

    // cp addressed the sandbox path as name:path on both legs
    const cpCalls = calls.filter((c) => c.args[0] === "cp");
    expect(cpCalls.some((c) => c.args[2] === `${handle.name}:${path}`)).toBe(true);
    expect(cpCalls.some((c) => c.args[1] === `${handle.name}:${path}`)).toBe(true);
  });

  it("writeFile mkdir -p's the parent dir before putting the file", async () => {
    const vfs = new Map<string, string>();
    const { spawnFn, calls } = vfsSpawn(vfs);
    const provider = new SbxProvider({ spawnFn });
    await provider.writeFile(handle, "/home/agent/.agent-state/session", "abc\n");
    const shellCmds = calls
      .filter((c) => c.args[0] === "exec")
      .map((c) => c.args[c.args.length - 1]);
    expect(shellCmds.some((cmd) => cmd?.startsWith("mkdir -p"))).toBe(true);
    expect(vfs.get(`${handle.name}:/home/agent/.agent-state/session`)).toBe("abc\n");
  });
});
