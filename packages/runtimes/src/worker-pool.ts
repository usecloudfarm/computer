import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { FileMap, RunEvent, RunLimits } from "@unsandbox/sandbox-core";

export type EngineId = "quickjs" | "v8" | "cpython";

interface RunMessage {
  id: number;
  code: string;
  files: FileMap;
  entry: string;
  limits: Required<RunLimits>;
}

type WorkerMessage =
  | { kind: "ready" }
  | { id: number; kind: "event"; event: RunEvent }
  | { id: number; kind: "done"; code: number; files: FileMap; durationMs: number };

export interface EngineResult {
  readonly code: number;
  readonly files: FileMap;
  readonly durationMs: number;
}

const WORKER_URL = new URL("./engine-worker.js", import.meta.url);

/**
 * A single warm worker per engine, with runs serialised through it.
 *
 * Keeping the worker alive is what makes an engine like Pyodide usable
 * interactively: the interpreter is loaded once, not per run. Running it in a
 * worker at all is what makes a runaway guest survivable - QuickJS and
 * Pyodide execute synchronously, so a `while (true)` on the main thread would
 * block the HTTP server itself and no timer could ever fire. Here the host
 * thread stays responsive and simply terminates the worker, which is the only
 * dependable way to stop synchronous wasm.
 *
 * A terminated worker is replaced on the next run, so the cost of a runaway
 * guest is one cold start rather than a dead server.
 */
export class EngineWorkerPool {
  readonly #engine: EngineId;
  #worker: Worker | undefined;
  #nextId = 1;
  /** Serialises runs: one guest at a time per engine. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(engine: EngineId) {
    this.#engine = engine;
  }

  /** True once the engine has been initialised and is still alive. */
  get warm(): boolean {
    return this.#worker !== undefined;
  }

  async run(
    request: { code: string; files: FileMap; entry: string; limits: Required<RunLimits> },
    emit: (event: RunEvent) => void,
  ): Promise<EngineResult> {
    const task = this.#queue.then(() => this.#execute(request, emit));
    // Keep the chain alive even when a run rejects.
    this.#queue = task.catch(() => undefined);
    return task;
  }

  async dispose(): Promise<void> {
    const worker = this.#worker;
    this.#worker = undefined;
    if (worker) await worker.terminate();
  }

  async #execute(
    request: { code: string; files: FileMap; entry: string; limits: Required<RunLimits> },
    emit: (event: RunEvent) => void,
  ): Promise<EngineResult> {
    const worker = await this.#ensureWorker();
    const id = this.#nextId++;
    const message: RunMessage = { id, ...request };

    const startedAt = Date.now();

    return await new Promise<EngineResult>((resolve) => {
      let settled = false;

      const cleanup = () => {
        clearTimeout(timer);
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
      };

      const finish = (result: EngineResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      /** Kills the worker: the only way to stop synchronous guest code. */
      const kill = (reason: string, code: number) => {
        if (settled) return;
        const durationMs = Date.now() - startedAt;
        emit({ type: "error", message: reason });
        // Report the terminal exit here: the guest never got to report one.
        emit({ type: "exit", code, durationMs });
        this.#worker = undefined;
        void worker.terminate();
        finish({ code, files: request.files, durationMs });
      };

      const timer = setTimeout(
        () =>
          kill(
            `Run exceeded the ${request.limits.timeoutMs}ms time limit; the ${this.#engine} worker was terminated`,
            124,
          ),
        request.limits.timeoutMs,
      );

      const onMessage = (payload: WorkerMessage) => {
        if (!("id" in payload) || payload.id !== id) return;
        if (payload.kind === "event") {
          emit(payload.event);
          return;
        }
        emit({ type: "exit", code: payload.code, durationMs: payload.durationMs });
        finish({ code: payload.code, files: payload.files, durationMs: payload.durationMs });
      };

      const onError = (error: Error) => {
        this.#worker = undefined;
        emit({
          type: "error",
          message: error.message,
          ...(error.stack !== undefined ? { stack: error.stack } : {}),
        });
        emit({ type: "exit", code: 1, durationMs: Date.now() - startedAt });
        finish({ code: 1, files: request.files, durationMs: Date.now() - startedAt });
      };

      const onExit = (exitCode: number) => {
        this.#worker = undefined;
        // Reached when the heap limit kills the isolate outright.
        if (!settled) {
          const code = exitCode === 0 ? 1 : exitCode;
          emit({ type: "error", message: `${this.#engine} worker exited with code ${exitCode}` });
          emit({ type: "exit", code, durationMs: Date.now() - startedAt });
          finish({ code, files: request.files, durationMs: Date.now() - startedAt });
        }
      };

      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
      worker.postMessage(message);
    });
  }

  async #ensureWorker(): Promise<Worker> {
    if (this.#worker) return this.#worker;

    const worker = new Worker(fileURLToPath(WORKER_URL), {
      workerData: { engine: this.#engine },
      // Let the host decide when to stop it; stdio is routed through messages.
      stdout: true,
      stderr: true,
    });
    worker.unref();

    await new Promise<void>((resolve, reject) => {
      const onReady = (payload: WorkerMessage) => {
        if ("kind" in payload && payload.kind === "ready") {
          worker.off("message", onReady);
          worker.off("error", reject);
          resolve();
        }
      };
      worker.on("message", onReady);
      worker.once("error", reject);
    });

    this.#worker = worker;
    return worker;
  }
}

const pools = new Map<EngineId, EngineWorkerPool>();

/** The process-wide pool for `engine`, created on first use. */
export function poolFor(engine: EngineId): EngineWorkerPool {
  let pool = pools.get(engine);
  if (!pool) {
    pool = new EngineWorkerPool(engine);
    pools.set(engine, pool);
  }
  return pool;
}

export async function disposeAllPools(): Promise<void> {
  await Promise.all([...pools.values()].map((pool) => pool.dispose()));
  pools.clear();
}
