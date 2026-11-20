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
 * QuickJS compiled to WebAssembly.
 *
 * The strongest isolation available in-process: guest code runs in its own
 * wasm memory with a hard memory cap and an interrupt handler that stops long
 * loops. Execution happens in a warm worker (see worker-pool.ts) because
 * QuickJS runs synchronously - on the main thread a runaway guest would block
 * the server itself.
 *
 * The workspace is exposed as a small synchronous `fs` global rather than
 * node-style modules, since QuickJS has no host filesystem at all.
 */
export const quickjsRuntime: SandboxRuntime = {
  id: "quickjs",
  label: "QuickJS",
  language: "javascript",
  isolation: "wasm",
  description:
    "QuickJS (ES2023) in WebAssembly. Hard memory cap, interruptible loops, no host access.",
  defaultEntry: "/work/main.js",
  editorLanguage: "javascript",

  async available(): Promise<RuntimeAvailability> {
    try {
      const { getQuickJS } = await import("quickjs-emscripten");
      await getQuickJS();
      return { ok: true, detail: "quickjs-emscripten, wasm in a worker" };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  },

  async run(request: RunRequest, emit: (event: RunEvent) => void): Promise<RunOutcome> {
    const result = await poolFor("quickjs").run(
      {
        code: request.code,
        files: request.files,
        entry: request.entryPath ?? quickjsRuntime.defaultEntry,
        limits: { ...DEFAULT_LIMITS, ...request.limits },
      },
      emit,
    );
    return { files: result.files };
  },
};
