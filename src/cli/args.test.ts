import { parseArgs } from "./args.js";

describe("parseArgs", () => {
  it("parses --sandbox=<provider> and a data-dir positional", () => {
    expect(parseArgs(["--sandbox=sbx", "./data"])).toEqual({ sandbox: "sbx", dataDir: "./data" });
  });

  it("is order-independent", () => {
    expect(parseArgs(["./data", "--sandbox=sbx"])).toEqual({ sandbox: "sbx", dataDir: "./data" });
  });

  it("returns null when the sandbox or data-dir is missing", () => {
    expect(parseArgs(["./data"])).toBeNull();
    expect(parseArgs(["--sandbox=sbx"])).toBeNull();
    expect(parseArgs([])).toBeNull();
  });

  it("returns null for extra positionals or unknown flags", () => {
    expect(parseArgs(["--sandbox=sbx", "./data", "./other"])).toBeNull();
    expect(parseArgs(["--sandbox=sbx", "--verbose", "./data"])).toBeNull();
  });

  it("returns null for -h / --help", () => {
    expect(parseArgs(["-h"])).toBeNull();
    expect(parseArgs(["--sandbox=sbx", "./data", "--help"])).toBeNull();
  });
});
