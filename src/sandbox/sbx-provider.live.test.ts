import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxHandle } from "./index.js";
import { SbxProvider } from "./sbx-provider.js";

/**
 * Live verification of the sbx I/O seam against a real microVM (spec §9). Gated
 * by SBX_LIVE=1 (set by `npm run test:live`) and excluded from the default suite
 * + CI — it needs Docker + the sbx daemon. Uses a credential-free `shell`
 * sandbox so it covers exec/cp/$HOME/stop-restart without any agent auth.
 *
 * Verified manually 2026-05-31 (sbx v0.31.1): bash -c env, $HOME=/home/agent,
 * cp round-trip, and lossless stop→exec auto-restart all pass.
 */

const LIVE = process.env.SBX_LIVE === "1";
const NAME = "sca-live-test";

describe.skipIf(!LIVE)("SbxProvider — live shell sandbox", () => {
  const provider = new SbxProvider({ createOptions: { agent: "shell", clone: false } });
  const handle: SandboxHandle = { name: NAME };
  let workspace = "";

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), "sca-live-"));
    try {
      await provider.destroy(handle); // clean up any leftover from a prior run
    } catch {
      // not present — fine
    }
    await provider.create(NAME, workspace);
  });

  afterAll(async () => {
    try {
      await provider.destroy(handle);
    } catch {
      // best-effort cleanup
    }
    if (workspace !== "") {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("exec runs an agent argv via bash -c and drains stdout (§4.5/§9.9)", async () => {
    const result = await provider.exec(handle, ["echo", "hi from agent argv"]);
    expect(result.stdout.trim()).toBe("hi from agent argv");
    expect(result.exitCode).toBe(0);
  });

  it("homeDir resolves $HOME", async () => {
    expect((await provider.homeDir(handle)).length).toBeGreaterThan(0);
  });

  it("writeFile/readFile round-trips; a missing file reads as null", async () => {
    const home = await provider.homeDir(handle);
    await provider.writeFile(handle, `${home}/.agent-state/session`, "sess-live\n");
    expect(await provider.readFile(handle, `${home}/.agent-state/session`)).toBe("sess-live\n");
    expect(await provider.readFile(handle, `${home}/.agent-state/missing`)).toBeNull();
  });

  it("getFile/putFile round-trips bytes via cp + a host temp file", async () => {
    const home = await provider.homeDir(handle);
    await provider.putFile(handle, `${home}/.agent-state/bin`, new TextEncoder().encode("bytes\n"));
    const got = await provider.getFile(handle, `${home}/.agent-state/bin`);
    expect(new TextDecoder().decode(got)).toBe("bytes\n");
  });

  it("stop then exec auto-restarts losslessly — in-VM state survives (§4.6)", async () => {
    const home = await provider.homeDir(handle);
    await provider.stop(handle);
    const result = await provider.exec(handle, ["cat", `${home}/.agent-state/session`]);
    expect(result.stdout).toContain("sess-live");
  });

  it("list() includes the sandbox", async () => {
    expect((await provider.list()).some((h) => h.name === NAME)).toBe(true);
  });
});
