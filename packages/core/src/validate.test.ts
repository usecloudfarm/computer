import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ActionRegistry } from "./registry.js";
import { validateSource } from "./validate.js";
import type { App } from "./ports.js";

const app: App = {
  id: "slack",
  name: "Slack",
  description: "Team messaging.",
  allowedHosts: ["slack.com"],
  authorize: (request) => request,
  actions: () => [
    {
      name: "sendMessage",
      summary: "Post a message.",
      useCases: ["send a message"],
      input: z.object({ channel: z.string(), text: z.string() }),
      output: z.object({ ts: z.string() }),
      example: 'run("slack.sendMessage", { channel: "#a", text: "hi" })',
      sideEffects: "write",
      handler: async () => ({ ts: "1" }),
    },
  ],
};

const builtins = new Set(["bash", "fs.read", "fs.write"]);
const check = (source: string) =>
  validateSource({ source, registry: new ActionRegistry([app]), builtins });

describe("validateSource", () => {
  it("passes code that only calls known refs", () => {
    expect(
      check(`
        const text = run("fs.read", { path: "/a.txt" });
        run("slack.sendMessage", { channel: "#a", text });
        return text.length;
      `),
    ).toEqual([]);
  });

  it("catches a mistyped ref before anything runs, and suggests the real one", () => {
    const [diagnostic] = check(`run("slack.sendMesage", {})`);

    expect(diagnostic).toMatchObject({
      code: "unknown_ref",
      ref: "slack.sendMesage",
      message: 'No action named "slack.sendMesage".',
      hint: expect.stringContaining("slack.sendMessage"),
      line: 1,
    });
  });

  it("reports the line a bad ref is on", () => {
    const [diagnostic] = check(`const a = 1;\nconst b = 2;\nrun("nope.missing", {});`);

    expect(diagnostic).toMatchObject({ code: "unknown_ref", line: 3 });
  });

  it("accepts built-in refs that no app provides", () => {
    expect(check(`run("bash", { cmd: "ls" })`)).toEqual([]);
  });

  it("reports each unknown ref once, however many times it is called", () => {
    const diagnostics = check(`run("a.b", {}); run("a.b", {}); run("c.d", {});`);

    expect(diagnostics.map((d) => d.ref)).toEqual(["a.b", "c.d"]);
  });

  it.each([
    ["const x = await run('bash', {});", "synchronous"],
    ["import fs from 'fs';", "Modules are not available"],
    ["const x = require('fs');", "`require` is not available"],
    ["fetch('https://example.com');", "no network access"],
  ])("rejects %s", (source, expected) => {
    const [diagnostic] = check(source);

    expect(diagnostic).toMatchObject({ code: "forbidden_construct" });
    expect(diagnostic?.message).toContain(expected);
  });

  it("does not mistake a word inside a string for a construct", () => {
    expect(check(`run("slack.sendMessage", { text: "please fetch(the report)" })`)).toEqual([]);
  });

  it("cannot check a computed ref, and says nothing rather than guessing", () => {
    // These still fail at call time; the bridge validates every call too.
    expect(check(`const ref = "slack." + "sendMessage"; run(ref, {});`)).toEqual([]);
  });
});
