import { describe, expect, it } from "vitest";
import { Computer } from "@cloudfarm/core";
import { sqliteMemory } from "./index.js";

describe("sqlite memory", () => {
  it("remembers and recalls", async () => {
    const memory = sqliteMemory();

    const stored = await memory.remember("Ada prefers deploy summaries as a markdown table.");
    const [found] = await memory.search("deploy summary");

    expect(stored.id).toMatch(/^mem_/);
    expect(found?.id).toBe(stored.id);
  });

  it("stems, so a singular query finds a plural memory", async () => {
    const memory = sqliteMemory();
    await memory.remember("Ada prefers deploy summaries as a markdown table.");
    await memory.remember("The staging database resets every Sunday night.");

    // Without the porter tokenizer "summary" never matches "summaries", and
    // the unrelated record won this query on the word "the".
    const [best] = await memory.search("how should I format the deploy summary?");

    expect(best?.text).toContain("summaries");
  });

  it("survives punctuation that is FTS5 syntax", async () => {
    const memory = sqliteMemory();
    await memory.remember("The staging database resets every Sunday night.");

    // `"`, `*`, `:` and `-` are operators: an unescaped question would throw
    // rather than search.
    await expect(memory.search("what's the DB reset?! :-) *")).resolves.toHaveLength(1);
  });

  it("returns nothing rather than throwing when a query has no usable terms", async () => {
    const memory = sqliteMemory();
    await memory.remember("something");

    // An empty MATCH is a syntax error in FTS5, not an empty result.
    await expect(memory.search("?! the a")).resolves.toEqual([]);
  });

  it("scores higher for better matches, the opposite of FTS5's rank", async () => {
    const memory = sqliteMemory();
    await memory.remember("deploy summaries as a markdown table");
    await memory.remember("unrelated note about gardening");

    const [best] = await memory.search("deploy summaries markdown");

    expect(best?.score).toBeGreaterThan(0);
  });

  it("keeps namespaces apart, which is the only tenant boundary it has", async () => {
    const path = ":memory:";
    const ada = sqliteMemory({ path, namespace: "ada" });
    const bob = sqliteMemory({ path, namespace: "bob" });

    await ada.remember("Ada likes tables.");

    // Separate `:memory:` databases, but the namespace is what a shared file
    // would rely on — MemoryStore has no scope argument.
    expect(await bob.search("tables")).toEqual([]);
    expect(await ada.search("tables")).toHaveLength(1);
  });

  it("forgets, and reports a missing record as null", async () => {
    const memory = sqliteMemory();
    const stored = await memory.remember("temporary");

    expect(await memory.get(stored.id)).toMatchObject({ text: "temporary" });

    await memory.forget(stored.id);

    expect(await memory.get(stored.id)).toBeNull();
    expect(await memory.search("temporary")).toEqual([]);
  });

  it("round-trips metadata", async () => {
    const memory = sqliteMemory();
    const stored = await memory.remember("a fact", { source: "chat", turn: 3 });

    expect(stored.metadata).toEqual({ source: "chat", turn: 3 });
    expect((await memory.get(stored.id))?.metadata).toEqual({ source: "chat", turn: 3 });
  });

  it("lists newest first, for a UI rather than a model", async () => {
    const memory = sqliteMemory();
    await memory.remember("first");
    await new Promise((resolve) => setTimeout(resolve, 2));
    await memory.remember("second");

    expect((await memory.list()).map((record) => record.text)).toEqual(["second", "first"]);
  });

  it("is reachable through a Computer, and findable with search", async () => {
    const workspace = await new Computer({ memory: sqliteMemory() }).createWorkspace("ada");

    expect((await workspace.search("remember this for later")).actions[0]?.ref).toBe(
      "memory.remember",
    );

    await workspace.run("memory.remember", { text: "Ada prefers markdown tables." });

    expect(await workspace.run("memory.search", { query: "markdown tables" })).toMatchObject({
      status: "ok",
    });
  });

  it("offers no memory refs when no store is configured", async () => {
    const workspace = await new Computer().createWorkspace("ada");

    expect(
      (await workspace.search("remember this for later")).actions.map((a) => a.ref),
    ).not.toContain("memory.remember");
    expect(await workspace.run("memory.search", { query: "x" })).toMatchObject({
      status: "error",
      error: { code: "unknown_ref" },
    });
  });
});
