import {
  CLAUDE_LOGIN_SANDBOX,
  credentialService,
  detectMissingCredential,
  ensureOnboarded,
  loginSandbox,
  onboardingInstructions,
  parseAgent,
  parsePiProvider,
  setupCommand,
} from "./onboarding.js";

describe("credentialService", () => {
  it("maps native agents to their sbx secret service", () => {
    expect(credentialService("codex")).toBe("openai");
    expect(credentialService("claude")).toBe("anthropic");
    expect(() => credentialService("pi")).toThrow(/MISHU_PI_API_KEY/);
  });
});

describe("parseAgent", () => {
  it("accepts codex/claude/pi and rejects anything else", () => {
    expect(parseAgent("codex")).toBe("codex");
    expect(parseAgent("claude")).toBe("claude");
    expect(parseAgent("pi")).toBe("pi");
    expect(parseAgent("")).toBeNull();
    expect(parseAgent(undefined)).toBeNull();
    expect(parseAgent("gpt")).toBeNull();
  });
});

describe("parsePiProvider", () => {
  it("accepts supported Pi providers and rejects unknown values", () => {
    expect(parsePiProvider("anthropic")).toBe("anthropic");
    expect(parsePiProvider("deepseek")).toBe("deepseek");
    expect(parsePiProvider("openai")).toBe("openai");
    expect(parsePiProvider("google")).toBe("google");
    expect(parsePiProvider("")).toBeNull();
    expect(parsePiProvider("xai")).toBeNull();
  });
});

describe("detectMissingCredential", () => {
  it("treats the empty 'No secrets found' output as missing", () => {
    const empty = "No secrets found. Run 'sbx secret set --help' to see available services.";
    expect(detectMissingCredential(empty, "codex")).toBe(true);
    expect(detectMissingCredential(empty, "claude")).toBe(true);
    expect(detectMissingCredential(empty, "pi")).toBe(false);
  });

  it("detects a configured credential for the agent's service", () => {
    const ls = "openai (oauth configured)\n";
    expect(detectMissingCredential(ls, "codex")).toBe(false);
    expect(detectMissingCredential(ls, "claude")).toBe(true); // anthropic still missing
  });
});

describe("onboardingInstructions", () => {
  it("guides Codex through the OAuth path the user chose", () => {
    const text = onboardingInstructions("codex");
    expect(text).toContain("npm run setup");
    expect(text).toContain("sbx secret set -g openai --oauth");
  });

  it("guides Claude through the named login sandbox (/login)", () => {
    const text = onboardingInstructions("claude");
    expect(text).toContain("npm run setup");
    expect(text).toContain(CLAUDE_LOGIN_SANDBOX);
    expect(text).toContain("/login");
  });

  it("guides Pi through env-only API-key setup", () => {
    const text = onboardingInstructions("pi");
    expect(text).toContain("MISHU_PI_API_KEY");
    expect(text).toContain("deepseek");
    expect(text).toContain("MISHU_PI_PROVIDER");
    expect(text).not.toContain("sbx secret set");
  });
});

describe("setupCommand", () => {
  it("codex: a single sbx OAuth command", () => {
    expect(setupCommand("codex")).toEqual(["secret", "set", "-g", "openai", "--oauth"]);
  });

  it("claude: a named throwaway sandbox, not an (unsupported) anthropic --oauth", () => {
    expect(setupCommand("claude")).toEqual(["run", "--name", CLAUDE_LOGIN_SANDBOX, "claude"]);
    expect(setupCommand("claude")).not.toContain("--oauth");
  });

  it("pi: setup is env-only, not an sbx secret or OAuth flow", () => {
    expect(() => setupCommand("pi")).toThrow(/env-only/);
  });
});

describe("loginSandbox", () => {
  it("names the throwaway sandbox for Claude, none for Codex", () => {
    expect(loginSandbox("claude")).toBe(CLAUDE_LOGIN_SANDBOX);
    expect(loginSandbox("codex")).toBeNull();
    expect(loginSandbox("pi")).toBeNull();
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

  it("does not check sbx secrets for Pi", async () => {
    const logs: string[] = [];
    const ok = await ensureOnboarded("pi", {
      secretLs: async () => {
        throw new Error("should not check secrets for pi");
      },
      log: (m) => logs.push(m),
    });
    expect(ok).toBe(true);
    expect(logs).toEqual([]);
  });
});
