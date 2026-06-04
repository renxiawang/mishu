import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type CommandRunner,
  prepareDockerfileTemplate,
  templateTagForDockerfile,
} from "./dockerfile-template.js";

async function testDockerfile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mishu-dockerfile-test-"));
  const nested = join(dir, "template");
  mkdirSync(nested);
  const dockerfile = join(nested, "Dockerfile");
  writeFileSync(dockerfile, "FROM alpine\n");
  return dockerfile;
}

describe("templateTagForDockerfile", () => {
  it("derives a stable local template tag from the absolute Dockerfile path", () => {
    const relative = "./Dockerfile";
    expect(templateTagForDockerfile(relative)).toBe(templateTagForDockerfile(resolve(relative)));
    expect(templateTagForDockerfile(relative)).toMatch(/^mishu-local-template:[a-f0-9]{16}$/);
  });
});

describe("prepareDockerfileTemplate", () => {
  it("builds, exports, removes any old sbx template, and loads the new image", async () => {
    const dockerfile = await testDockerfile();
    const tag = templateTagForDockerfile(dockerfile);
    const calls: { command: string; args: string[] }[] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    await expect(prepareDockerfileTemplate(dockerfile, { runner })).resolves.toEqual({
      dockerfile,
      tag,
    });

    expect(calls).toHaveLength(5);
    expect(calls[0]).toEqual({
      command: "docker",
      args: ["image", "ls", "--format", "{{.ID}}"],
    });
    expect(calls[1]).toEqual({
      command: "docker",
      args: ["build", "-f", dockerfile, "-t", tag, dirname(dockerfile)],
    });
    expect(calls[2]?.command).toBe("docker");
    expect(calls[2]?.args.slice(0, 3)).toEqual(["save", "-o", expect.any(String)]);
    expect(calls[2]?.args.at(-1)).toBe(tag);
    expect(calls[3]).toEqual({ command: "sbx", args: ["template", "rm", tag] });
    expect(calls[4]?.command).toBe("sbx");
    expect(calls[4]?.args).toEqual(["template", "load", calls[2]?.args[2]]);

    await expect(stat(dirname(calls[2]?.args[2] ?? ""))).rejects.toThrow();
  });

  it("fails before building when the Docker daemon is unavailable", async () => {
    const dockerfile = await testDockerfile();
    const calls: { command: string; args: string[] }[] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      return {
        stdout: "",
        stderr: "Cannot connect to the Docker daemon",
        exitCode: 1,
      };
    };

    await expect(prepareDockerfileTemplate(dockerfile, { runner })).rejects.toThrow(
      /Docker daemon is not available/,
    );
    expect(calls).toEqual([{ command: "docker", args: ["image", "ls", "--format", "{{.ID}}"] }]);
  });

  it("ignores failure when removing an existing sbx template", async () => {
    const dockerfile = await testDockerfile();
    const calls: string[] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      return {
        stdout: "",
        stderr: command === "sbx" && args[1] === "rm" ? "not found" : "",
        exitCode: command === "sbx" && args[1] === "rm" ? 1 : 0,
      };
    };

    await expect(prepareDockerfileTemplate(dockerfile, { runner })).resolves.toBeDefined();
    expect(calls.at(-1)).toMatch(/^sbx template load /);
  });

  it("cleans up the exported tar directory when loading fails", async () => {
    const dockerfile = await testDockerfile();
    let tarPath = "";
    const runner: CommandRunner = async (command, args) => {
      if (command === "docker" && args[0] === "save") {
        tarPath = args[2] ?? "";
      }
      return {
        stdout: "",
        stderr: command === "sbx" && args[1] === "load" ? "load failed" : "",
        exitCode: command === "sbx" && args[1] === "load" ? 1 : 0,
      };
    };

    await expect(prepareDockerfileTemplate(dockerfile, { runner })).rejects.toThrow(/load failed/);
    await expect(stat(dirname(tarPath))).rejects.toThrow();
  });
});
