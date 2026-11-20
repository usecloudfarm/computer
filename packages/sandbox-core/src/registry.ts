import { DEFAULT_LIMITS } from "./types.js";
import type { RunEvent, RunRequest, RunOutcome, SandboxRuntime } from "./types.js";

/** A keyed set of runtimes, so the server and UI stay agnostic about engines. */
export class RuntimeRegistry {
  readonly #runtimes = new Map<string, SandboxRuntime>();

  constructor(runtimes: readonly SandboxRuntime[] = []) {
    for (const runtime of runtimes) this.register(runtime);
  }

  register(runtime: SandboxRuntime): this {
    if (this.#runtimes.has(runtime.id)) {
      throw new Error(`Runtime "${runtime.id}" is already registered`);
    }
    this.#runtimes.set(runtime.id, runtime);
    return this;
  }

  get(id: string): SandboxRuntime {
    const runtime = this.#runtimes.get(id);
    if (!runtime) {
      throw new Error(`Unknown runtime "${id}". Known: ${[...this.#runtimes.keys()].join(", ")}`);
    }
    return runtime;
  }

  list(): SandboxRuntime[] {
    return [...this.#runtimes.values()];
  }
}

/**
 * Runs `request` on `runtime` with the limits filled in, guaranteeing that
 * exactly one terminal event (`exit` or `error` then `exit`) is emitted and
 * that a runtime which hangs or throws cannot wedge the caller.
 */
export async function runWithGuards(
  runtime: SandboxRuntime,
  request: RunRequest,
  emit: (event: RunEvent) => void,
): Promise<RunOutcome> {
  const limits = { ...DEFAULT_LIMITS, ...request.limits };
  const started = Date.now();
  let settled = false;

  const emitOnce = (event: RunEvent) => {
    if (settled && (event.type === "exit" || event.type === "error")) return;
    if (event.type === "exit") settled = true;
    emit(event);
  };

  try {
    const outcome = await Promise.race([
      runtime.run({ ...request, limits }, emitOnce),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`Run exceeded the ${limits.timeoutMs}ms time limit`)),
          // Give the runtime a moment past its own deadline to stop cleanly.
          limits.timeoutMs + 500,
        ),
      ),
    ]);
    if (!settled) emitOnce({ type: "exit", code: 0, durationMs: Date.now() - started });
    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    emitOnce({ type: "error", message, ...(stack !== undefined ? { stack } : {}) });
    emitOnce({ type: "exit", code: 1, durationMs: Date.now() - started });
    return { files: request.files };
  }
}
