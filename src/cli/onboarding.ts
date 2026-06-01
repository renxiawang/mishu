/**
 * Router-guided onboarding (spec §4.8). The router gates first use on the
 * coding agent's credential being present in sbx, walks the human through the
 * one-time setup, and then runs unattended forever after.
 *
 * The parsing/decision logic is pure; the guided flow needs only a `secretLs`
 * capability (so it's injectable in tests).
 */

export type Agent = "codex" | "claude";

/** The sbx secret service that backs each agent's auth (§4.7). */
export function credentialService(agent: Agent): string {
  return agent === "codex" ? "openai" : "anthropic";
}

/**
 * The interactive `sbx` command (argv after the `sbx` bin) that establishes the
 * agent's credential — what `npm run setup` runs (§4.8). Codex has a one-shot
 * OAuth command; Claude has no `anthropic --oauth`, so it logs in inside a
 * sandbox (`sbx run claude` → /login) and sbx captures the credential host-side.
 */
export function setupCommand(agent: Agent): string[] {
  return agent === "codex"
    ? ["secret", "set", "-g", credentialService(agent), "--oauth"]
    : ["run", "claude"];
}

/** True if `sbx secret ls` shows no credential for the agent's service. */
export function detectMissingCredential(secretLsOutput: string, agent: Agent): boolean {
  const service = credentialService(agent);
  const present = new RegExp(`\\b${service}\\b`, "i").test(secretLsOutput);
  return !present;
}

/** One-time setup instructions for the human (the OAuth/browser step needs a person). */
export function onboardingInstructions(agent: Agent): string {
  const service = credentialService(agent);
  if (agent === "codex") {
    return [
      `No '${service}' credential is configured in sbx for Codex.`,
      "",
      "  Easiest:  npm run setup   (walks you through it)",
      "",
      "  …or do it manually:",
      `  1. Run:  sbx secret set -g ${service} --oauth`,
      "  2. Finish the browser sign-in.",
      `  3. Re-run once 'sbx secret ls' shows '${service} (oauth configured)'.`,
      "",
      "(The credential is host-side and proxy-injected — it never enters a sandbox, §4.7.)",
    ].join("\n");
  }
  return [
    `No '${service}' credential is configured in sbx for Claude.`,
    "",
    "  Easiest:  npm run setup   (walks you through it)",
    "",
    "  …or do it manually:",
    "  1. Run:  sbx run claude",
    "  2. In the session type /login, finish the browser sign-in, then exit.",
    `  3. Re-run once 'sbx secret ls' shows '${service} (oauth configured)'.`,
    "",
    "(The credential is host-side and proxy-injected — it never enters a sandbox, §4.7.",
    " There's no 'anthropic --oauth'; the login sandbox is throwaway — 'sbx rm --force claude' clears it.)",
  ].join("\n");
}

export interface OnboardingDeps {
  /** Runs `sbx secret ls` and returns its raw output. */
  secretLs: () => Promise<string>;
  /** Where to surface human-facing setup instructions (stderr in the CLI). */
  log: (message: string) => void;
}

/**
 * Returns true if the agent's credential is present (proceed), or false after
 * printing setup instructions (the human must complete the one-time OAuth).
 */
export async function ensureOnboarded(agent: Agent, deps: OnboardingDeps): Promise<boolean> {
  const output = await deps.secretLs();
  if (detectMissingCredential(output, agent)) {
    deps.log(onboardingInstructions(agent));
    return false;
  }
  return true;
}
