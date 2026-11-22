import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Computer } from "@cloudfarm/core";
import type { App } from "@cloudfarm/core";
import { fakeSandbox } from "@cloudfarm/core/testing";
import { AISDKToolset, repairToRun } from "./index.js";
import { NoSuchToolError } from "ai";

const app: App = {
  id: "demo",
  name: "Demo",
  description: "A demo app.",
  allowedHosts: ["example.test"],
  authorize: (request) => request,
  actions: () => [
    {
      name: "greet",
      summary: "Greet someone.",
      useCases: ["greet a person"],
      input: z.object({ name: z.string() }),
      output: z.object({ greeting: z.string() }),
      example: 'demo.greet({ name: "ada" })',
      sideEffects: "read",
      handler: async (input) => ({ greeting: `hello ${(input as { name: string }).name}` }),
    },
  ],
};

async function tools(options?: ConstructorParameters<typeof AISDKToolset>[0]) {
  const computer = new Computer({
    toolset: new AISDKToolset(options),
    provider: fakeSandbox({ responses: { "echo hi": { stdout: "hi\n" } } }),
    // Pinned off so the expected tool list does not depend on which optional
    // packages are installed alongside.
    codeEngine: null,
    apps: [app],
  });
  const workspace = await computer.createWorkspace("u1");
  return workspace.tools();
}

describe("AISDKToolset", () => {
  it("builds each tool with the SDK's own tool() helper", async () => {
    const result = await tools();
    const search = result["search"] as Record<string, unknown>;

    // What tool() produces: no hand-rolled `type` field, a branded schema,
    // and an execute the SDK will call.
    expect(Object.keys(search).toSorted()).toEqual(["description", "execute", "inputSchema"]);
    expect(typeof search["execute"]).toBe("function");
  });

  it("produces an object keyed by tool name, as the AI SDK expects", async () => {
    const result = await tools();

    expect(Object.keys(result)).toEqual(["search", "code", "run"]);
  });

  it("wraps each input schema the way the AI SDK reads JSON Schema", async () => {
    const result = await tools();

    const search = result["search"] as {
      description?: string;
      inputSchema: { jsonSchema?: unknown };
    };

    expect(search.description).toContain("Find actions");
    // jsonSchema() brands the schema with a validator; the SDK rejects a bare
    // object, so the brand is what matters here. (Matching the whole branded
    // object deep-recurses on its `_type` field.)
    expect(search.inputSchema.jsonSchema).toMatchObject({
      type: "object",
      required: ["useCase"],
    });
    // Wrapped, not bare: a raw JSON Schema object is rejected by the SDK.
    expect(Object.getOwnPropertySymbols(search.inputSchema).map(String)).toContain(
      "Symbol(vercel.ai.schema)",
    );
  });

  it("executes a tool through the workspace", async () => {
    const result = await tools();

    // The shell is reached through `run` now, like any other action.
    await expect(
      result["run"]!.execute({ ref: "bash", args: { cmd: "echo hi" } }),
    ).resolves.toMatchObject({
      status: "ok",
      value: { stdout: "hi\n", exitCode: 0 },
    });
  });

  it("returns errors to the model instead of throwing out of the agent loop", async () => {
    const result = await tools();

    // One envelope, not two: the meta tool does not wrap the inner result.
    await expect(result["run"]!.execute({ ref: "nope.missing" })).resolves.toMatchObject({
      status: "error",
      error: {
        code: "unknown_ref",
        message: expect.stringContaining("nope.missing"),
        hint: expect.stringContaining("search"),
        retryable: false,
      },
    });
  });

  it("truncates oversized string output", async () => {
    const result = await tools({ maxOutputChars: 100 });
    await result["run"]!.execute({
      ref: "fs.write",
      args: { path: "/big.txt", content: "y".repeat(5000) },
    });

    const read = await result["run"]!.execute({ ref: "fs.read", args: { path: "/big.txt" } });

    expect(JSON.stringify(read)).toContain("truncated");
  });

  it("truncates an oversized object into a preview", async () => {
    const result = await tools({ maxOutputChars: 20 });

    const written = (await result["run"]!.execute({
      ref: "fs.write",
      args: { path: "/a.txt", content: "x" },
    })) as Record<string, unknown>;

    expect(written).toMatchObject({ truncated: true, preview: expect.any(String) });
  });

  it("dispatches the generic run tool to the ref in its arguments", async () => {
    const result = await tools();

    await expect(
      result["run"]!.execute({ ref: "demo.greet", args: { name: "ada" } }),
    ).resolves.toEqual({ status: "ok", value: { greeting: "hello ada" } });
  });

  it("honours an explicit tool subset", async () => {
    const result = await tools({ only: ["search", "run"] });

    expect(Object.keys(result)).toEqual(["search", "run"]);
  });
});

const call = (toolName: string, input: string) =>
  ({ type: "tool-call", toolCallId: "call-1", toolName, input }) as const;

const repair = (
  toolName: string,
  input: string,
  available: Record<string, unknown> = { run: {} },
) =>
  repairToRun()({
    toolCall: call(toolName, input),
    tools: available as never,
    error: new NoSuchToolError({ toolName, availableTools: Object.keys(available) }),
  } as never);

describe("repairToRun", () => {
  it("rewrites a call to a built-in's name into a run call for that ref", async () => {
    // The failure this exists for: `code` is a tool as well as a ref, so a
    // model handed it called `bash` the same way — and an undeclared tool
    // name is rejected before anything runs, costing the whole turn.
    const repaired = await repair("bash", JSON.stringify({ cmd: "ls /data" }));

    expect(repaired?.toolName).toBe("run");
    expect(JSON.parse(repaired?.input ?? "{}")).toEqual({
      ref: "bash",
      args: { cmd: "ls /data" },
    });
  });

  it("keeps the tool call id, so the result lands on the right call", async () => {
    const repaired = await repair("bash", "{}");

    expect(repaired?.toolCallId).toBe("call-1");
  });

  it("passes a name that is not a real ref through anyway", async () => {
    // Being wrong here is cheap: dispatch answers an unknown ref with an
    // error envelope carrying a hint, which the model can act on. A dead
    // turn gives it nothing to act on at all.
    const repaired = await repair("teleport", JSON.stringify({ to: "mars" }));

    expect(JSON.parse(repaired?.input ?? "{}")).toEqual({
      ref: "teleport",
      args: { to: "mars" },
    });
  });

  it("treats unparseable arguments as none rather than throwing", async () => {
    // The hook runs on a call that was already wrong once; throwing inside it
    // would take the turn it exists to save.
    const repaired = await repair("bash", "{ not json");

    expect(JSON.parse(repaired?.input ?? "{}")).toEqual({ ref: "bash", args: {} });
  });

  it("declines when there is no run tool to repair to", async () => {
    expect(await repair("bash", "{}", { search: {} })).toBeNull();
  });

  it("leaves a malformed-arguments error alone", async () => {
    // That is InvalidToolInputError, a real schema mismatch. Guessing at a
    // fix would hide it.
    const repaired = await repairToRun()({
      toolCall: call("run", "{}"),
      tools: { run: {} } as never,
      error: new Error("invalid input") as never,
    } as never);

    expect(repaired).toBeNull();
  });
});
