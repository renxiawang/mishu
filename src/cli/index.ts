#!/usr/bin/env node
/**
 * CLI entrypoint. Shape mirrors pi-mom's convention (spec §10):
 *
 *   slack-coding-agent --sandbox=<provider> <data-dir>
 *   e.g. slack-coding-agent --sandbox=sbx ./data
 *
 * Slack Socket Mode env (see spec §4.7, §4.8):
 *   APP_SLACK_APP_TOKEN   xapp-...   (app-level token → Socket Mode)
 *   APP_SLACK_BOT_TOKEN   xoxb-...   (bot token)
 * plus the coding-agent / LLM credentials, injected proxy-side (§4.7).
 */

interface Args {
  sandbox: string;
  dataDir: string;
}

function parseArgs(argv: string[]): Args | null {
  let sandbox = "";
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--sandbox=")) {
      sandbox = arg.slice("--sandbox=".length);
    } else if (arg === "-h" || arg === "--help") {
      return null;
    } else {
      positional.push(arg);
    }
  }
  const dataDir = positional[0];
  if (!sandbox || !dataDir) {
    return null;
  }
  return { sandbox, dataDir };
}

function usage(): void {
  console.log("Usage: slack-coding-agent --sandbox=<provider> <data-dir>");
  console.log("  e.g. slack-coding-agent --sandbox=sbx ./data");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    usage();
    process.exit(1);
  }

  console.log(`[slack-coding-agent] sandbox=${args.sandbox} dataDir=${args.dataDir}`);
  console.log(
    "Scaffold OK. Implement PlatformAdapter, SandboxProvider, CodingBackend, then wire Router.start() (see spec §3, §4).",
  );
}

main();
