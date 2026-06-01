import { asString, isRecord, newestByMtime, parseJsonlEvents } from "./parsing.js";

describe("isRecord", () => {
  it("accepts non-null objects and rejects everything else", () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(true); // arrays are objects; callers guard array-ness separately
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(isRecord(7)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});

describe("asString", () => {
  it("returns strings as-is and null otherwise", () => {
    expect(asString("hi")).toBe("hi");
    expect(asString("")).toBe("");
    expect(asString(3)).toBeNull();
    expect(asString(null)).toBeNull();
    expect(asString(undefined)).toBeNull();
  });
});

describe("parseJsonlEvents", () => {
  it("parses every JSON line and degrades gracefully on garbage", () => {
    expect(parseJsonlEvents('{"a":1}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
    expect(parseJsonlEvents("not json\n{bad}\n")).toEqual([]);
    expect(parseJsonlEvents("")).toEqual([]);
  });
});

describe("newestByMtime", () => {
  it("picks the path with the greatest mtime from find -printf output", () => {
    const out = "1780000000.0\t/a/old.jsonl\n1780277999.9\t/a/new.jsonl\n";
    expect(newestByMtime(out)).toBe("/a/new.jsonl");
  });

  it("ignores blank and tab-less lines and returns null when empty", () => {
    expect(newestByMtime("")).toBeNull();
    expect(newestByMtime("no-tab-here\n")).toBeNull();
    expect(newestByMtime("\n\n")).toBeNull();
  });
});
