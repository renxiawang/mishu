import {
  mentionFromEvent,
  type SlackAppMentionEvent,
  threadMessageFromSlack,
  threadMessagesFromReplies,
} from "./slack-map.js";

const base: SlackAppMentionEvent = {
  type: "app_mention",
  user: "U1",
  text: "<@UBOT> fix the bug",
  ts: "1748600000.500000",
  channel: "C0ABCDEF",
};

describe("mentionFromEvent", () => {
  it("a root mention (no thread_ts) uses its own ts as the thread id", () => {
    expect(mentionFromEvent(base)).toEqual({
      thread: { channel: "C0ABCDEF", threadTs: "1748600000.500000" },
      ts: "1748600000.500000",
      user: "U1",
      text: "<@UBOT> fix the bug",
    });
  });

  it("a reply mention uses the parent thread_ts", () => {
    const m = mentionFromEvent({ ...base, thread_ts: "1748600000.100000" });
    expect(m?.thread.threadTs).toBe("1748600000.100000");
    expect(m?.ts).toBe("1748600000.500000");
  });

  it("drops the bot's own post", () => {
    expect(mentionFromEvent({ ...base, user: "UBOT" }, "UBOT")).toBeNull();
  });

  it("drops messages from other bots (bot_id present)", () => {
    expect(mentionFromEvent({ ...base, bot_id: "B123" })).toBeNull();
  });

  it("drops events missing ts / channel / user", () => {
    expect(mentionFromEvent({ ...base, ts: undefined })).toBeNull();
    expect(mentionFromEvent({ ...base, channel: undefined })).toBeNull();
    expect(mentionFromEvent({ ...base, user: undefined })).toBeNull();
  });

  it("defaults missing text to empty", () => {
    expect(mentionFromEvent({ ...base, text: undefined })?.text).toBe("");
  });
});

describe("threadMessageFromSlack / threadMessagesFromReplies", () => {
  it("maps ts/user/text", () => {
    expect(threadMessageFromSlack({ ts: "1.1", user: "U1", text: "hi" })).toEqual({
      ts: "1.1",
      user: "U1",
      text: "hi",
    });
  });

  it("falls back to bot_id then 'unknown' for the author", () => {
    expect(threadMessageFromSlack({ ts: "1.1", bot_id: "B1", text: "x" })?.user).toBe("B1");
    expect(threadMessageFromSlack({ ts: "1.1", text: "x" })?.user).toBe("unknown");
  });

  it("returns null for a message without a ts", () => {
    expect(threadMessageFromSlack({ text: "no ts" })).toBeNull();
  });

  it("filters unmappable messages from a replies page", () => {
    expect(
      threadMessagesFromReplies([
        { ts: "1.1", user: "U1", text: "a" },
        { text: "dropped (no ts)" },
        { ts: "1.2", user: "U2", text: "b" },
      ]),
    ).toEqual([
      { ts: "1.1", user: "U1", text: "a" },
      { ts: "1.2", user: "U2", text: "b" },
    ]);
  });
});
