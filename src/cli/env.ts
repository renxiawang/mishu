import type { CreateOptions } from "../sandbox/sbx-argv.js";
import type { Agent } from "./onboarding.js";

type Env = Record<string, string | undefined>;

export interface RuntimeCreateConfig {
  createOptions: CreateOptions;
  dockerfile?: string;
}

export function optionalEnv(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

export function createConfigFromEnv(agent: Agent, env: Env): RuntimeCreateConfig {
  const template = optionalEnv(env.MISHU_SANDBOX_TEMPLATE);
  const dockerfile = optionalEnv(env.MISHU_SANDBOX_DOCKERFILE);
  if (template !== undefined && dockerfile !== undefined) {
    throw new Error("Set only one of MISHU_SANDBOX_TEMPLATE or MISHU_SANDBOX_DOCKERFILE");
  }
  return {
    createOptions: {
      agent,
      template,
    },
    dockerfile,
  };
}

export function createOptionsFromEnv(agent: Agent, env: Env): CreateOptions {
  return createConfigFromEnv(agent, env).createOptions;
}
