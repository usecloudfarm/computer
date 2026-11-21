import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAction, createApp } from "./define.js";
import { Computer } from "./computer.js";
import { MemoryStorage } from "./vfs.js";

const publish = () =>
  createAction({
    summary: "Publish a report so the team can read it.",
    useCases: ["publish a report", "share results"],
    sideEffects: "write",
    input: z.object({ title: z.string(), body: z.string() }),
    output: z.object({ url: z.string() }),
    example: '{ title: "Q4", body: "# Q4" }',
    handler: (input) => ({ url: `https://reports.internal/${input.title}` }),
  });

const reports = () =>
  createApp({
    id: "reports",
    description: "Publishes finished reports to the team.",
    actions: { publish: publish() },
  });

describe("createApp", () => {
  it("takes the action name from the record key", () => {
    const [definition] = reports().actions();
    expect(definition?.name).toBe("publish");
  });

  it("wraps a bare input literal into a runnable example, so the ref cannot drift", () => {
    const [definition] = reports().actions();
    expect(definition?.example).toBe('run("reports.publish", { title: "Q4", body: "# Q4" })');
  });

  it("leaves an example that already calls run() alone", () => {
    const app = createApp({
      id: "reports",
      description: "Publishes reports.",
      actions: {
        publish: createAction({
          ...publish(),
          example: 'const r = run("reports.publish", { title: "Q4", body: "x" })',
        }),
      },
    });
    expect(app.actions()[0]?.example).toBe(
      'const r = run("reports.publish", { title: "Q4", body: "x" })',
    );
  });

  it("defaults name to the id, allowedHosts to none, and authorize to identity", () => {
    const app = reports();
    expect(app.name).toBe("reports");
    expect(app.allowedHosts).toEqual([]);
    const request = new Request("https://reports.internal/");
    expect(app.authorize(request).headers.get("authorization")).toBeNull();
  });

  it("runs through a Computer like any hand-written app", async () => {
    const computer = new Computer({ storage: new MemoryStorage(), apps: [reports()] });
    const workspace = await computer.createWorkspace("u");
    const result = await workspace.run("reports.publish", { title: "Q4", body: "# Q4" });
    expect(result).toEqual({
      status: "ok",
      value: { url: "https://reports.internal/Q4" },
    });
  });

  it("is searchable by its use cases", async () => {
    const computer = new Computer({ storage: new MemoryStorage(), apps: [reports()] });
    const workspace = await computer.createWorkspace("u");
    const found = await workspace.search("share the results with everyone");
    expect(found.actions[0]?.ref).toBe("reports.publish");
  });

  it("accepts a sync handler and awaits it anyway", async () => {
    const [definition] = reports().actions();
    const outcome = definition?.handler({ title: "Q4", body: "x" }, {} as never);
    expect(outcome).toBeInstanceOf(Promise);
    await expect(outcome).resolves.toEqual({ url: "https://reports.internal/Q4" });
  });
});

describe("createApp rejects authoring mistakes at construction", () => {
  const base = { description: "Publishes reports.", actions: { publish: publish() } };

  it("rejects an id that cannot be half of a ref", () => {
    expect(() => createApp({ ...base, id: "My Reports" })).toThrow(/must be lowercase/);
  });

  it("rejects an action name that is not an identifier", () => {
    expect(() =>
      createApp({ ...base, id: "reports", actions: { "publish-now": publish() } }),
    ).toThrow(/camelCase identifier/);
  });

  it("rejects an app with no actions", () => {
    expect(() => createApp({ ...base, id: "reports", actions: {} })).toThrow(/defines no actions/);
  });

  it("rejects a missing description, which is prompt text", () => {
    expect(() => createApp({ ...base, id: "reports", description: "  " })).toThrow(
      /needs a description/,
    );
  });

  it("rejects a credential with no egress allowlist", () => {
    expect(() => createApp({ ...base, id: "reports", authorize: (request) => request })).toThrow(
      /allows no hosts/,
    );
  });

  it("rejects an action with no useCases, which search could never reach", () => {
    expect(() =>
      createApp({
        ...base,
        id: "reports",
        actions: { publish: createAction({ ...publish(), useCases: [] }) },
      }),
    ).toThrow(/unreachable by search/);
  });

  it("rejects an empty example", () => {
    expect(() =>
      createApp({
        ...base,
        id: "reports",
        actions: { publish: createAction({ ...publish(), example: "  " }) },
      }),
    ).toThrow(/needs an example/);
  });
});
