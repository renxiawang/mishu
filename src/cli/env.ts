import type { CreateOptions } from "../sandbox/sbx-argv.js";
import type { Agent } from "./onboarding.js";

type Env = Record<string, string | undefined>;

export interface RuntimeCreateConfig {
  createOptions: CreateOptions;
  createNetworkAllows?: string[];
  dockerfile?: string;
  piModel?: string;
  piProvider?: string;
  turnEnv?: Record<string, string>;
}

type PiProvider = "anthropic" | "deepseek" | "google" | "openai";

const PI_PROVIDER_ENV: Record<PiProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  google: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
};

const PI_PROVIDER_DEFAULT_MODEL: Record<PiProvider, string> = {
  anthropic: "anthropic/claude-sonnet-4.5",
  deepseek: "deepseek/deepseek-v4-pro",
  google: "google/gemini-3.1-pro-preview",
  openai: "openai/gpt-4o-mini",
};

const PI_PROVIDER_NETWORK_ALLOW: Partial<Record<PiProvider, string[]>> = {
  deepseek: ["api.deepseek.com:443"],
};

export function optionalEnv(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

export function createConfigFromEnv(agent: Agent, env: Env): RuntimeCreateConfig {
  const template = optionalEnv(env.MISHU_SANDBOX_TEMPLATE);
  const dockerfile = optionalEnv(env.MISHU_SANDBOX_DOCKERFILE);
  const piProvider = optionalEnv(env.MISHU_PI_PROVIDER);
  const piModel = optionalEnv(env.MISHU_PI_MODEL);
  const explicitPiApiKey = optionalEnv(env.MISHU_PI_API_KEY);
  if (template !== undefined && dockerfile !== undefined) {
    throw new Error("Set only one of MISHU_SANDBOX_TEMPLATE or MISHU_SANDBOX_DOCKERFILE");
  }
  if (agent === "pi" && template === undefined && dockerfile === undefined) {
    throw new Error("MISHU_AGENT=pi requires MISHU_SANDBOX_TEMPLATE or MISHU_SANDBOX_DOCKERFILE");
  }
  if (
    agent !== "pi" &&
    (piProvider !== undefined || piModel !== undefined || explicitPiApiKey !== undefined)
  ) {
    throw new Error(
      "MISHU_PI_PROVIDER, MISHU_PI_MODEL, and MISHU_PI_API_KEY require MISHU_AGENT=pi",
    );
  }
  if (piProvider !== undefined && !isPiProvider(piProvider)) {
    throw new Error("MISHU_PI_PROVIDER must be one of: anthropic, deepseek, google, openai");
  }
  if (agent === "pi" && piProvider === undefined) {
    throw new Error("MISHU_AGENT=pi requires MISHU_PI_PROVIDER");
  }
  const providerEnvName = piProvider === undefined ? undefined : PI_PROVIDER_ENV[piProvider];
  const piApiKey =
    agent === "pi" && providerEnvName !== undefined
      ? (explicitPiApiKey ?? optionalEnv(env[providerEnvName]))
      : undefined;
  if (agent === "pi" && piApiKey === undefined) {
    const providerHint = providerEnvName === undefined ? "" : ` or ${providerEnvName}`;
    throw new Error(`MISHU_AGENT=pi requires MISHU_PI_API_KEY${providerHint}`);
  }
  const turnEnv =
    agent === "pi" && providerEnvName !== undefined && piApiKey !== undefined
      ? { [providerEnvName]: piApiKey }
      : undefined;
  return {
    createOptions: {
      agent: agent === "pi" ? "shell" : agent,
      template,
    },
    createNetworkAllows:
      agent === "pi" && piProvider !== undefined
        ? PI_PROVIDER_NETWORK_ALLOW[piProvider]
        : undefined,
    dockerfile,
    piModel:
      agent === "pi"
        ? (piModel ??
          (piProvider !== undefined ? PI_PROVIDER_DEFAULT_MODEL[piProvider] : undefined))
        : undefined,
    piProvider: agent === "pi" ? piProvider : undefined,
    turnEnv,
  };
}

function isPiProvider(value: string): value is PiProvider {
  return value === "anthropic" || value === "deepseek" || value === "google" || value === "openai";
}

export function createOptionsFromEnv(agent: Agent, env: Env): CreateOptions {
  return createConfigFromEnv(agent, env).createOptions;
}
