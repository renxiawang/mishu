import { createArgv } from "../sandbox/sbx-argv.js";
import { createConfigFromEnv, createOptionsFromEnv, optionalEnv } from "./env.js";

describe("optionalEnv", () => {
  it("normalizes unset and empty env values to undefined", () => {
    expect(optionalEnv(undefined)).toBeUndefined();
    expect(optionalEnv("")).toBeUndefined();
  });

  it("preserves non-empty env values", () => {
    expect(optionalEnv("myregistry/image:tag")).toBe("myregistry/image:tag");
  });
});

describe("createOptionsFromEnv", () => {
  it("omits the sandbox template when unset", () => {
    const opts = createOptionsFromEnv("codex", {});
    expect(opts).toEqual({ agent: "codex", template: undefined });
    expect(createArgv("box", "/repo", opts)).not.toContain("--template");
  });

  it("omits the sandbox template when empty", () => {
    const opts = createOptionsFromEnv("codex", { MISHU_SANDBOX_TEMPLATE: "" });
    expect(opts).toEqual({ agent: "codex", template: undefined });
    expect(createArgv("box", "/repo", opts)).not.toContain("--template");
  });

  it("threads a non-empty sandbox template into create argv", () => {
    const opts = createOptionsFromEnv("claude", {
      MISHU_SANDBOX_TEMPLATE: "myregistry/image:tag",
    });
    expect(createArgv("box", "/repo", opts)).toEqual([
      "create",
      "--clone",
      "--name",
      "box",
      "--template",
      "myregistry/image:tag",
      "claude",
      "/repo",
    ]);
  });
});

describe("createConfigFromEnv", () => {
  it("captures a local sandbox Dockerfile separately from create argv options", () => {
    const config = createConfigFromEnv("codex", {
      MISHU_SANDBOX_DOCKERFILE: "./Dockerfile",
    });
    expect(config).toEqual({
      createOptions: { agent: "codex", template: undefined },
      dockerfile: "./Dockerfile",
    });
  });

  it("rejects setting both a registry template and a local Dockerfile", () => {
    expect(() =>
      createConfigFromEnv("codex", {
        MISHU_SANDBOX_TEMPLATE: "myregistry/image:tag",
        MISHU_SANDBOX_DOCKERFILE: "./Dockerfile",
      }),
    ).toThrow(/Set only one/);
  });
});
