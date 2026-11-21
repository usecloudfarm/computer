import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Computer } from "@cloudfarm/core";
import type { App } from "@cloudfarm/core";
import { fakeSandbox } from "@cloudfarm/core/testing";
import { AISDKToolset } from "./index.js";

const app: App = {
  id: "demo",
  name: "Demo",
  description: "A demo app.",
  allowedHosts: ["example.test"],
  authorize: (request) => request,
  capabilities: () => [
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
    apps: [app],
  });
  const workspace = await computer.createWorkspace("u1");
  return workspace.tools();
}

describe("AISDKToolset", () => {
  it("produces an object keyed by tool name, as the AI SDK expects", async () => {
    const result = await tools();

    expect(Object.keys(result)).toEqual([
      "bash",
      "search",
      "run",
      "fs_read",
      "fs_write",
      "fs_list",
    ]);
  });

  it("wraps each input schema the way the AI SDK reads JSON Schema", async () => {
    const result = await tools();

    expect(result["search"]).toMatchObject({
      description: expect.stringContaining("Find capabilities"),
      inputSchema: { jsonSchema: { type: "object", required: ["useCase"] } },
    });
  });

  it("executes a tool through the workspace", async () => {
    const result = await tools();

    await expect(result["bash"]!.execute({ cmd: "echo hi" })).resolves.toMatchObject({
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
    await result["fs_write"]!.execute({ path: "/big.txt", content: "y".repeat(5000) });

    const read = await result["fs_read"]!.execute({ path: "/big.txt" });

    expect(JSON.stringify(read)).toContain("truncated");
  });

  it("truncates an oversized object into a preview", async () => {
    const result = await tools({ maxOutputChars: 20 });

    const written = (await result["fs_write"]!.execute({
      path: "/a.txt",
      content: "x",
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
