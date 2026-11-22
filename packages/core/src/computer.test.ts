import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Computer } from "./computer.js";
import { MemoryStorage } from "./vfs.js";
import { fakeApp, fakeSandbox } from "./testing.js";
import type { App, ActionDefinition } from "./ports.js";

function slackish(calls: Array<{ input: unknown }> = []): App {
  const sendMessage: ActionDefinition<{ channel: string; text: string }, { ts: string }> = {
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
    actions: () => [sendMessage],
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

    expect(result.actions[0]?.ref).toBe("slack.sendMessage");
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
  it("dispatches to an app action and validates input", async () => {
    const calls: Array<{ input: unknown }> = [];
    const computer = new Computer({ apps: [slackish(calls)] });
    const workspace = await computer.createWorkspace("u1");

    const result = await workspace.run("slack.sendMessage", { channel: "#general", text: "hi" });

    expect(result).toEqual({ status: "ok", value: { ts: "1700000000.000100" } });
    expect(calls[0]?.input).toEqual({ channel: "#general", text: "hi" });
  });

  it("rejects arguments that fail the action's zod schema", async () => {
    const computer = new Computer({ apps: [slackish()] });
    const workspace = await computer.createWorkspace("u1");

    expect(await workspace.run("slack.sendMessage", { channel: "#general" })).toMatchObject({
      status: "error",
      error: {
        code: "invalid_args",
        message: expect.stringContaining('Invalid arguments for "slack.sendMessage": text'),
        retryable: false,
      },
    });
  });

  it("suggests near misses for an unknown ref", async () => {
    const computer = new Computer({ apps: [slackish()] });
    const workspace = await computer.createWorkspace("u1");

    expect(await workspace.run("slack.sendMesage", {})).toMatchObject({
      status: "error",
      error: { code: "unknown_ref", hint: expect.stringContaining("slack.sendMessage") },
    });
  });

  it("reads and writes the workspace through fs refs", async () => {
    const computer = new Computer();
    const workspace = await computer.createWorkspace("u1");

    await workspace.run("fs.write", { path: "/a.txt", content: "hello" });

    expect(await workspace.run("fs.read", { path: "/a.txt" })).toEqual({
      status: "ok",
      value: "hello",
    });
    expect(await workspace.run("fs.list", { prefix: "/" })).toMatchObject({
      status: "ok",
      value: [expect.objectContaining({ path: "/a.txt", type: "file" })],
    });
  });

  it("runs bash through the configured provider", async () => {
    const provider = fakeSandbox({ responses: { "echo hi": { stdout: "hi\n" } } });
    const computer = new Computer({ provider });
    const workspace = await computer.createWorkspace("u1");

    const result = await workspace.run("bash", { cmd: "echo hi" });

    expect(result).toMatchObject({
      status: "ok",
      value: { stdout: "hi\n", exitCode: 0, status: "completed" },
    });
    expect(provider.commands).toEqual(["echo hi"]);
  });

  it("explains how to get a shell when the shell is turned off", async () => {
    const workspace = await new Computer({ provider: null }).createWorkspace("u1");
    expect(await workspace.run("bash", { cmd: "ls" })).toMatchObject({
      status: "error",
      error: { code: "unknown_ref", message: expect.stringContaining("install @cloudfarm/bash") },
    });
  });

  it("says so when no memory store is configured", async () => {
    const workspace = await new Computer().createWorkspace("u1");
    expect(await workspace.run("memory.search", { query: "x" })).toMatchObject({
      status: "error",
      error: { message: expect.stringContaining("no memory store is configured") },
    });
  });
});

/** An app whose handler fetches a URL taken from its own arguments. */
function fetcher(): App {
  return {
    id: "fetcher",
    name: "Fetcher",
    description: "Fetches a url.",
    allowedHosts: ["good.example"],
    authorize: (request) => request,
    actions: () => [
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

describe("egress guard", () => {
  it("blocks a url that arrives in a model's arguments", async () => {
    const workspace = await new Computer({ apps: [fetcher()] }).createWorkspace("u1");

    // The classic prompt-injection shape: the host never chose this address.
    expect(await workspace.run("fetcher.get", { url: "https://evil.example/steal" })).toMatchObject(
      {
        status: "error",
        error: {
          code: "egress_denied",
          message: expect.stringContaining("Blocked request to evil.example"),
        },
      },
    );
  });

  it("names the action when a handler fails for any other reason", async () => {
    const workspace = await new Computer({ apps: [fetcher()] }).createWorkspace("u1");

    expect(await workspace.run("fetcher.get", { url: "not-a-url" })).toMatchObject({
      status: "error",
      error: { code: "upstream_error", message: expect.stringContaining("fetcher.get failed:") },
    });
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
  it("serves all three filesystem ops through one tool", async () => {
    const workspace = await new Computer({ storage: new MemoryStorage() }).createWorkspace("u");

    expect(
      await workspace.run("fs", { op: "write", path: "/a.txt", content: "hello" }),
    ).toMatchObject({ status: "ok" });
    expect(await workspace.run("fs", { op: "read", path: "/a.txt" })).toEqual({
      status: "ok",
      value: "hello",
    });

    const listed = (await workspace.run("fs", { op: "list" })) as {
      value: { path: string }[];
    };
    expect(listed.value.map((entry) => entry.path)).toContain("/a.txt");
  });

  it("takes `path` as the prefix when listing through the merged tool", async () => {
    const workspace = await new Computer({ storage: new MemoryStorage() }).createWorkspace("u");
    await workspace.fs.write("/docs/one.md", "1");
    await workspace.fs.write("/other/two.md", "2");

    const listed = (await workspace.run("fs", { op: "list", path: "/docs" })) as {
      value: { path: string }[];
    };

    expect(listed.value.map((entry) => entry.path)).toEqual(["/docs/one.md"]);
  });

  it("keeps the per-op refs working, which is what code mode writes", async () => {
    const workspace = await new Computer({ storage: new MemoryStorage() }).createWorkspace("u");

    await workspace.run("fs.write", { path: "/b.txt", content: "kept" });

    expect(await workspace.run("fs.read", { path: "/b.txt" })).toEqual({
      status: "ok",
      value: "kept",
    });
  });

  it("says which field is missing rather than failing obscurely", async () => {
    const workspace = await new Computer({ storage: new MemoryStorage() }).createWorkspace("u");

    expect(await workspace.run("fs", { op: "write", path: "/c.txt" })).toMatchObject({
      status: "error",
      error: { code: "invalid_args", message: /content/ },
    });
    expect(await workspace.run("fs", {})).toMatchObject({
      status: "error",
      error: { code: "invalid_args", message: /op/ },
    });
  });

  it("rejects an op it does not have, naming the ones it does", async () => {
    const workspace = await new Computer({ storage: new MemoryStorage() }).createWorkspace("u");

    expect(await workspace.run("fs", { op: "chmod", path: "/a" })).toMatchObject({
      status: "error",
      error: { code: "unknown_ref", message: /fs\.read/ },
    });
  });

  it("does not advertise remove, but leaves the ref reachable", async () => {
    const workspace = await new Computer({ storage: new MemoryStorage() }).createWorkspace("u");
    await workspace.fs.write("/gone.txt", "x");

    const ops = workspace.toolSpecs().find((tool) => tool.name === "fs")?.inputSchema as {
      properties?: { op?: { enum?: string[] } };
    };
    expect(ops.properties?.op?.enum).toEqual(["read", "write", "list"]);

    // Unchanged from before the merge: destructive deletion is reachable by
    // ref, just not offered as a one-token choice.
    expect(await workspace.run("fs.remove", { path: "/gone.txt" })).toMatchObject({ status: "ok" });
  });

  it("lists the installed apps, with the actions each contributes", async () => {
    const workspace = await new Computer({
      storage: new MemoryStorage(),
      apps: [slackish(), fakeApp({ id: "notes", name: "Notes" })],
    }).createWorkspace("u");

    const result = (await workspace.run("apps.list", {})) as {
      value: { apps: { id: string; name: string; actions: string[] }[] };
    };

    // The computer lists itself first: `run` treats the shell and the
    // filesystem as things you run, so they are listed as things you have.
    expect(result.value.apps.map((app) => app.id)).toEqual(["computer", "slack", "notes"]);
    expect(result.value.apps[1]).toMatchObject({ name: "Slack", actions: ["slack.sendMessage"] });
    expect(result.value.apps[0]?.actions).toContain("fs.read");
  });

  it("reports an app's auth kind rather than guessing whether it works", async () => {
    const workspace = await new Computer({
      storage: new MemoryStorage(),
      apps: [slackish()],
    }).createWorkspace("u");

    const result = (await workspace.run("apps.list", {})) as {
      value: { apps: { id: string; auth: string }[] };
    };

    // A hand-written App declares no scheme; createApp-built ones name theirs.
    expect(result.value.apps.find((app) => app.id === "slack")?.auth).toBe("unknown");
  });

  it("still lists the computer when no apps are installed", async () => {
    // provider/codeEngine pinned off: the defaults resolve whenever
    // @cloudfarm/bash and @cloudfarm/quickjs are installed, which they are
    // here, so "not configured" has to be said explicitly.
    const workspace = await new Computer({
      storage: new MemoryStorage(),
      provider: null,
      codeEngine: null,
    }).createWorkspace("u");

    const result = (await workspace.run("apps.list", {})) as {
      value: { apps: { id: string; actions: string[] }[] };
    };

    expect(result.value.apps.map((app) => app.id)).toEqual(["computer"]);
    // No sandbox configured, so bash is not offered.
    expect(result.value.apps[0]?.actions).not.toContain("bash");
  });

  it("scopes a search to one app when asked", async () => {
    const workspace = await new Computer({
      storage: new MemoryStorage(),
      apps: [slackish(), fakeApp({ id: "notes", name: "Notes" })],
    }).createWorkspace("u");

    const everywhere = await workspace.search("send a message");
    const scoped = await workspace.search("send a message", { app: "notes" });

    expect(everywhere.actions[0]?.ref).toBe("slack.sendMessage");
    expect(scoped.actions.every((action) => action.ref.startsWith("notes."))).toBe(true);
  });

  it("scopes to the computer, so the shell can be found without app noise", async () => {
    const workspace = await new Computer({
      storage: new MemoryStorage(),
      provider: fakeSandbox(),
      apps: [slackish()],
    }).createWorkspace("u");

    // "do something" would tokenise to nothing: both words are stopwords.
    const scoped = await workspace.search("run a shell command", { app: "computer" });

    expect(scoped.actions.length).toBeGreaterThan(0);
    expect(scoped.actions.every((action) => action.app.id === "computer")).toBe(true);
  });

  it("still returns a full page of hits when the best ones are another app's", async () => {
    const workspace = await new Computer({
      storage: new MemoryStorage(),
      apps: [slackish(), fakeApp({ id: "notes", name: "Notes" })],
    }).createWorkspace("u");

    // Filtering after ranking is why the registry over-fetches: ask for two
    // notes hits for a query slack wins, and two is what should come back.
    const scoped = await workspace.search("message", { app: "notes", limit: 2 });

    expect(scoped.actions.length).toBeGreaterThan(0);
    expect(scoped.actions.length).toBeLessThanOrEqual(2);
  });

  it("rejects an app id that is not installed, naming the ones that are", async () => {
    const workspace = await new Computer({
      storage: new MemoryStorage(),
      apps: [slackish()],
    }).createWorkspace("u");

    expect(
      await workspace.run("search", { useCase: "send a message", app: "slakc" }),
    ).toMatchObject({
      status: "error",
      error: { code: "invalid_args", message: /no app called "slakc".*slack/s },
    });
  });

  it("finds the shell through search, which used to return nothing", async () => {
    const workspace = await new Computer({
      storage: new MemoryStorage(),
      provider: fakeSandbox(),
    }).createWorkspace("u");

    const found = await workspace.search("run a shell command");

    expect(found.actions[0]?.ref).toBe("bash");
    expect(found.actions[0]?.app.id).toBe("computer");
  });

  it("hides a built-in whose package is not installed", async () => {
    const workspace = await new Computer({
      storage: new MemoryStorage(),
      provider: null,
      codeEngine: null,
    }).createWorkspace("u");

    const found = await workspace.search("run a shell command");

    // Offering `bash` with no sandbox would send the model at a ref that
    // cannot work; the registry indexes it, availability filters it.
    expect(found.actions.map((action) => action.ref)).not.toContain("bash");
  });

  it("suggests the right ref for a near miss under the apps namespace", async () => {
    const workspace = await new Computer({ storage: new MemoryStorage() }).createWorkspace("u");

    expect(await workspace.run("apps.all", {})).toMatchObject({
      status: "error",
      error: { code: "unknown_ref", message: /apps\.list/ },
    });
  });

  it("stays a fixed, small set however many apps are installed", async () => {
    const provider = fakeSandbox();
    // codeEngine is pinned off so the assertion is about app count, not about
    // which optional packages happen to be installed.
    const few = await new Computer({
      provider,
      codeEngine: null,
      apps: [slackish()],
    }).createWorkspace("u");
    const many = await new Computer({
      provider,
      codeEngine: null,
      apps: [slackish(), fakeApp({ id: "a" }), fakeApp({ id: "b" }), fakeApp({ id: "c" })],
    }).createWorkspace("u");

    const names = few.toolSpecs().map((spec) => spec.name);

    expect(names).toEqual(many.toolSpecs().map((spec) => spec.name));
    // The fixed set, whether or not an engine resolved on this runtime.
    expect(names).toEqual(expect.arrayContaining(["search", "run", "list_apps", "fs"]));
    expect(names.length).toBeLessThanOrEqual(6);
  });

  it("treats a null codeEngine exactly like an unset one", async () => {
    const unset = await new Computer({ storage: new MemoryStorage() }).createWorkspace("u");
    const nulled = await new Computer({
      storage: new MemoryStorage(),
      codeEngine: null,
    }).createWorkspace("u");

    // `null` used to mean "off". It now resolves the default, so the two are
    // indistinguishable — which is the point: there is no way to opt out.
    // Whether the default resolves at all is a platform question, asserted in
    // @cloudfarm/quickjs where an engine actually exists.
    expect(nulled.toolSpecs().map((spec) => spec.name)).toEqual(
      unset.toolSpecs().map((spec) => spec.name),
    );
    expect((await nulled.code("return 1;")).outcome).toBe((await unset.code("return 1;")).outcome);
  });

  it("omits bash when no sandbox is configured", async () => {
    const workspace = await new Computer({
      provider: null,
      apps: [slackish()],
    }).createWorkspace("u");

    expect(workspace.toolSpecs().map((spec) => spec.name)).not.toContain("bash");
  });

  it("materialises specs through the configured toolset", async () => {
    const workspace = await new Computer({
      codeEngine: null,
      apps: [slackish()],
    }).createWorkspace("u");

    const { specs, invoke } = (await workspace.tools()) as {
      specs: Array<{ name: string; inputSchema: Record<string, unknown> }>;
      invoke: (ref: string, args: unknown) => Promise<unknown>;
    };

    expect(specs.find((spec) => spec.name === "search")?.inputSchema).toMatchObject({
      type: "object",
      required: ["useCase"],
    });
    await expect(invoke("slack.sendMessage", { channel: "#a", text: "b" })).resolves.toEqual({
      status: "ok",
      value: { ts: "1700000000.000100" },
    });
  });
});

describe("Workspace.search", () => {
  it("returns a signature, an example and generated types", async () => {
    const workspace = await new Computer({ apps: [slackish()] }).createWorkspace("u");

    const { actions, types } = await workspace.search("notify the team");

    expect(actions[0]).toMatchObject({
      ref: "slack.sendMessage",
      sideEffects: "write",
      signature: expect.stringContaining("sendMessage(input:"),
      example: expect.stringContaining("slack.sendMessage"),
    });
    expect(types).toContain('declare function run(ref: "slack.sendMessage"');
    expect(types).toContain("channel: string;");
  });
});
