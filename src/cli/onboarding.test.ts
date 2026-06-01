import {
  credentialService,
  detectMissingCredential,
  ensureOnboarded,
  onboardingInstructions,
  setupCommand,
} from "./onboarding.js";

describe("credentialService", () => {
  it("maps agents to their sbx secret service (§4.7)", () => {
    expect(credentialService("codex")).toBe("openai");
    expect(credentialService("claude")).toBe("anthropic");
  });
});

describe("detectMissingCredential", () => {
  it("treats the empty 'No secrets found' output as missing", () => {
    const empty = "No secrets found. Run 'sbx secret set --help' to see available services.";
    expect(detectMissingCredential(empty, "codex")).toBe(true);
    expect(detectMissingCredential(empty, "claude")).toBe(true);
  });

  it("detects a configured credential for the agent's service", () => {
    const ls = "openai (oauth configured)\n";
    expect(detectMissingCredential(ls, "codex")).toBe(false);
    expect(detectMissingCredential(ls, "claude")).toBe(true); // anthropic still missing
  });
});

describe("onboardingInstructions", () => {
  it("guides Codex through the OAuth path the user chose (§4.8)", () => {
    const text = onboardingInstructions("codex");
    expect(text).toContain("npm run setup");
    expect(text).toContain("sbx secret set -g openai --oauth");
  });

  it("guides Claude through the one-command login sandbox (/login)", () => {
    const text = onboardingInstructions("claude");
    expect(text).toContain("npm run setup");
    expect(text).toContain("sbx run claude");
    expect(text).toContain("/login");
  });
});

describe("setupCommand", () => {
  it("codex: a single sbx OAuth command", () => {
    expect(setupCommand("codex")).toEqual(["secret", "set", "-g", "openai", "--oauth"]);
  });

  it("claude: in-sandbox login, not an (unsupported) anthropic --oauth", () => {
    expect(setupCommand("claude")).toEqual(["run", "claude"]);
    expect(setupCommand("claude")).not.toContain("--oauth");
  });
});

describe("ensureOnboarded", () => {
  it("returns true and stays quiet when the credential is present", async () => {
    const logs: string[] = [];
    const ok = await ensureOnboarded("codex", {
      secretLs: async () => "openai (oauth configured)",
      log: (m) => logs.push(m),
    });
    expect(ok).toBe(true);
    expect(logs).toEqual([]);
  });

  it("returns false and prints setup instructions when missing", async () => {
    const logs: string[] = [];
    const ok = await ensureOnboarded("codex", {
      secretLs: async () => "No secrets found.",
      log: (m) => logs.push(m),
    });
    expect(ok).toBe(false);
    expect(logs[0]).toContain("sbx secret set -g openai --oauth");
  });
});
