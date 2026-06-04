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

  it("maps Pi to the sbx shell agent and keeps the Pi template", () => {
    const config = createConfigFromEnv("pi", {
      MISHU_SANDBOX_TEMPLATE: "mishu/pi:latest",
      MISHU_PI_API_KEY: "secret-value",
      MISHU_PI_PROVIDER: "deepseek",
    });
    expect(config).toEqual({
      createOptions: { agent: "shell", template: "mishu/pi:latest" },
      createNetworkAllows: ["api.deepseek.com:443"],
      dockerfile: undefined,
      piModel: "deepseek/deepseek-v4-pro",
      piProvider: "deepseek",
      turnEnv: { DEEPSEEK_API_KEY: "secret-value" },
    });
  });

  it("requires a template or Dockerfile for Pi because sbx has no native pi agent", () => {
    expect(() => createConfigFromEnv("pi", {})).toThrow(/requires MISHU_SANDBOX_TEMPLATE/);
  });

  it("maps Pi user-provided API keys to provider env vars", () => {
    const config = createConfigFromEnv("pi", {
      MISHU_SANDBOX_DOCKERFILE: "sandbox-templates/pi/Dockerfile",
      MISHU_PI_PROVIDER: "openai",
      MISHU_PI_API_KEY: "secret-value",
    });
    expect(config.createOptions).toEqual({ agent: "shell", template: undefined });
    expect(config.createNetworkAllows).toBeUndefined();
    expect(config.piModel).toBe("openai/gpt-4o-mini");
    expect(config.piProvider).toBe("openai");
    expect(config.turnEnv).toEqual({ OPENAI_API_KEY: "secret-value" });
  });

  it("uses Pi's documented env var names for Google and DeepSeek API keys", () => {
    const config = createConfigFromEnv("pi", {
      MISHU_SANDBOX_DOCKERFILE: "sandbox-templates/pi/Dockerfile",
      MISHU_PI_API_KEY: "secret-value",
      MISHU_PI_PROVIDER: "google",
    });
    expect(config.piModel).toBe("google/gemini-3.1-pro-preview");
    expect(config.turnEnv).toEqual({ GEMINI_API_KEY: "secret-value" });

    const deepseek = createConfigFromEnv("pi", {
      MISHU_SANDBOX_DOCKERFILE: "sandbox-templates/pi/Dockerfile",
      MISHU_PI_API_KEY: "secret-value",
      MISHU_PI_PROVIDER: "deepseek",
    });
    expect(deepseek.turnEnv).toEqual({ DEEPSEEK_API_KEY: "secret-value" });
    expect(deepseek.createNetworkAllows).toEqual(["api.deepseek.com:443"]);
  });

  it("accepts the selected provider's native API-key env var", () => {
    const config = createConfigFromEnv("pi", {
      DEEPSEEK_API_KEY: "deepseek-secret",
      MISHU_PI_PROVIDER: "deepseek",
      MISHU_SANDBOX_DOCKERFILE: "sandbox-templates/pi/Dockerfile",
    });
    expect(config.turnEnv).toEqual({ DEEPSEEK_API_KEY: "deepseek-secret" });
  });

  it("lets Pi users override the provider default model", () => {
    const config = createConfigFromEnv("pi", {
      MISHU_PI_API_KEY: "secret-value",
      MISHU_PI_MODEL: "deepseek/deepseek-chat",
      MISHU_PI_PROVIDER: "deepseek",
      MISHU_SANDBOX_DOCKERFILE: "sandbox-templates/pi/Dockerfile",
    });
    expect(config.piModel).toBe("deepseek/deepseek-chat");
  });

  it("rejects Pi API-key config for non-Pi agents", () => {
    expect(() =>
      createConfigFromEnv("codex", {
        MISHU_PI_PROVIDER: "anthropic",
        MISHU_PI_API_KEY: "secret-value",
      }),
    ).toThrow(/require MISHU_AGENT=pi/);
  });

  it("rejects incomplete or unknown Pi API-key config", () => {
    expect(() =>
      createConfigFromEnv("pi", {
        MISHU_SANDBOX_TEMPLATE: "mishu/pi:latest",
        MISHU_PI_API_KEY: "secret-value",
      }),
    ).toThrow(/requires MISHU_PI_PROVIDER/);
    expect(() =>
      createConfigFromEnv("pi", {
        MISHU_SANDBOX_TEMPLATE: "mishu/pi:latest",
        MISHU_PI_PROVIDER: "deepseek",
      }),
    ).toThrow(/requires MISHU_PI_API_KEY or DEEPSEEK_API_KEY/);
    expect(() =>
      createConfigFromEnv("pi", {
        MISHU_SANDBOX_TEMPLATE: "mishu/pi:latest",
        MISHU_PI_PROVIDER: "wat",
        MISHU_PI_API_KEY: "secret-value",
      }),
    ).toThrow(/MISHU_PI_PROVIDER/);
  });
});
