import { defineConfig } from "vitest/config";

/**
 * Default test run: offline unit tests only. Live tests (`*.live.test.ts`,
 * which need the sbx daemon / Docker / creds — spec §9) are excluded here and
 * run via `npm run test:live` (see vitest.live.config.ts).
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "src/**/*.live.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.live.test.ts", "src/**/fixtures/**"],
    },
  },
});
