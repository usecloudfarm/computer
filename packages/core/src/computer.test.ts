import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Computer } from "./computer.js";
import { MemoryStorage } from "./vfs.js";
import { codeModeSpecs } from "./tools.js";

/** The `code` tool's description, for an engine that does or does not take `await`. */
const describeCode = (guestAwait: boolean) =>
  codeModeSpecs({ hasCode: true, builtins: ["bash"], guestAwait }).find(
    (spec) => spec.name === "code",
  )?.description ?? "";

/** `run`'s description for a given set of available built-in refs. */
const runDescriptionFor = (builtins: string[]) =>
  codeModeSpecs({ hasCode: true, builtins }).find((spec) => spec.name === "run")?.description ?? "";
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

  it("reads and writes the workspace through the shell", async () => {
    const computer = new Computer();
    const workspace = await computer.createWorkspace("u1");

    await workspace.run("bash", { cmd: "mkdir -p / && printf hello > /a.txt" });

    expect(await workspace.run("bash", { cmd: "cat /a.txt" })).toMatchObject({
      status: "ok",
      value: { stdout: "hello", exitCode: 0 },
    });
    // And the host still sees it: `workspace.fs` is the embedding program's
    // API, which is why it survived the agent's `fs.*` refs going away.
    expect(await workspace.fs.readText("/a.txt")).toBe("hello");
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
  it("lists the installed apps, with the actions each contributes", async () => {
    const workspace = await new Computer({
      storage: new MemoryStorage(),
      apps: [slackish(), fakeApp({ id: "notes", name: "Notes" })],
    }).createWorkspace("u");

    const result = (await workspace.run("apps.list", {})) as {
      value: { apps: { id: string; name: string; actions: string[] }[] };
    };

    // The computer lists itself first: `run` treats the shell as a thing you
    // run, so it is listed as a thing you have.
    expect(result.value.apps.map((app) => app.id)).toEqual(["computer", "slack", "notes"]);
    expect(result.value.apps[1]).toMatchObject({ name: "Slack", actions: ["slack.sendMessage"] });
    // Its whole surface now: a shell, and a way to see what is installed.
    expect(result.value.apps[0]?.actions).toEqual(["bash", "apps.list"]);
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
    const workspace = await new Computer({ storage: new MemoryStorage() }).createWorkspace("u");

    const result = (await workspace.run("apps.list", {})) as {
      value: { apps: { id: string; actions: string[] }[] };
    };

    expect(result.value.apps.map((app) => app.id)).toEqual(["computer"]);
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

  it("suggests the right ref for a near miss under the apps namespace", async () => {
    const workspace = await new Computer({ storage: new MemoryStorage() }).createWorkspace("u");

    expect(await workspace.run("apps.all", {})).toMatchObject({
      status: "error",
      error: { code: "unknown_ref", message: /apps\.list/ },
    });
  });

  it("names only the built-ins this computer actually has", () => {
    // A fixed string either advertises a shell that is not installed or stays
    // silent about one that is, and a model only finds out by failing. Driven
    // through codeModeSpecs because a Computer cannot be built without a
    // shell any more — `null` resolves the default — and the branch under
    // test is a pure function of the available refs.
    expect(runDescriptionFor(["bash", "fs.read"])).not.toContain("ref: 'code'");
    expect(runDescriptionFor(["fs.read"])).not.toContain("'bash'");
    expect(runDescriptionFor(["bash", "fs.read"])).toContain("'bash'");
  });

  it("shows built-in refs in call position, not as bare names", async () => {
    const workspace = await new Computer({
      storage: new MemoryStorage(),
      provider: fakeSandbox(),
    }).createWorkspace("u");

    const description =
      workspace.toolSpecs().find((spec) => spec.name === "run")?.description ?? "";

    // Models were calling `bash` as a tool of its own and losing the turn to
    // it: an undeclared tool name is rejected before anything executes. The
    // old phrasing invited it — `'bash' for the shell ({ cmd })` reads as a
    // tool signature, and `code` and `fs`, listed beside it, really are tools
    // in the same request. A ref has to appear as an argument to `run`.
    expect(description).toContain("{ ref: 'bash', args:");
    expect(description).toContain("there is no separate `bash` tool");
    expect(description).not.toMatch(/'bash' for the shell/);
  });

  it("quotes the sandbox's own description, so limits reach the model", async () => {
    const workspace = await new Computer({
      storage: new MemoryStorage(),
      provider: fakeSandbox(),
    }).createWorkspace("u");

    const run = workspace.toolSpecs().find((spec) => spec.name === "run");

    expect(run?.description).toContain("A scripted sandbox for tests.");
  });

  it("says where files actually live", async () => {
    const workspace = await new Computer({ storage: new MemoryStorage() }).createWorkspace("u");

    // Moved into `run` with the fs tool: whether a file survives the turn
    // changes whether writing it was worth doing.
    expect(workspace.toolSpecs().find((spec) => spec.name === "run")?.description).toContain(
      "lost when the process ends",
    );
  });

  it("keeps code mode as a tool, not a second ref to find", async () => {
    const workspace = await new Computer({
      storage: new MemoryStorage(),
      provider: fakeSandbox(),
    }).createWorkspace("u");

    // A tool is in context on every request, so it never needed `search`.
    // Indexing it put a second way to reach code mode in front of the model,
    // and the two do not answer alike: the ref wraps the CodeResult in an
    // envelope, so the real value sits at `value.value`.
    const found = await workspace.search("chain several actions together");
    expect(found.actions.map((action) => action.ref)).not.toContain("code");

    const listed = (await workspace.run("apps.list", {})) as {
      value: { apps: { actions: string[] }[] };
    };
    expect(listed.value.apps[0]?.actions).not.toContain("code");

    // Asserted against the spec builder rather than this workspace, because
    // the tool depends on an engine resolving and workerd has none.
    expect(codeModeSpecs({ hasCode: true, builtins: [] }).map((spec) => spec.name)).toContain(
      "code",
    );
  });

  it("claims the concurrency the engine actually has, and only that", () => {
    expect(describeCode(false)).toContain("SYNCHRONOUS");
    expect(describeCode(false)).not.toContain("`await` is available");
    // The bug this pins: a fixed "no `await`" sentence was emitted in front
    // of the generated one saying it is available, so the description
    // contradicted itself on an engine that accepts it.
    expect(describeCode(true)).toContain("`await` is available");
    expect(describeCode(true)).not.toContain("Promise.all");
    // Mechanism, not instruction: how fs reaches the workspace changes
    // nothing a script would write.
    expect(describeCode(true)).not.toContain("same bridge");
    expect(describeCode(true)).not.toContain("SYNCHRONOUS");
  });

  it("never names the shell, even when one is installed", () => {
    const specs = codeModeSpecs({
      hasCode: true,
      builtins: ["bash"],
      guestAwait: true,
      guestModules: true,
    });
    const code = specs.find((spec) => spec.name === "code");
    const source = (
      code?.inputSchema as { properties?: { source?: { description?: string } } } | undefined
    )?.properties?.source?.description;

    // The shell is an action like any other: `run` describes it and `search`
    // finds it. Naming it in the tool whose point is writing JavaScript is
    // what produced scripts that read a file by shelling out to `cat` —
    // shell, quoted inside a JS string, inside JSON, for one line of JS.
    expect(`${code?.description} ${source}`).not.toMatch(/bash|shell/i);
    expect(code?.description).toContain("fs.readFileSync(path, 'utf8')");
    // The bare-global spelling, not `require('fs').readFileSync`: naming the
    // import first read as though it were required.
    expect(code?.description).toContain("already in scope, no import");
  });

  it("neither teaches nor forbids shell file commands", () => {
    const description = runDescriptionFor(["bash", "fs.read"]);

    // `cat` on an unsized file is the cheapest way a model has to fill its
    // own context with something it cannot use — and the result is clamped
    // anyway, so it pays for the whole file and gets a truncated one.
    // `run` used to teach cat/ls/grep/heredocs, because it was the only
    // filesystem it had. The result was a model writing
    // run("bash", { cmd: "find / -name sales.csv" }) from inside `code`,
    // where one line of fs does it — two descriptions in one request
    // teaching different filesystems is a coin toss. This one points at the
    // other rather than competing with it.
    // Teaching cat/ls/grep/heredocs here had a model shelling out from
    // inside `code`; banning them sent it to `code` for a single read.
    // Neither: the shell is fine for one file, `code` wins at several.
    expect(description).toContain("fine here for a single file");
    expect(description).toContain("For several");
    expect(description).toContain("truncated");
    expect(description).not.toContain("<<'EOF'");
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
    expect(names).toEqual(expect.arrayContaining(["search", "run"]));
    expect(names.length).toBeLessThanOrEqual(3);
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
    // @cloudfarm/qjs where an engine actually exists.
    expect(nulled.toolSpecs().map((spec) => spec.name)).toEqual(
      unset.toolSpecs().map((spec) => spec.name),
    );
    expect((await nulled.code("return 1;")).outcome).toBe((await unset.code("return 1;")).outcome);
  });

  it("ignores a null provider rather than turning the shell off", async () => {
    // Same rule as codeEngine: a shell is part of what makes this a computer,
    // so `null` resolves the default instead of opting out.
    const nulled = await new Computer({ provider: null }).createWorkspace("u");
    const unset = await new Computer({}).createWorkspace("u");

    const refs = (workspace: typeof nulled) =>
      (workspace.toolSpecs().find((spec) => spec.name === "run")?.description ?? "").includes(
        "'bash'",
      );

    expect(refs(nulled)).toBe(refs(unset));
    expect(await nulled.run("bash", { cmd: "echo hi" })).toMatchObject({ status: "ok" });
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
