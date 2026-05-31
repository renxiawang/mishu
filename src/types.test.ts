import type { Mention } from "./types.js";

// Proves the Vitest wiring: globals (describe/it/expect) resolve via
// `vitest/globals` in tsconfig, and the shared types type-check in a test file.
describe("test wiring", () => {
  it("runs vitest with globals and type-checks shared types", () => {
    const mention: Mention = {
      thread: { channel: "C0ABCDEF", threadTs: "1748600000.123456" },
      ts: "1748600000.123456",
      user: "U123",
      text: "hello",
    };
    expect(mention.thread.channel).toBe("C0ABCDEF");
    expect(mention.ts).toBe(mention.thread.threadTs);
  });
});
