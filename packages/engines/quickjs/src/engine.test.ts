import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Computer } from "@cloudfarm/core";
import type { App, CapabilityDefinition } from "@cloudfarm/core";
import { quickjs } from "./node.js";

function app(calls: unknown[] = []): App {
  const sendMessage: CapabilityDefinition<{ channel: string; text: string }, { ts: string }> = {
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
  const listChannels: CapabilityDefinition<Record<string, never>, { channels: string[] }> = {
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
    capabilities: () => [sendMessage, listChannels],
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
  it("reports itself available", async () => {
    await expect(quickjs().available()).resolves.toMatchObject({ ok: true });
  });

  it("runs code and returns its value", async () => {
    const ws = await workspace();

    const result = await ws.code("return 6 * 7;");

    expect(result).toMatchObject({ status: "ok", value: 42 });
  });

  it("calls a capability through the bridge", async () => {
    const calls: unknown[] = [];
    const ws = await workspace({ calls });

    const result = await ws.code(`
      const sent = run("slack.sendMessage", { channel: "#general", text: "hello" });
      return sent.ts;
    `);

    expect(result).toMatchObject({ status: "ok", value: "ts-1" });
    expect(calls).toEqual([{ channel: "#general", text: "hello" }]);
  });

  it("chains several capabilities in one run — the point of code mode", async () => {
    const calls: unknown[] = [];
    const ws = await workspace({ calls });

    const result = await ws.code(`
      const { channels } = run("slack.listChannels", {});
      for (const channel of channels) {
        run("slack.sendMessage", { channel, text: "broadcast" });
      }
      return channels.length;
    `);

    expect(result.status).toBe("ok");
    expect(result.value).toBe(2);
    expect(calls).toHaveLength(2);
    // Every call is recorded, in order: the audit trail.
    expect(result.calls.map((call) => call.capability)).toEqual([
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

    expect(result).toMatchObject({ status: "error", error: { message: "deliberate" } });
  });

  it("surfaces a capability error to the guest so it can catch it", async () => {
    const ws = await workspace();

    const result = await ws.code(`
      try {
        run("slack.sendMessage", { channel: 123 });
        return "no error";
      } catch (error) {
        return "caught: " + error.name;
      }
    `);

    expect(result.status).toBe("ok");
    expect(result.value).toBe("caught: invalid_args");
  });

  it("stops a runaway loop at the deadline and still reports logs", async () => {
    const ws = await workspace();

    const started = Date.now();
    const result = await ws.code(`console.log("before the loop"); while (true) {}`, {
      limits: { cpuTimeoutMs: 300, timeoutMs: 2000 },
    });

    expect(result.status).toBe("timeout");
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
      try {
        for (let i = 0; i < 10; i++) {
          run("slack.sendMessage", { channel: "#c", text: String(i) });
          sent++;
        }
      } catch (error) {
        return { sent, stoppedBy: error.name };
      }
      return { sent, stoppedBy: null };
      `,
      { limits: { maxHostCalls: 3 } },
    );

    expect(result.status).toBe("ok");
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

    expect(result.status).toBe("invalid");
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

    expect(result).toMatchObject({ status: "limit_exceeded" });
    expect(result.limitsHit).toContain("maxSourceBytes");
  });

  it("redacts secrets that reach a result", async () => {
    const ws = await workspace({ secrets: ["xoxb-not-a-real-token-value"] });

    const result = await ws.code(`return "leaked xoxb-not-a-real-token-value";`);

    expect(JSON.stringify(result)).not.toContain("xoxb-not-a-real-token-value");
    // The shape-based rule fires first and labels what it caught.
    expect(result.value).toContain("[redacted:slack-token]");
  });

  it("explains the calling convention when the model writes await", async () => {
    const ws = await workspace();

    const result = await ws.code(`const x = await run("slack.listChannels", {}); return x;`);

    expect(result.status).toBe("invalid");
    expect(result.diagnostics[0]).toMatchObject({ code: "forbidden_construct" });
    expect(result.diagnostics[0]?.message).toContain("synchronous");
  });

  it("reads and writes the workspace filesystem from inside a run", async () => {
    const computer = new Computer({ apps: [app()], codeEngine: quickjs() });
    const ws = await computer.createWorkspace("coder");
    await ws.fs.write("/data/input.txt", "alpha\nbeta\ngamma\n");

    const result = await ws.code(`
      const text = run("fs.read", { path: "/data/input.txt" });
      const lines = text.trim().split("\\n").map(line => line.toUpperCase());
      run("fs.write", { path: "/data/output.txt", content: lines.join("\\n") + "\\n" });
      return lines.length;
    `);

    expect(result).toMatchObject({ status: "ok", value: 3 });
    expect(await ws.fs.readText("/data/output.txt")).toBe("ALPHA\nBETA\nGAMMA\n");
  });

  it("rejects a run() for a capability that does not exist, without executing", async () => {
    const calls: unknown[] = [];
    const ws = await workspace({ calls });

    const result = await ws.code(`
      run("slack.sendMessage", { channel: "#a", text: "first" });
      run("slack.sendMesage", { channel: "#b", text: "typo" });
    `);

    expect(result.status).toBe("invalid");
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

    expect(result.status).toBe("invalid");
    expect(result.diagnostics[0]).toMatchObject({ code: "syntax_error", line: 2 });
  });

  it("starts each run with a fresh context", async () => {
    const ws = await workspace();

    await ws.code(`globalThis.leaked = "from the first run"; return 1;`);
    const second = await ws.code(`return typeof globalThis.leaked;`);

    expect(second.value).toBe("undefined");
  });
});
