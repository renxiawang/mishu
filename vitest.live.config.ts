import { defineConfig } from "vitest/config";

/**
 * Live lane — only `*.live.test.ts`, which exercise the real sbx daemon / Docker
 * / Codex (spec §9). NOT part of `npm run check` or CI; run on demand with
 * `npm run test:live` once the environment is up (Tier 1, see the plan). Passes
 * with no test files so the script is safe before any live tests exist.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.live.test.ts"],
    passWithNoTests: true,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
