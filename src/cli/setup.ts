#!/usr/bin/env node
/**
 * `npm run setup` — one-command onboarding (spec §4.8). Checks the selected
 * agent's sbx credential and, if it's missing, runs the interactive auth flow
 * (browser OAuth for Codex; `sbx run claude` → /login for Claude) with the
 * terminal attached, then confirms. Idempotent: re-running once configured just
 * reports ready. The pure decisions (which service, which command) live in
 * onboarding.ts; this file is the thin I/O shell.
 */
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { SbxProvider } from "../sandbox/sbx-provider.js";
import {
  type Agent,
  credentialService,
  detectMissingCredential,
  loginSandbox,
  parseAgent,
  setupCommand,
} from "./onboarding.js";

const SBX_BIN = "sbx";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Is the agent's credential present? Polls (sbx may set it a beat after the flow exits). */
async function credentialPresent(
  provider: SbxProvider,
  agent: Agent,
  tries: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < tries; attempt++) {
    if (!detectMissingCredential(await provider.secretLs(), agent)) {
      return true;
    }
    if (attempt < tries - 1) {
      await sleep(2000);
    }
  }
  return false;
}

/** MISHU_AGENT if set; else prompt on a TTY; else default codex (non-interactive). */
async function resolveAgent(): Promise<Agent> {
  const fromEnv = parseAgent(process.env.MISHU_AGENT);
  if (fromEnv !== null) {
    return fromEnv;
  }
  if (process.stdin.isTTY !== true) {
    return "codex";
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Which agent? [codex/claude] (default: codex): ");
    return parseAgent(answer.trim().toLowerCase()) ?? "codex";
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const agent = await resolveAgent();
  const service = credentialService(agent);
  const provider = new SbxProvider({ createOptions: { agent } });

  // Already set up? (idempotent)
  if (await credentialPresent(provider, agent, 1)) {
    console.log(`✓ '${service}' is already configured in sbx — Mishu is ready (agent=${agent}).`);
    return;
  }

  // The auth flow is interactive (browser sign-in / `/login`); don't launch it
  // headlessly (it would hang waiting on a terminal that isn't there).
  if (process.stdin.isTTY !== true) {
    console.error(
      `'${service}' isn't configured for ${agent}, and setup is interactive — ` +
        "run 'npm run setup' directly in a terminal.",
    );
    process.exit(1);
  }

  // Run the interactive auth flow with the terminal attached.
  console.log(`Setting up the '${service}' credential for ${agent}…\n`);
  if (agent === "claude") {
    console.log(
      "A Claude session will open — type /login, finish the browser sign-in, then exit.\n",
    );
  }
  const argv = setupCommand(agent);
  const result = spawnSync(SBX_BIN, argv, { stdio: "inherit" });
  if (result.error !== undefined) {
    console.error(`\nCouldn't run '${SBX_BIN} ${argv.join(" ")}': ${result.error.message}`);
    console.error("Is the sbx CLI installed and on your PATH?");
    process.exit(1);
  }

  // Confirm.
  if (!(await credentialPresent(provider, agent, 3))) {
    console.error(`\n✗ '${service}' still isn't configured. Re-run 'npm run setup' to try again.`);
    process.exit(1);
  }

  // Tidy up the throwaway login sandbox (Claude only) — best-effort; never fail over it.
  const login = loginSandbox(agent);
  if (login !== null) {
    try {
      await provider.destroy({ name: login });
    } catch {
      console.log(`(Leftover login sandbox '${login}' — remove it with: sbx rm --force ${login})`);
    }
  }

  console.log(`\n✓ '${service}' configured — Mishu is ready (agent=${agent}).`);
  console.log(
    "Start it with:  MISHU_REPO=/path/to/repo node --env-file=.env dist/cli/index.js --sandbox=sbx ./data",
  );
}

main().catch((err: unknown) => {
  console.error("[mishu setup] fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
