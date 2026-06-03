import type { CreateOptions } from "../sandbox/sbx-argv.js";
import type { Agent } from "./onboarding.js";

type Env = Record<string, string | undefined>;

export function optionalEnv(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

export function createOptionsFromEnv(agent: Agent, env: Env): CreateOptions {
  return {
    agent,
    template: optionalEnv(env.MISHU_SANDBOX_TEMPLATE),
  };
}
