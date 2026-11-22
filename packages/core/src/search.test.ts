import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Bm25ActionIndex, tokenize } from "./search.js";
import type { ActionDefinition } from "./ports.js";

function createAction(
  name: string,
  summary: string,
  useCases: string[],
  keywords: string[] = [],
): ActionDefinition {
  return {
    name,
    summary,
    useCases,
    keywords,
    input: z.object({}),
    output: z.object({}),
    example: `await app.${name}({})`,
    sideEffects: "read",
    handler: async () => ({}),
  };
}

function index() {
  const built = new Bm25ActionIndex();
  built.add([
    {
      ref: "slack.sendMessage",
      appId: "slack",
      definition: createAction("sendMessage", "Post a message to a channel or DM.", [
        "send a message",
        "notify a channel",
        "post an update",
      ]),
    },
    {
      ref: "slack.listChannels",
      appId: "slack",
      definition: createAction("listChannels", "List channels you can post to.", [
        "list channels",
        "find a channel",
      ]),
    },
    {
      ref: "gmail.sendEmail",
      appId: "gmail",
      definition: createAction("sendEmail", "Send an email to one or more recipients.", [
        "send an email",
        "email someone",
      ]),
    },
    {
      ref: "github.createIssue",
      appId: "github",
      definition: createAction("createIssue", "Open an issue on a repository.", [
        "file a bug",
        "create an issue",
      ]),
    },
  ]);
  return built;
}

describe("tokenize", () => {
  it("lowercases, strips punctuation and drops stopwords", () => {
    expect(tokenize("Send a Message to the channel!")).toEqual(["send", "message", "channel"]);
  });

  it("stems plurals so 'channels' matches 'channel'", () => {
    expect(tokenize("channels")).toEqual(tokenize("channel"));
  });
});

describe("Bm25ActionIndex", () => {
  it("ranks the intended action first", () => {
    expect(index().search("send a message to the team")[0]?.ref).toBe("slack.sendMessage");
  });

  it("routes an email request to gmail, not slack", () => {
    expect(index().search("email the report to finance")[0]?.ref).toBe("gmail.sendEmail");
  });

  it("matches on the action name itself, split on camelCase", () => {
    expect(index().search("createIssue")[0]?.ref).toBe("github.createIssue");
  });

  it("short-circuits an exact ref to the top", () => {
    const hits = index().search("slack.listChannels");
    expect(hits[0]).toMatchObject({ ref: "slack.listChannels", score: 1 });
  });

  it("returns nothing for a query with no overlap", () => {
    expect(index().search("photosynthesis")).toEqual([]);
  });

  it("honours the limit", () => {
    expect(index().search("send", 1)).toHaveLength(1);
  });

  it("ranks deterministically across runs", () => {
    const once = index().search("send a message");
    const twice = index().search("send a message");
    expect(once).toEqual(twice);
  });

  it("expands synonyms without outranking a direct hit", () => {
    // "notify" is a synonym of message/send; sendMessage lists it as a use case.
    expect(index().search("notify the team")[0]?.ref).toBe("slack.sendMessage");
  });

  it("does not let stopword removal empty a query", () => {
    // "what can you do" is every stopword and nothing else, and it is the
    // most natural way to ask what a computer has. It used to return nothing
    // at all — the worst possible answer to that question, and one that cost
    // more once `list_apps` stopped being a tool you could just call.
    expect(tokenize("what can you do")).not.toEqual([]);
    expect(tokenize("send a message")).toEqual(["send", "message"]);
  });
});
