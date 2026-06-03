import type { ThreadMessage } from "../types.js";
import {
  computeDelta,
  highWaterMark,
  parseTranscript,
  serializeTranscript,
} from "./agent-state.js";

const msg = (ts: string, user: string, text: string): ThreadMessage => ({ ts, user, text });

describe("highWaterMark", () => {
  it("returns null for an empty ledger (turn-1 signal)", () => {
    expect(highWaterMark([])).toBeNull();
  });

  it("returns the largest ts regardless of input order", () => {
    expect(
      highWaterMark([
        msg("1748600000.500000", "U1", "b"),
        msg("1748600000.100000", "U1", "a"),
        msg("1748600000.900000", "U1", "c"),
      ]),
    ).toBe("1748600000.900000");
  });

  it("compares Slack ts lexicographically (= chronologically)", () => {
    // micro-level ordering
    expect(
      highWaterMark([msg("1748600000.000009", "U", "x"), msg("1748600000.000010", "U", "y")]),
    ).toBe("1748600000.000010");
    // across the seconds boundary
    expect(
      highWaterMark([msg("1748600000.999999", "U", "x"), msg("1748600001.000000", "U", "y")]),
    ).toBe("1748600001.000000");
  });
});

describe("computeDelta", () => {
  const fetched = [
    msg("1748600000.100000", "U1", "old request"),
    msg("1748600000.200000", "BOT", "old bot reply"),
    msg("1748600000.300000", "U2", "teammate note"),
    msg("1748600000.400000", "U1", "@bot new request"), // the current trigger
  ];

  it("turn 1 (hwm null) returns the whole thread minus bot posts (primer)", () => {
    const delta = computeDelta(fetched, null, { botUser: "BOT" });
    expect(delta.map((m) => m.text)).toEqual(["old request", "teammate note", "@bot new request"]);
  });

  it("follow-up excludes <= hwm and bot posts, but INCLUDES the current trigger", () => {
    const delta = computeDelta(fetched, "1748600000.200000", { botUser: "BOT" });
    // strictly after hwm: teammate note + the new request; bot reply (if any) dropped
    expect(delta.map((m) => m.text)).toEqual(["teammate note", "@bot new request"]);
  });

  it("treats ts === hwm as already seen (exclusive boundary)", () => {
    const delta = computeDelta(fetched, "1748600000.300000", { botUser: "BOT" });
    expect(delta.map((m) => m.text)).toEqual(["@bot new request"]);
  });

  it("drops the bot's own later posts so the HWM never lands on a bot reply", () => {
    const withBotReply = [
      msg("1748600000.400000", "U1", "request"),
      msg("1748600000.500000", "BOT", "result reply"),
    ];
    const delta = computeDelta(withBotReply, "1748600000.350000", { botUser: "BOT" });
    expect(delta.map((m) => m.text)).toEqual(["request"]);
  });

  it("without a botUser, keeps every message after the hwm", () => {
    const delta = computeDelta(fetched, "1748600000.250000");
    expect(delta).toHaveLength(2);
  });
});

describe("serializeTranscript / parseTranscript", () => {
  const messages = [
    msg("1748600000.100000", "U1", "hello"),
    msg("1748600000.200000", "U2", 'has "quotes" and a\nnewline'),
  ];

  it("round-trips messages (incl. quotes and embedded newlines)", () => {
    expect(parseTranscript(serializeTranscript(messages))).toEqual(messages);
  });

  it("serializes one JSON object per line with a trailing newline", () => {
    const text = serializeTranscript(messages);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.trimEnd().split("\n")).toHaveLength(2);
  });

  it("serializes only {ts, user, text}, dropping any extra fields", () => {
    const dirty = [
      { ts: "1.1", user: "U", text: "hi", extra: "drop me" },
    ] as unknown as ThreadMessage[];
    expect(JSON.parse(serializeTranscript(dirty).trim())).toEqual({
      ts: "1.1",
      user: "U",
      text: "hi",
    });
  });

  it("returns '' for an empty ledger and [] when parsing it back", () => {
    expect(serializeTranscript([])).toBe("");
    expect(parseTranscript("")).toEqual([]);
  });

  it("tolerates blank lines and a missing trailing newline", () => {
    const text = '{"ts":"1.1","user":"U","text":"a"}\n\n{"ts":"1.2","user":"U","text":"b"}';
    expect(parseTranscript(text)).toEqual([msg("1.1", "U", "a"), msg("1.2", "U", "b")]);
  });

  it("throws on malformed message records", () => {
    expect(() => parseTranscript('{"ts":"1.1","user":"U"}')).toThrow(/invalid transcript line 1/);
  });
});
