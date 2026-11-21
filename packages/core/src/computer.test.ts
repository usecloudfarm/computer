import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Computer } from "./computer.js";
import { MemoryStorage } from "./vfs.js";
import { fakeApp, fakeSandbox } from "./testing.js";
import type { App, CapabilityDefinition } from "./ports.js";

function slackish(calls: Array<{ input: unknown }> = []): App {
  const sendMessage: CapabilityDefinition<{ channel: string; text: string }, { ts: string }> = {
    name: "sendMessage",
    summary: "Post a message to a channel or DM.",
    useCases: ["send a message", "notify a channel"],
    input: z.object({
      channel: z.string().describe("Channel name or id."),
      text: z.string(),
    }),
    output: z.object({ ts: z.string() }),
    example: 'slack.sendMessage({ channel: "#general", text: "hi" })',
    sideEffects: "write",
    handler: async (input) => {
      calls.push({ input });
      return { ts: "1700000000.000100" };
    },
  };
  return {
    id: "slack",
    name: "Slack",
    description: "Team messaging.",
    allowedHosts: ["slack.com"],
    capabilities: () => [sendMessage],
    authorize: (request) => request,
  };
}

describe("Computer", () => {
  it("creates a workspace per user with its own filesystem", async () => {
    const computer = new Computer({ storage: new MemoryStorage() });
    const alice = await computer.createWorkspace("alice");
    const bob = await computer.createWorkspace("bob");

    await alice.fs.write("/notes.txt", "alice");

    expect(await bob.fs.stat("/notes.txt")).toBeNull();
    expect(alice.info).toMatchObject({ userId: "alice", id: "default" });
  });

  it("returns the same workspace when asked twice", async () => {
    const computer = new Computer();
    const first = await computer.createWorkspace("alice");
    await first.fs.write("/a.txt", "1");
    const second = await computer.createWorkspace("alice");

    expect(await second.fs.readText("/a.txt")).toBe("1");
    expect(second).toBe(first);
  });

  it("delegates the single-tenant surface to one default workspace", async () => {
    const computer = new Computer({ apps: [slackish()] });

    const result = await computer.search("send a message");

    expect(result.capabilities[0]?.ref).toBe("slack.sendMessage");
    expect(computer.getWorkspace("default")).toBeDefined();
  });

  it("rejects an app that claims a reserved namespace", () => {
    const bad = { ...fakeApp(), id: "bash" };
    expect(() => new Computer({ apps: [bad] })).toThrow(/Namespace "bash" is already taken/);
  });

  it("rejects two apps with the same id", () => {
    expect(() => new Computer({ apps: [fakeApp(), fakeApp()] })).toThrow(/already taken/);
  });
});

describe("Workspace.run", () => {
  it("dispatches to an app capability and validates input", async () => {
    const calls: Array<{ input: unknown }> = [];
    const computer = new Computer({ apps: [slackish(calls)] });
    const workspace = await computer.createWorkspace("u1");

    const result = await workspace.run("slack.sendMessage", { channel: "#general", text: "hi" });

    expect(result).toEqual({ ts: "1700000000.000100" });
    expect(calls[0]?.input).toEqual({ channel: "#general", text: "hi" });
  });

  it("rejects arguments that fail the capability's zod schema", async () => {
    const computer = new Computer({ apps: [slackish()] });
    const workspace = await computer.createWorkspace("u1");

    await expect(workspace.run("slack.sendMessage", { channel: "#general" })).rejects.toThrow(
      /Invalid arguments for "slack.sendMessage": text/,
    );
  });

  it("suggests near misses for an unknown ref", async () => {
    const computer = new Computer({ apps: [slackish()] });
    const workspace = await computer.createWorkspace("u1");

    await expect(workspace.run("slack.sendMesage", {})).rejects.toThrow(
      /Unknown ref "slack.sendMesage". Did you mean: slack.sendMessage/,
    );
  });

  it("reads and writes the workspace through fs refs", async () => {
    const computer = new Computer();
    const workspace = await computer.createWorkspace("u1");

    await workspace.run("fs.write", { path: "/a.txt", content: "hello" });

    expect(await workspace.run("fs.read", { path: "/a.txt" })).toBe("hello");
    expect(await workspace.run("fs.list", { prefix: "/" })).toEqual([
      expect.objectContaining({ path: "/a.txt", type: "file" }),
    ]);
  });

  it("runs bash through the configured provider", async () => {
    const provider = fakeSandbox({ responses: { "echo hi": { stdout: "hi\n" } } });
    const computer = new Computer({ provider });
    const workspace = await computer.createWorkspace("u1");

    const result = await workspace.run("bash", { cmd: "echo hi" });

    expect(result).toMatchObject({ stdout: "hi\n", exitCode: 0, status: "completed" });
    expect(provider.commands).toEqual(["echo hi"]);
  });

  it("explains how to get a shell when no provider is configured", async () => {
    const workspace = await new Computer().createWorkspace("u1");
    await expect(workspace.run("bash", { cmd: "ls" })).rejects.toThrow(/install @cloudfarm\/bash/);
  });

  it("says so when no memory store is configured", async () => {
    const workspace = await new Computer().createWorkspace("u1");
    await expect(workspace.run("memory.search", { query: "x" })).rejects.toThrow(
      /no memory store is configured/,
    );
  });
});

describe("egress guard", () => {
  /** An app whose handler fetches a URL taken from its own arguments. */
  function fetcher(): App {
    return {
      id: "fetcher",
      name: "Fetcher",
      description: "Fetches a url.",
      allowedHosts: ["good.example"],
      authorize: (request) => request,
      capabilities: () => [
        {
          name: "get",
          summary: "Fetch a url.",
          useCases: ["fetch a url"],
          input: z.object({ url: z.string() }),
          output: z.object({ status: z.number() }),
          example: 'fetcher.get({ url: "https://good.example/a" })',
          sideEffects: "read",
          handler: async (input, context) => {
            const response = await context.fetch((input as { url: string }).url);
            return { status: response.status };
          },
        },
      ],
    };
  }

  it("blocks a url that arrives in a model's arguments", async () => {
    const workspace = await new Computer({ apps: [fetcher()] }).createWorkspace("u1");

    // The classic prompt-injection shape: the host never chose this address.
    await expect(
      workspace.run("fetcher.get", { url: "https://evil.example/steal" }),
    ).rejects.toThrow(/Blocked request to evil.example; allowed hosts: good.example/);
  });

  it("names the capability when a handler fails for any other reason", async () => {
    const workspace = await new Computer({ apps: [fetcher()] }).createWorkspace("u1");

    await expect(workspace.run("fetcher.get", { url: "not-a-url" })).rejects.toThrow(
      /fetcher.get failed:/,
    );
  });
});

describe("Workspace.exec", () => {
  it("spills oversized output to the filesystem and keeps the tail", async () => {
    const big = "x".repeat(5000);
    const provider = fakeSandbox({ responses: { big: { stdout: big } } });
    const workspace = await new Computer({ provider }).createWorkspace("u1");

    const result = await workspace.exec("big", { maxInlineBytes: 1000 });

    expect(result.stdout.length).toBeLessThan(5000);
    expect(result.truncated?.bytesDropped).toBeGreaterThan(0);
    expect(await workspace.fs.readText(result.truncated!.path)).toBe(big);
  });

  it("redacts registered secrets from command output", async () => {
    const provider = fakeSandbox({ responses: { leak: { stdout: "token=hunter2-is-secret\n" } } });
    const workspace = await new Computer({
      provider,
      secrets: ["hunter2-is-secret"],
    }).createWorkspace("u1");

    expect((await workspace.exec("leak")).stdout).toBe("token=[redacted]\n");
  });
});

describe("Workspace.tools", () => {
  it("stays a fixed, small set however many apps are installed", async () => {
    const provider = fakeSandbox();
    const few = await new Computer({ provider, apps: [slackish()] }).createWorkspace("u");
    const many = await new Computer({
      provider,
      apps: [slackish(), fakeApp({ id: "a" }), fakeApp({ id: "b" }), fakeApp({ id: "c" })],
    }).createWorkspace("u");

    expect(few.toolSpecs().map((spec) => spec.name)).toEqual(many.toolSpecs().map((s) => s.name));
    expect(few.toolSpecs().map((spec) => spec.name)).toEqual([
      "bash",
      "search",
      "run",
      "fs_read",
      "fs_write",
      "fs_list",
    ]);
  });

  it("omits bash when there is no sandbox and code when there is no engine", async () => {
    const workspace = await new Computer({ apps: [slackish()] }).createWorkspace("u");

    const names = workspace.toolSpecs().map((spec) => spec.name);

    expect(names).not.toContain("bash");
    expect(names).not.toContain("code");
  });

  it("materialises specs through the configured toolset", async () => {
    const workspace = await new Computer({ apps: [slackish()] }).createWorkspace("u");

    const { specs, invoke } = (await workspace.tools()) as {
      specs: Array<{ name: string; inputSchema: Record<string, unknown> }>;
      invoke: (ref: string, args: unknown) => Promise<unknown>;
    };

    expect(specs.find((spec) => spec.name === "search")?.inputSchema).toMatchObject({
      type: "object",
      required: ["useCase"],
    });
    await expect(invoke("slack.sendMessage", { channel: "#a", text: "b" })).resolves.toEqual({
      ts: "1700000000.000100",
    });
  });
});

describe("Workspace.search", () => {
  it("returns a signature, an example and generated types", async () => {
    const workspace = await new Computer({ apps: [slackish()] }).createWorkspace("u");

    const { capabilities, types } = await workspace.search("notify the team");

    expect(capabilities[0]).toMatchObject({
      ref: "slack.sendMessage",
      sideEffects: "write",
      signature: expect.stringContaining("sendMessage(input:"),
      example: expect.stringContaining("slack.sendMessage"),
    });
    expect(types).toContain('declare function run(ref: "slack.sendMessage"');
    expect(types).toContain("channel: string;");
  });
});
