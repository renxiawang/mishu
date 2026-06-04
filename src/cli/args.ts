export interface Args {
  sandbox: string;
  dataDir: string;
}

export function parseArgs(argv: string[]): Args | null {
  let sandbox = "";
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--sandbox=")) {
      sandbox = arg.slice("--sandbox=".length);
    } else if (arg === "-h" || arg === "--help") {
      return null;
    } else if (arg.startsWith("-")) {
      return null;
    } else {
      positional.push(arg);
    }
  }
  if (sandbox === "" || positional.length !== 1) {
    return null;
  }
  return { sandbox, dataDir: positional[0] as string };
}

export const USAGE = [
  "Usage: mishu --sandbox=<provider> <data-dir>",
  "  e.g. mishu --sandbox=sbx ./data",
  "",
  "Environment:",
  "  APP_SLACK_APP_TOKEN   xapp-…  app-level token (Socket Mode)",
  "  APP_SLACK_BOT_TOKEN   xoxb-…  bot token",
  "  MISHU_REPO              path to the target git repo (the --clone seed)",
  "  MISHU_AGENT             codex | claude | pi   (default: codex)",
  "  MISHU_SANDBOX_TEMPLATE  sbx template image (optional)",
  "  MISHU_SANDBOX_DOCKERFILE  local Dockerfile to build/load as an sbx template (optional)",
  "  MISHU_PI_PROVIDER       anthropic | deepseek | google | openai (required for MISHU_AGENT=pi)",
  "  MISHU_PI_API_KEY        provider API key injected into Pi turns (or native provider env var)",
  "  MISHU_PI_MODEL          Pi model override, e.g. deepseek/deepseek-chat (optional)",
  "  MISHU_LOG_LEVEL         summary | verbose (default: summary)",
  "  MISHU_BOT_USER          bot user id (optional; resolved via auth.test otherwise)",
].join("\n");
