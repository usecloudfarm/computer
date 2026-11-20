import type { DirectoryNode, RunEvent, RuntimeInfo } from "./types.js";

const SESSION_KEY = "unsandbox.session";

/** A stable per-browser session, so the workspace survives a reload. */
export function sessionId(): string {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = `s-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-session-id": sessionId(),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${init.method ?? "GET"} ${path} failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export const api = {
  runtimes: () => request<{ runtimes: RuntimeInfo[] }>("/api/runtimes"),

  sample: (runtimeId: string, sampleId: string) =>
    request<{ sample: { id: string; title: string; code: string } }>(
      `/api/runtimes/${runtimeId}/samples/${sampleId}`,
    ),

  files: () => request<{ tree: DirectoryNode; files: Record<string, string> }>("/api/files"),

  readFile: (path: string) =>
    request<{ path: string; contents: string }>(`/api/file?path=${encodeURIComponent(path)}`),

  writeFile: (path: string, contents: string) =>
    request<{ tree: DirectoryNode }>("/api/file", {
      method: "PUT",
      body: JSON.stringify({ path, contents }),
    }),

  deleteFile: (path: string) =>
    request<{ removed: string[]; tree: DirectoryNode }>(
      `/api/file?path=${encodeURIComponent(path)}`,
      { method: "DELETE" },
    ),

  resetWorkspace: () =>
    request<{ tree: DirectoryNode; files: Record<string, string> }>("/api/workspace/reset", {
      method: "POST",
    }),
};

export interface RunHandlers {
  onStart: (info: { runtime: string; isolation: string; entryPath: string }) => void;
  onEvent: (event: RunEvent) => void;
  onWorkspace: (payload: { changed: string[]; tree: DirectoryNode }) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

/**
 * POSTs a run and parses the SSE stream.
 *
 * `fetch` rather than `EventSource` because the run parameters go in a body,
 * and because this way the request can be aborted when the user hits Stop.
 */
export async function runCode(
  body: { runtime: string; code: string; entryPath?: string; timeoutMs?: number },
  handlers: RunHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": sessionId() },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") return;
    handlers.onError((error as Error).message);
    return;
  }

  if (!response.ok || !response.body) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    handlers.onError(payload.error ?? `Run failed (${response.status})`);
    return;
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        dispatch(buffer.slice(0, boundary), handlers);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if ((error as Error).name !== "AbortError") handlers.onError((error as Error).message);
  }
}

function dispatch(block: string, handlers: RunHandlers): void {
  const name = /^event:\s*(.+)$/m.exec(block)?.[1]?.trim();
  const raw = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  if (!name || !raw) return;

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }

  switch (name) {
    case "start":
      handlers.onStart(data as Parameters<RunHandlers["onStart"]>[0]);
      return;
    case "workspace":
      handlers.onWorkspace(data as Parameters<RunHandlers["onWorkspace"]>[0]);
      return;
    case "done":
      handlers.onDone();
      return;
    default:
      handlers.onEvent(data as RunEvent);
  }
}
