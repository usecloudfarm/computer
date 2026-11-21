import { afterEach, describe, expect, it, vi } from "vitest";
import { Computer } from "@cloudfarm/core";
import { hackernews } from "./index.js";

/** Replaces global fetch, so no test in this block reaches the network. */
const urlOf = (call: unknown[] | undefined) => {
  const input = call?.[0];
  return input instanceof Request ? input.url : String(input);
};

function mockFetch(handler: (url: string) => unknown) {
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    return new Response(JSON.stringify(handler(url)), {
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

const story = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  type: "story",
  by: "dhouston",
  title: `Story ${id}`,
  url: `https://example.test/${id}`,
  score: 104,
  descendants: 71,
  time: 1_175_714_200,
  ...extra,
});

async function workspace() {
  const computer = new Computer({ apps: [hackernews({})] });
  return computer.createWorkspace("u1");
}

afterEach(() => vi.unstubAllGlobals());

describe("hackernews", () => {
  it("needs no credentials", () => {
    expect(hackernews({}).auth?.kind).toBe("none");
    expect(
      hackernews({}).authorize(new Request("https://x.test/")).headers.get("authorization"),
    ).toBeNull();
  });

  it("exposes five actions, each searchable by use case", () => {
    const actions = hackernews({}).actions();
    expect(actions.map((action) => action.name)).toEqual([
      "topStories",
      "getStory",
      "getComments",
      "search",
      "getUser",
    ]);
    for (const action of actions) expect(action.useCases.length).toBeGreaterThan(0);
  });

  it("reads the front page: one request for the ids, then one per story", async () => {
    const spy = mockFetch((url) =>
      url.includes("topstories") ? [1, 2, 3, 4] : story(Number(/item\/(\d+)/.exec(url)?.[1])),
    );
    const ws = await workspace();

    const result = await ws.run("hackernews.topStories", { limit: 2 });

    expect(result).toMatchObject({ status: "ok" });
    expect(spy).toHaveBeenCalledTimes(3); // the list, plus two items — not four
    const value = (result as { value: { stories: { id: number; hnUrl: string }[] } }).value;
    expect(value.stories.map((s) => s.id)).toEqual([1, 2]);
    // The story url points at the article; a model asked for "the discussion"
    // needs the HN page, which no field of the API gives it.
    expect(value.stories[0]?.hnUrl).toBe("https://news.ycombinator.com/item?id=1");
  });

  it("asks for the list the caller named", async () => {
    const spy = mockFetch((url) => (url.includes("stories") ? [1] : story(1)));
    const ws = await workspace();

    await ws.run("hackernews.topStories", { list: "show", limit: 1 });

    expect(urlOf(spy.mock.calls[0])).toContain("showstories.json");
  });

  it("turns comment HTML into text a model does not have to decode", async () => {
    mockFetch((url) =>
      url.includes("item/8863")
        ? story(8863, { kids: [1, 2] })
        : {
            id: 1,
            by: "pg",
            text: '<p>It&#x27;s 5 &amp; 6 &lt; 7.</p><p>See <a href="https://x.test/a" rel="nofollow">this</a></p>',
            kids: [9],
          },
    );
    const ws = await workspace();

    const result = await ws.run("hackernews.getComments", { id: 8863, limit: 1 });
    const comment = (result as { value: { comments: { text: string; replies: number }[] } }).value
      .comments[0];

    expect(comment?.text).toBe("It's 5 & 6 < 7.\n\nSee https://x.test/a");
    expect(comment?.replies).toBe(1);
  });

  it("drops deleted and dead comments rather than showing empty rows", async () => {
    mockFetch((url) =>
      url.includes("item/10")
        ? story(10, { kids: [1, 2, 3] })
        : url.includes("item/1")
          ? { id: 1, by: "a", text: "kept" }
          : url.includes("item/2")
            ? { id: 2, deleted: true }
            : { id: 3, by: "c", text: "gone", dead: true },
    );
    const ws = await workspace();

    const result = await ws.run("hackernews.getComments", { id: 10, limit: 3 });

    expect((result as { value: { comments: unknown[] } }).value.comments).toHaveLength(1);
  });

  it("searches through Algolia, not Firebase", async () => {
    const spy = mockFetch(() => ({
      hits: [
        {
          objectID: "22238335",
          title: "Why Discord is switching from Go to Rust",
          url: "https://blog.example.test/go-to-rust",
          author: "Sikul",
          points: 1582,
          num_comments: 642,
          created_at: "2020-02-04T17:30:40Z",
        },
      ],
    }));
    const ws = await workspace();

    const result = await ws.run("hackernews.search", { query: "rust", limit: 1 });

    const url = urlOf(spy.mock.calls[0]);
    expect(url).toContain("hn.algolia.com/api/v1/search");
    expect(url).toContain("tags=story");
    expect(result).toMatchObject({
      status: "ok",
      value: { hits: [{ id: 22_238_335, points: 1582, comments: 642 }] },
    });
  });

  it("sorts by date when asked, which is a different endpoint", async () => {
    const spy = mockFetch(() => ({ hits: [] }));
    const ws = await workspace();

    await ws.run("hackernews.search", { query: "rust", sortBy: "date" });

    expect(urlOf(spy.mock.calls[0])).toContain("search_by_date");
  });

  it("reports a missing user as a failed run, not a crash", async () => {
    mockFetch(() => null);
    const ws = await workspace();

    expect(await ws.run("hackernews.getUser", { username: "nobody" })).toMatchObject({
      status: "error",
      error: { message: /No Hacker News user/ },
    });
  });

  it("declares both hosts it uses, since Algolia is reached absolutely", () => {
    expect(hackernews({}).allowedHosts).toEqual(["hacker-news.firebaseio.com", "hn.algolia.com"]);
  });

  it("ranks the front page above search for a front-page question", async () => {
    // Each action's useCases describe what it does *differently* from its
    // siblings. Repeating "hacker news" in all of them made this query a
    // coin-flip decided by which document was shorter.
    const ws = await workspace();
    const found = await ws.search("what is on hacker news");

    expect(found.actions[0]?.ref).toBe("hackernews.topStories");
  });
});
