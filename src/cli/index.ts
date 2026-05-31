#!/usr/bin/env node
/**
 * Composition root (spec §3, §4.8). Wires the three seams + Router behind the
 * onboarding gate, then starts the Socket Mode ingress:
 *
 *   slack-coding-agent --sandbox=sbx ./data
 *
 * See args.ts USAGE for the environment. The router is plumbing — no LLM here.
 */
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CodexBackend } from "../backend/codex.js";
import { SlackAdapter } from "../platform/slack.js";
import { Dispatcher, Router } from "../router/index.js";
import { createJsonlSink, type LogLevel, type LogSink } from "../router/log.js";
import { SbxProvider } from "../sandbox/sbx-provider.js";
import { type Args, parseArgs, USAGE } from "./args.js";
import { type Agent, ensureOnboarded } from "./onboarding.js";

/** Boundary-log sink: the router's stdout + an append-only JSONL file (§4.9). */
function fileLogSink(dataDir: string): LogSink {
  mkdirSync(dataDir, { recursive: true });
  const stream = createWriteStream(join(dataDir, "router.log"), { flags: "a" });
  return createJsonlSink((line) => {
    process.stdout.write(line);
    stream.write(line);
  });
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

async function run(args: Args): Promise<void> {
  if (args.sandbox !== "sbx") {
    console.error(`Unsupported --sandbox=${args.sandbox} (v0 supports: sbx)`);
    process.exit(1);
  }
  const agent: Agent = process.env.SCA_AGENT === "claude" ? "claude" : "codex";
  const level: LogLevel = process.env.SCA_LOG_LEVEL === "verbose" ? "verbose" : "summary";

  const provider = new SbxProvider({ createOptions: { agent } });

  // Onboarding gate (§4.8): require the agent's credential before serving.
  const onboarded = await ensureOnboarded(agent, {
    secretLs: () => provider.secretLs(),
    log: (message) => console.error(message),
  });
  if (!onboarded) {
    process.exit(1);
  }

  const appToken = requireEnv("APP_SLACK_APP_TOKEN");
  const botToken = requireEnv("APP_SLACK_BOT_TOKEN");
  const repoRef = requireEnv("SCA_REPO");

  const logSink = fileLogSink(args.dataDir);
  const platform = new SlackAdapter({ appToken, botToken, botUserId: process.env.SCA_BOT_USER });
  const botUser = await platform.whoAmI();
  const backend = new CodexBackend(provider);
  const dispatcher = new Dispatcher({
    platform,
    sandbox: provider,
    backend,
    repoRef,
    logSink,
    level,
    botUser,
  });
  const router = new Router(platform, dispatcher, { logSink });

  router.start();
  await platform.start();
  console.error(
    `[slack-coding-agent] listening — agent=${agent} repo=${repoRef} data=${args.dataDir}`,
  );
}

function main(): void {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args === null) {
    console.log(USAGE);
    process.exit(argv.includes("-h") || argv.includes("--help") ? 0 : 1);
  }
  run(args).catch((err: unknown) => {
    console.error("[slack-coding-agent] fatal:", err);
    process.exit(1);
  });
}

main();
