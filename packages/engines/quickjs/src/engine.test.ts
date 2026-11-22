import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Computer } from "@cloudfarm/core";
import type { App, ActionDefinition } from "@cloudfarm/core";
import { quickjs } from "./node.js";

function app(calls: unknown[] = []): App {
  const sendMessage: ActionDefinition<{ channel: string; text: string }, { ts: string }> = {
    name: "sendMessage",
    summary: "Post a message to a channel.",
    useCases: ["send a message"],
    input: z.object({ channel: z.string(), text: z.string() }),
    output: z.object({ ts: z.string() }),
    example: 'slack.sendMessage({ channel: "#a", text: "hi" })',
    sideEffects: "write",
    handler: async (input) => {
      calls.push(input);
      return { ts: `ts-${calls.length}` };
    },
  };
  const listChannels: ActionDefinition<Record<string, never>, { channels: string[] }> = {
    name: "listChannels",
    summary: "List channels.",
    useCases: ["list channels"],
    input: z.object({}),
    output: z.object({ channels: z.array(z.string()) }),
    example: "slack.listChannels({})",
    sideEffects: "read",
    handler: async () => ({ channels: ["#general", "#random"] }),
  };
  return {
    id: "slack",
    name: "Slack",
    description: "Team messaging.",
    allowedHosts: ["slack.com"],
    actions: () => [sendMessage, listChannels],
    authorize: (request) => request,
  };
}

async function workspace(options: { calls?: unknown[]; secrets?: string[] } = {}) {
  const computer = new Computer({
    apps: [app(options.calls ?? [])],
    codeEngine: quickjs(),
    ...(options.secrets ? { secrets: options.secrets } : {}),
  });
  return computer.createWorkspace("coder");
}

describe("QuickJSEngine", () => {
  it("reaches apps.list from code mode without searching first", async () => {
    const ws = await workspace();

    // Validation rejects unknown refs before anything executes, so this
    // passing proves apps.list is a known builtin rather than only a
    // dispatch case that validation would have blocked.
    const result = await ws.code(
      'return run("apps.list", {}).value.apps.map(a => a.id).join(",");',
    );

    // The computer lists itself first, then the installed apps.
    expect(result).toMatchObject({ outcome: "ok", value: "computer,slack" });
  });

  it("reports itself available", async () => {
    await expect(quickjs().available()).resolves.toMatchObject({ ok: true });
  });

  it("runs code and returns its value", async () => {
    const ws = await workspace();

    const result = await ws.code("return 6 * 7;");

    expect(result).toMatchObject({ outcome: "ok", value: 42 });
  });

  it("calls an action through the bridge", async () => {
    const calls: unknown[] = [];
    const ws = await workspace({ calls });

    const result = await ws.code(`
      const sent = run("slack.sendMessage", { channel: "#general", text: "hello" });
      return sent.value.ts;
    `);

    expect(result).toMatchObject({ outcome: "ok", value: "ts-1" });
    expect(calls).toEqual([{ channel: "#general", text: "hello" }]);
  });

  it("chains several actions in one run — the point of code mode", async () => {
    const calls: unknown[] = [];
    const ws = await workspace({ calls });

    const result = await ws.code(`
      const { channels } = run("slack.listChannels", {}).value;
      for (const channel of channels) {
        run("slack.sendMessage", { channel, text: "broadcast" });
      }
      return channels.length;
    `);

    expect(result.outcome).toBe("ok");
    expect(result.value).toBe(2);
    expect(calls).toHaveLength(2);
    // Every call is recorded, in order: the audit trail.
    expect(result.calls.map((call) => call.action)).toEqual([
      "slack.listChannels",
      "slack.sendMessage",
      "slack.sendMessage",
    ]);
  });

  it("captures console output", async () => {
    const ws = await workspace();

    const result = await ws.code(`console.log("one"); console.warn("two"); return null;`);

    expect(result.logs).toBe("one\n[warn] two");
  });

  it("reports a guest exception without throwing", async () => {
    const ws = await workspace();

    const result = await ws.code(`throw new Error("deliberate");`);

    expect(result).toMatchObject({ outcome: "error", error: { message: "deliberate" } });
  });

  it("hands the guest the same envelope the run tool returns", async () => {
    const ws = await workspace();

    const result = await ws.code(`
      const bad = run("slack.sendMessage", { channel: 123 });
      if (bad.status === "error") return { code: bad.error.code, retryable: bad.error.retryable };
      return "unexpectedly ok";
    `);

    expect(result.outcome).toBe("ok");
    expect(result.value).toEqual({ code: "invalid_args", retryable: false });
  });

  it("stops a runaway loop at the deadline and still reports logs", async () => {
    const ws = await workspace();

    const started = Date.now();
    const result = await ws.code(`console.log("before the loop"); while (true) {}`, {
      limits: { cpuTimeoutMs: 300, timeoutMs: 2000 },
    });

    expect(result.outcome).toBe("timeout");
    expect(result.limitsHit).toContain("cpuTimeoutMs");
    expect(result.logs).toContain("before the loop");
    expect(Date.now() - started).toBeLessThan(2000);
  }, 20_000);

  it("stops at the host call limit and reports partial work", async () => {
    const calls: unknown[] = [];
    const ws = await workspace({ calls });

    const result = await ws.code(
      `
      let sent = 0;
      for (let i = 0; i < 10; i++) {
        const result = run("slack.sendMessage", { channel: "#c", text: String(i) });
        if (result.status === "error") return { sent, stoppedBy: result.error.code };
        sent++;
      }
      return { sent, stoppedBy: null };
      `,
      { limits: { maxHostCalls: 3 } },
    );

    expect(result.outcome).toBe("ok");
    expect(result.value).toEqual({ sent: 3, stoppedBy: "limit_exceeded" });
    expect(result.limitsHit).toContain("maxHostCalls");
  }, 20_000);

  it("gives the guest no network and no filesystem", async () => {
    const ws = await workspace();

    const result = await ws.code(`
      const missing = [];
      for (const name of ["fetch", "require", "XMLHttpRequest", "WebSocket", "process"]) {
        try {
          const value = eval(name);
          missing.push(name + ":" + typeof value);
        } catch { missing.push(name + ":absent"); }
      }
      return missing;
    `);

    // fetch and require exist only as stubs that explain themselves.
    expect(result.value).toEqual([
      "fetch:function",
      "require:function",
      "XMLHttpRequest:absent",
      "WebSocket:absent",
      "process:absent",
    ]);
  });

  it("rejects a network call during validation, before it can run", async () => {
    const ws = await workspace();

    const result = await ws.code(`fetch("https://example.com");`);

    expect(result.outcome).toBe("invalid");
    expect(result.diagnostics[0]).toMatchObject({
      code: "forbidden_construct",
      message: expect.stringContaining("no network access"),
    });
  });

  it("rejects source larger than the limit before running anything", async () => {
    const ws = await workspace();

    const result = await ws.code(`return "${"x".repeat(2000)}";`, {
      limits: { maxSourceBytes: 100 },
    });

    expect(result).toMatchObject({ outcome: "limit_exceeded" });
    expect(result.limitsHit).toContain("maxSourceBytes");
  });

  it("redacts secrets that reach a result", async () => {
    const ws = await workspace({ secrets: ["xoxb-not-a-real-token-value"] });

    const result = await ws.code(`return "leaked xoxb-not-a-real-token-value";`);

    expect(JSON.stringify(result)).not.toContain("xoxb-not-a-real-token-value");
    // The shape-based rule fires first and labels what it caught.
    expect(result.value).toContain("[redacted:slack-token]");
  });

  it("accepts await, which models write by habit", async () => {
    const ws = await workspace();

    const result = await ws.code(`const x = await run("slack.listChannels", {}); return x.status;`);

    expect(result).toMatchObject({ outcome: "ok", value: "ok" });
  });

  it("returns the same value with or without await", async () => {
    const ws = await workspace();

    const awaited = await ws.code(`return (await run("slack.listChannels", {})).status;`);
    const direct = await ws.code(`return run("slack.listChannels", {}).status;`);

    expect(awaited.value).toBe(direct.value);
  });

  it("serialises host calls even inside Promise.all", async () => {
    const ws = await workspace();

    // Asyncify unwinds the whole wasm stack per host call and cannot be
    // re-entered while unwound, so concurrency is not available to a script
    // however it is written. Four calls are four calls.
    const result = await ws.code(`
      const all = await Promise.all([1, 2, 3].map(() => run("slack.listChannels", {})));
      return all.length;
    `);

    expect(result).toMatchObject({ outcome: "ok", value: 3 });
    expect(result.calls).toHaveLength(3);
  });

  it("reads and writes the workspace filesystem from inside a run", async () => {
    const computer = new Computer({ apps: [app()], codeEngine: quickjs() });
    const ws = await computer.createWorkspace("coder");
    await ws.fs.write("/data/input.txt", "alpha\nbeta\ngamma\n");

    const result = await ws.code(`
      const text = run("bash", { cmd: "cat /data/input.txt" }).value.stdout;
      const lines = text.trim().split("\\n").map(line => line.toUpperCase());
      run("bash", { cmd: "printf '" + lines.join("\\n") + "\\n' > /data/output.txt" });
      return lines.length;
    `);

    expect(result).toMatchObject({ outcome: "ok", value: 3 });
    expect(await ws.fs.readText("/data/output.txt")).toBe("ALPHA\nBETA\nGAMMA\n");
  });

  it("rejects a run() for an action that does not exist, without executing", async () => {
    const calls: unknown[] = [];
    const ws = await workspace({ calls });

    const result = await ws.code(`
      run("slack.sendMessage", { channel: "#a", text: "first" });
      run("slack.sendMesage", { channel: "#b", text: "typo" });
    `);

    expect(result.outcome).toBe("invalid");
    expect(result.diagnostics[0]).toMatchObject({
      code: "unknown_ref",
      ref: "slack.sendMesage",
      hint: expect.stringContaining("slack.sendMessage"),
    });
    // The point of validating first: the valid call above never fired.
    expect(calls).toEqual([]);
    expect(result.calls).toEqual([]);
  });

  it("rejects a syntax error with the line, before executing", async () => {
    const ws = await workspace();

    const result = await ws.code(`const a = 1;\nconst b = ;\nreturn a;`);

    expect(result.outcome).toBe("invalid");
    expect(result.diagnostics[0]).toMatchObject({ code: "syntax_error", line: 2 });
  });

  it("starts each run with a fresh context", async () => {
    const ws = await workspace();

    await ws.code(`globalThis.leaked = "from the first run"; return 1;`);
    const second = await ws.code(`return typeof globalThis.leaked;`);

    expect(second.value).toBe("undefined");
  });

  it("puts fs and path in scope without a require line", async () => {
    const ws = await new Computer({ codeEngine: quickjs() }).createWorkspace("coder");
    await ws.fs.write("/a.csv", "x,1");

    // What a model writes unprompted. A missing `require` line is a silly
    // way to fail, so the modules are globals too.
    const result = await ws.code(`return fs.readFileSync(path.join("/", "a.csv"), "utf8");`);

    expect(result).toMatchObject({ outcome: "ok", value: "x,1" });
  });

  it("lets a script shadow a module name with its own variable", async () => {
    const ws = await new Computer({ codeEngine: quickjs() }).createWorkspace("coder");
    await ws.fs.write("/a.csv", "x,1");

    // The globals are assigned, not declared, so `const path = …` shadows
    // the module rather than colliding with a const in the same scope —
    // which would be a syntax error before anything ran.
    const result = await ws.code(`
      const path = "/a.csv";
      return fs.readFileSync(path, "utf8");
    `);

    expect(result).toMatchObject({ outcome: "ok", value: "x,1" });
  });

  it("gives a script require, with fs over the bridge", async () => {
    const ws = await new Computer({ codeEngine: quickjs() }).createWorkspace("coder");
    await ws.fs.write("/data/in.txt", "alpha");

    const result = await ws.code(`
      const fs = require("fs");
      const path = require("path");
      const text = fs.readFileSync("/data/in.txt", "utf8");
      fs.writeFileSync(path.join("/data", "out.txt"), text.toUpperCase());
      return fs.readdirSync("/data").join(",");
    `);

    expect(result).toMatchObject({ outcome: "ok", value: "in.txt,out.txt" });
    expect(await ws.fs.readText("/data/out.txt")).toBe("ALPHA");
    // Over the bridge, so unlike a native fs these are in the audit trail and
    // counted against maxHostCalls.
    expect(result.calls.map((call) => call.action)).toEqual(["fs.read", "fs.write", "fs.list"]);
  });

  it("throws ENOENT for a missing file rather than returning an envelope", async () => {
    const ws = await new Computer({ codeEngine: quickjs() }).createWorkspace("coder");

    // `fs` pretends to be Node, so it throws; `run` keeps the envelope. A
    // script checks e.code, not the host's taxonomy, which files a missing
    // file under "internal" for want of a better bucket.
    const result = await ws.code(`
      try { require("fs").readFileSync("/nope"); } catch (error) { return error.code; }
      return "did not throw";
    `);

    expect(result).toMatchObject({ outcome: "ok", value: "ENOENT" });
  });

  it("refuses a module it does not have, naming the ones it does", async () => {
    const ws = await new Computer({ codeEngine: quickjs() }).createWorkspace("coder");

    const result = await ws.code(`
      try { require("http"); } catch (error) { return error.message; }
    `);

    expect(result.value).toContain("Cannot find module 'http'");
    expect(result.value).toContain("fs, path, os, util");
  });
});
