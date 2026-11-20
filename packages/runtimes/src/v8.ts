import { DEFAULT_LIMITS } from "@unsandbox/sandbox-core";
import type {
  RunEvent,
  RunOutcome,
  RunRequest,
  RuntimeAvailability,
  SandboxRuntime,
} from "@unsandbox/sandbox-core";
import { poolFor } from "./worker-pool.js";

/**
 * Node's own V8, in a worker thread.
 *
 * A worker is a separate V8 isolate with its own heap, which can be
 * terminated mid-loop - the difference between this and a bare `vm` context on
 * the main thread, where a tight loop is unstoppable. The guest still sees a
 * JavaScript global object assembled by the host, so this is the fastest
 * engine here but the weakest boundary of the three JavaScript options: treat
 * it as "untrusted code I wrote", not "untrusted code a stranger wrote".
 */
export const v8Runtime: SandboxRuntime = {
  id: "v8",
  label: "V8 isolate",
  language: "javascript",
  isolation: "v8-isolate",
  description:
    "Node's V8 in a worker thread: own heap, killable, full speed. Weaker boundary than wasm.",
  defaultEntry: "/work/main.js",
  editorLanguage: "javascript",

  async available(): Promise<RuntimeAvailability> {
    return { ok: true, detail: `node ${process.versions.node}, v8 ${process.versions.v8}` };
  },

  async run(request: RunRequest, emit: (event: RunEvent) => void): Promise<RunOutcome> {
    const result = await poolFor("v8").run(
      {
        code: request.code,
        files: request.files,
        entry: request.entryPath ?? v8Runtime.defaultEntry,
        limits: { ...DEFAULT_LIMITS, ...request.limits },
      },
      emit,
    );
    return { files: result.files };
  },
};
