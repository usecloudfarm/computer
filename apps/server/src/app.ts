import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import { runWithGuards, type RunEvent, type RuntimeRegistry } from "@unsandbox/sandbox-core";
import { samplesFor } from "@unsandbox/runtimes";
import { WorkspaceStore } from "./workspace.js";

export interface AppOptions {
  readonly registry: RuntimeRegistry;
  readonly store?: WorkspaceStore;
  /** Directory of built studio assets to serve at `/`, when present. */
  readonly staticRoot?: string;
}

const SESSION_HEADER = "x-session-id";

/** Builds the Hono app. Exported separately from the server so tests can call it directly. */
export function createApp(options: AppOptions) {
  const registry = options.registry;
  const store = options.store ?? new WorkspaceStore();
  const app = new Hono();

  app.use("/api/*", cors({ origin: "*", allowHeaders: ["content-type", SESSION_HEADER] }));

  const sessionOf = (header: string | undefined): string => header?.trim() || "default";

  // --- runtimes ------------------------------------------------------------

  app.get("/api/runtimes", async (c) => {
    const runtimes = await Promise.all(
      registry.list().map(async (runtime) => {
        const availability = await runtime.available();
        return {
          id: runtime.id,
          label: runtime.label,
          language: runtime.language,
          isolation: runtime.isolation,
          description: runtime.description,
          defaultEntry: runtime.defaultEntry,
          editorLanguage: runtime.editorLanguage,
          available: availability.ok,
          detail: availability.detail ?? null,
          samples: samplesFor(runtime.id).map(({ id, title, description }) => ({
            id,
            title,
            description,
          })),
        };
      }),
    );
    return c.json({ runtimes });
  });

  app.get("/api/runtimes/:id/samples/:sampleId", (c) => {
    const sample = samplesFor(c.req.param("id")).find((s) => s.id === c.req.param("sampleId"));
    if (!sample) return c.json({ error: "No such sample" }, 404);
    return c.json({ sample });
  });

  // --- workspace -----------------------------------------------------------

  app.get("/api/files", (c) => {
    const workspace = store.get(sessionOf(c.req.header(SESSION_HEADER)));
    return c.json({ tree: workspace.tree("/"), files: workspace.snapshot() });
  });

  app.get("/api/file", (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path is required" }, 400);
    const workspace = store.get(sessionOf(c.req.header(SESSION_HEADER)));
    if (!workspace.has(path)) return c.json({ error: `No such file: ${path}` }, 404);
    return c.json({ path, contents: workspace.read(path) });
  });

  app.put("/api/file", async (c) => {
    const body = await c.req.json<{ path?: string; contents?: string }>().catch(() => null);
    if (!body?.path || typeof body.contents !== "string") {
      return c.json({ error: "path and contents are required" }, 400);
    }
    const workspace = store.get(sessionOf(c.req.header(SESSION_HEADER)));
    workspace.write(body.path, body.contents);
    return c.json({ path: body.path, tree: workspace.tree("/") });
  });

  app.delete("/api/file", async (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path is required" }, 400);
    const workspace = store.get(sessionOf(c.req.header(SESSION_HEADER)));
    const removed = workspace.remove(path);
    return c.json({ removed, tree: workspace.tree("/") });
  });

  app.post("/api/workspace/reset", (c) => {
    const workspace = store.reset(sessionOf(c.req.header(SESSION_HEADER)));
    return c.json({ tree: workspace.tree("/"), files: workspace.snapshot() });
  });

  // --- execution -----------------------------------------------------------

  /**
   * Streams a run as server-sent events. Each event is one {@link RunEvent},
   * plus a final `workspace` event carrying the tree the run left behind.
   */
  app.post("/api/run", async (c) => {
    const body = await c.req
      .json<{
        runtime?: string;
        code?: string;
        entryPath?: string;
        stdin?: string;
        timeoutMs?: number;
        memoryBytes?: number;
      }>()
      .catch(() => null);

    if (!body?.runtime || typeof body.code !== "string") {
      return c.json({ error: "runtime and code are required" }, 400);
    }

    let runtime;
    try {
      runtime = registry.get(body.runtime);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 404);
    }

    const availability = await runtime.available();
    if (!availability.ok) {
      return c.json(
        { error: `Runtime "${runtime.id}" is unavailable: ${availability.detail ?? "unknown"}` },
        503,
      );
    }

    const workspace = store.get(sessionOf(c.req.header(SESSION_HEADER)));
    const entryPath = body.entryPath ?? runtime.defaultEntry;
    // Bind the validated fields: TypeScript drops property narrowing inside
    // the streaming callback below.
    const code = body.code;
    const stdin = body.stdin;
    const timeoutMs = body.timeoutMs;
    const memoryBytes = body.memoryBytes;

    return streamSSE(c, async (stream) => {
      const send = (event: string, data: unknown) =>
        stream.writeSSE({ event, data: JSON.stringify(data) });

      await send("start", {
        runtime: runtime.id,
        isolation: runtime.isolation,
        entryPath,
        startedAt: new Date().toISOString(),
      });

      const queue: RunEvent[] = [];
      const outcome = await runWithGuards(
        runtime,
        {
          code,
          files: workspace.snapshot(),
          entryPath,
          ...(stdin !== undefined ? { stdin } : {}),
          limits: {
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            ...(memoryBytes !== undefined ? { memoryBytes } : {}),
          },
        },
        (event) => queue.push(event),
      );

      // Runtimes emit synchronously while they run; flush in order afterwards.
      for (const event of queue) await send(event.type, event);

      const changed = workspace.applySnapshot(outcome.files);
      await send("workspace", { changed, tree: workspace.tree("/") });
      await send("done", { changed: changed.length });
    });
  });

  app.get("/api/health", (c) => c.json({ ok: true, sessions: store.size }));

  // --- studio --------------------------------------------------------------

  if (options.staticRoot) {
    const root = options.staticRoot;
    app.use("/assets/*", serveStatic({ root }));
    app.get("/", serveStatic({ path: "index.html", root }));
    app.get("*", serveStatic({ path: "index.html", root }));
  }

  return app;
}
