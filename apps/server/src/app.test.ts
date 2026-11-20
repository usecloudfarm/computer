import { describe, expect, it } from "vitest";
import { RuntimeRegistry } from "@unsandbox/sandbox-core";
import type { SandboxRuntime } from "@unsandbox/sandbox-core";
import { createApp } from "./app.js";
import { WorkspaceStore } from "./workspace.js";

/** An echo runtime, so the HTTP layer is tested without any real engine. */
const echoRuntime: SandboxRuntime = {
  id: "echo",
  label: "Echo",
  language: "javascript",
  isolation: "wasm",
  description: "writes its input back",
  defaultEntry: "/work/main.js",
  editorLanguage: "javascript",
  available: async () => ({ ok: true, detail: "always" }),
  run: async (request, emit) => {
    emit({ type: "stdout", data: `ran ${request.code}\n` });
    emit({ type: "files", changed: ["/work/out/echo.txt"] });
    emit({ type: "exit", code: 0, durationMs: 1 });
    return { files: { ...request.files, "/work/out/echo.txt": request.code } };
  },
};

const brokenRuntime: SandboxRuntime = {
  ...echoRuntime,
  id: "broken",
  available: async () => ({ ok: false, detail: "no binary here" }),
};

function harness() {
  const store = new WorkspaceStore();
  const app = createApp({ registry: new RuntimeRegistry([echoRuntime, brokenRuntime]), store });
  return { app, store };
}

/** Collects `event:`/`data:` pairs out of an SSE response body. */
async function readSSE(response: Response): Promise<Array<{ event: string; data: unknown }>> {
  const text = await response.text();
  const events: Array<{ event: string; data: unknown }> = [];
  for (const block of text.split("\n\n")) {
    const event = /^event:\s*(.+)$/m.exec(block)?.[1];
    const data = /^data:\s*(.+)$/m.exec(block)?.[1];
    if (event && data) events.push({ event, data: JSON.parse(data) });
  }
  return events;
}

describe("GET /api/runtimes", () => {
  it("lists runtimes with availability and samples", async () => {
    const { app } = harness();

    const response = await app.request("/api/runtimes");
    const body = (await response.json()) as { runtimes: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.runtimes).toHaveLength(2);
    expect(body.runtimes[0]).toMatchObject({
      id: "echo",
      isolation: "wasm",
      available: true,
      detail: "always",
    });
    expect(body.runtimes[1]).toMatchObject({ id: "broken", available: false });
  });
});

describe("workspace endpoints", () => {
  it("serves the starter workspace as a tree", async () => {
    const { app } = harness();

    const body = (await (await app.request("/api/files")).json()) as {
      tree: { children: Array<{ name: string }> };
      files: Record<string, string>;
    };

    expect(Object.keys(body.files)).toContain("/work/README.md");
    expect(body.tree.children.map((child) => child.name)).toContain("work");
  });

  it("writes, reads back and deletes a file", async () => {
    const { app } = harness();

    const put = await app.request("/api/file", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/work/new.txt", contents: "hello" }),
    });
    expect(put.status).toBe(200);

    const get = await app.request("/api/file?path=/work/new.txt");
    expect(await get.json()).toEqual({ path: "/work/new.txt", contents: "hello" });

    const del = await app.request("/api/file?path=/work/new.txt", { method: "DELETE" });
    expect((await del.json()) as { removed: string[] }).toMatchObject({
      removed: ["/work/new.txt"],
    });
    expect((await app.request("/api/file?path=/work/new.txt")).status).toBe(404);
  });

  it("keeps sessions separate", async () => {
    const { app } = harness();

    await app.request("/api/file", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-session-id": "alice" },
      body: JSON.stringify({ path: "/work/alice.txt", contents: "mine" }),
    });

    const bob = (await (
      await app.request("/api/files", { headers: { "x-session-id": "bob" } })
    ).json()) as { files: Record<string, string> };

    expect(bob.files["/work/alice.txt"]).toBeUndefined();
  });

  it("validates its input", async () => {
    const { app } = harness();

    expect(
      (
        await app.request("/api/file", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: "/work/x" }),
        })
      ).status,
    ).toBe(400);
    expect((await app.request("/api/file")).status).toBe(400);
  });

  it("resets a workspace back to the starter files", async () => {
    const { app } = harness();
    await app.request("/api/file", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/work/scratch.txt", contents: "x" }),
    });

    const reset = (await (
      await app.request("/api/workspace/reset", { method: "POST" })
    ).json()) as { files: Record<string, string> };

    expect(reset.files["/work/scratch.txt"]).toBeUndefined();
    expect(reset.files["/work/README.md"]).toBeDefined();
  });
});

describe("POST /api/run", () => {
  it("streams start, run events, workspace and done", async () => {
    const { app } = harness();

    const response = await app.request("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runtime: "echo", code: "console.log(1)" }),
    });
    const events = await readSSE(response);

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(events.map((event) => event.event)).toEqual([
      "start",
      "stdout",
      "files",
      "exit",
      "workspace",
      "done",
    ]);
    expect(events[1]?.data).toMatchObject({ data: "ran console.log(1)\n" });
  });

  it("applies what the run wrote to the session workspace", async () => {
    const { app, store } = harness();

    await readSSE(
      await app.request("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json", "x-session-id": "s1" },
        body: JSON.stringify({ runtime: "echo", code: "payload" }),
      }),
    );

    expect(store.get("s1").read("/work/out/echo.txt")).toBe("payload");
  });

  it("refuses unknown and unavailable runtimes", async () => {
    const { app } = harness();
    const post = (runtime: string) =>
      app.request("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runtime, code: "x" }),
      });

    expect((await post("nope")).status).toBe(404);

    const unavailable = await post("broken");
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ error: /unavailable: no binary here/ });
  });

  it("requires a runtime and code", async () => {
    const { app } = harness();

    const response = await app.request("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runtime: "echo" }),
    });

    expect(response.status).toBe(400);
  });
});
