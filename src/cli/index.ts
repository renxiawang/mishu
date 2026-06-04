#!/usr/bin/env node
/**
 * Composition root. Wires the three seams + Router behind the
 * onboarding gate, then starts the Socket Mode ingress:
 *
 *   mishu --sandbox=sbx ./data
 *
 * See args.ts USAGE for the environment. The router is plumbing — no LLM here.
 */
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ClaudeBackend } from "../backend/claude.js";
import { CodexBackend } from "../backend/codex.js";
import type { CodingBackend } from "../backend/index.js";
import { SlackAdapter } from "../platform/slack.js";
import { IdleSweeper } from "../router/idle-sweep.js";
import { Dispatcher, Router } from "../router/index.js";
import { createJsonlSink, type LogLevel, type LogSink } from "../router/log.js";
import { SbxProvider } from "../sandbox/sbx-provider.js";
import { type Args, parseArgs, USAGE } from "./args.js";
import { prepareDockerfileTemplate } from "./dockerfile-template.js";
import { createConfigFromEnv } from "./env.js";
import { type Agent, ensureOnboarded, parseAgent } from "./onboarding.js";

/** Boundary-log sink: the router's stdout + an append-only JSONL file. */
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
  const agent: Agent = parseAgent(process.env.MISHU_AGENT) ?? "codex";
  const level: LogLevel = process.env.MISHU_LOG_LEVEL === "verbose" ? "verbose" : "summary";
  const createConfig = createConfigFromEnv(agent, process.env);

  const credentialProvider = new SbxProvider({ createOptions: { agent } });

  // Onboarding gate: require the agent's credential before serving.
  const onboarded = await ensureOnboarded(agent, {
    secretLs: () => credentialProvider.secretLs(),
    log: (message) => console.error(message),
  });
  if (!onboarded) {
    process.exit(1);
  }

  if (createConfig.dockerfile !== undefined) {
    const prepared = await prepareDockerfileTemplate(createConfig.dockerfile, {
      log: (message) => console.error(message),
    });
    createConfig.createOptions.template = prepared.tag;
  }

  const provider = new SbxProvider({ createOptions: createConfig.createOptions });

  const appToken = requireEnv("APP_SLACK_APP_TOKEN");
  const botToken = requireEnv("APP_SLACK_BOT_TOKEN");
  const repoRef = requireEnv("MISHU_REPO");

  const logSink = fileLogSink(args.dataDir);
  const platform = new SlackAdapter({ appToken, botToken, botUserId: process.env.MISHU_BOT_USER });
  const botUser = await platform.whoAmI();
  const backend: CodingBackend =
    agent === "claude" ? new ClaudeBackend(provider) : new CodexBackend(provider);
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

  // Idle eviction: sbx stop (lossless) sandboxes whose threads have gone quiet.
  // Sweep hourly; the router never auto-`rm`s.
  new IdleSweeper({ sandbox: provider, platform, logSink }).start(60 * 60 * 1000);

  router.start();
  await platform.start();
  console.error(`[mishu] listening — agent=${agent} repo=${repoRef} data=${args.dataDir}`);
}

function main(): void {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args === null) {
    console.log(USAGE);
    process.exit(argv.includes("-h") || argv.includes("--help") ? 0 : 1);
  }
  run(args).catch((err: unknown) => {
    console.error("[mishu] fatal:", err);
    process.exit(1);
  });
}

main();
