import {
  newQuickJSAsyncWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
  type QuickJSAsyncContext,
  type QuickJSAsyncWASMModule,
  type QuickJSHandle,
} from "quickjs-emscripten-core";
import { finishResult, Redactor } from "@cloudfarm/core";
import type { CodeEngine, CodeJob, HostBridge, ActionBridge } from "@cloudfarm/core";
import type { CodeResult, Diagnostic, Json } from "@cloudfarm/core";

/** Anything that resolves to a QuickJS async module: a variant, or a loader. */
export type VariantLoader = () => Promise<QuickJSAsyncWASMModule>;

/**
 * Code mode's execution engine: QuickJS compiled to WebAssembly.
 *
 * Chosen over a worker thread or a remote sandbox for three reasons:
 *
 * 1. **It runs on Workers.** A statically imported `WebAssembly.Module` is the
 *    only wasm Workers will compile, and the variants ship a `workerd` export
 *    for exactly that.
 * 2. **It stops itself.** You cannot terminate a thread on Workers, so an
 *    engine without a cooperative interrupt is unshippable there. QuickJS's
 *    interrupt handler stops a `while (true)` within milliseconds of the
 *    deadline.
 * 3. **Host calls are local.** Generated code is glue: a script making a dozen
 *    action calls would pay a dozen network round trips on a remote
 *    sandbox, which is exactly the cost code mode exists to avoid.
 *
 * The guest gets no ambient authority at all — no fetch, no filesystem, no
 * timers that outlive the run. Its only reach into the host is `__host`, and
 * a credential is therefore not merely hidden from it but unreachable: there
 * is no object graph connecting guest memory to the host heap.
 */
export class QuickJSEngine implements CodeEngine {
  readonly id = "quickjs";
  readonly description =
    "Runs JavaScript (ES2023) in a WebAssembly isolate with no network or filesystem access. " +
    "Actions are in scope as objects; everything else is unavailable.";
  readonly capabilities = {
    asyncHostCalls: true,
    // Asyncify suspends the whole wasm stack across a host call, so the guest
    // sees an ordinary return — and `await` is a syntax error in the eval
    // mode this uses.
    guestAwait: false,
    interruptible: true,
    memoryCap: true,
  };

  readonly #load: VariantLoader;
  #module: Promise<QuickJSAsyncWASMModule> | undefined;

  constructor(load: VariantLoader) {
    this.#load = load;
  }

  async available(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.#moduleOnce();
      return { ok: true, detail: "QuickJS (asyncify) on WebAssembly" };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Compiles without running. QuickJS is the same parser that will execute the
   * code, so a clean compile here means the only failures left are runtime
   * ones — and a syntax error reaches the agent having touched nothing.
   */
  async validate(source: string): Promise<Diagnostic[]> {
    const module = await this.#moduleOnce();
    const runtime = module.newRuntime();
    const context = runtime.newContext();
    try {
      const compiled = context.evalCode(`(() => {\n${source}\n})`, "validate.js", {
        compileOnly: true,
      });
      if (!compiled.error) {
        compiled.value.dispose();
        return [];
      }
      const error = readError(context, compiled.error);
      compiled.error.dispose();
      return [
        {
          code: "syntax_error",
          message: error.message,
          ...(lineOf(error) !== undefined ? { line: lineOf(error)! } : {}),
          ...(/\bawait\b/.test(source)
            ? { hint: "Code mode is synchronous: drop `await` and call run() directly." }
            : {}),
        },
      ];
    } finally {
      try {
        context.dispose();
      } catch {
        /* nothing ran, but be defensive */
      }
      try {
        runtime.dispose();
      } catch {
        /* ditto */
      }
    }
  }

  async evaluate(job: CodeJob, bridge: HostBridge): Promise<CodeResult> {
    const started = Date.now();
    const module = await this.#moduleOnce();
    const redactor = new Redactor();

    // One runtime and context per run, never reused: a leaked closure between
    // runs would be a cross-workspace leak.
    const runtime = module.newRuntime();
    runtime.setMemoryLimit(job.limits.memoryBytes);
    runtime.setMaxStackSize(1024 * 1024);

    const controller = new AbortController();
    const extraLimits = new Set<string>();

    // Two clocks. The interrupt handler covers guest CPU, but it cannot fire
    // while the stack is unwound inside a host call, so a wall-clock timer
    // covers that half. Without both, a hung action is unkillable.
    const cpuDeadline = Date.now() + job.limits.cpuTimeoutMs;
    let wallClockExpired = false;
    const wallClock = setTimeout(() => {
      wallClockExpired = true;
      controller.abort();
    }, job.limits.timeoutMs);

    runtime.setInterruptHandler(() => {
      if (wallClockExpired) return true;
      return shouldInterruptAfterDeadline(cpuDeadline)(runtime);
    });

    const context = runtime.newContext();
    try {
      installHostBridge(context, bridge, controller.signal);
      installLogging(context, bridge);

      // The guest runs in one synchronous frame. Asyncify makes each host call
      // look synchronous to QuickJS while the host does real async work
      // underneath, so generated code never touches a promise — and the job
      // queue, which cannot be pumped safely while the wasm stack is unwound,
      // never comes into it.
      const source = `${job.prelude}\n(() => {\n${job.source}\n})()`;
      const evaluated = await context.evalCodeAsync(source, `${job.runId}.js`);

      if (evaluated.error) {
        const error = readError(context, evaluated.error);
        evaluated.error.dispose();
        return this.#result(
          bridge,
          started,
          redactor,
          error,
          extraLimits,
          wallClockExpired,
          job.source,
        );
      }

      const value = context.dump(evaluated.value) as Json | undefined;
      evaluated.value.dispose();

      return finishResult({
        outcome: "ok",
        ...(value !== undefined ? { value } : {}),
        bridge: bridge as ActionBridge,
        durationMs: Date.now() - started,
        redactor,
        extraLimits: [...extraLimits],
      });
    } finally {
      clearTimeout(wallClock);
      // An interrupted context can refuse disposal; a failure here must not
      // mask the run's own result.
      try {
        context.dispose();
      } catch {
        /* interrupted mid-execution */
      }
      try {
        runtime.dispose();
      } catch {
        /* ditto */
      }
    }
  }

  async dispose(): Promise<void> {
    this.#module = undefined;
  }

  #moduleOnce(): Promise<QuickJSAsyncWASMModule> {
    this.#module ??= this.#load();
    return this.#module;
  }

  #result(
    bridge: HostBridge,
    started: number,
    redactor: Redactor,
    error: { name: string; message: string; stack?: string },
    extraLimits: Set<string>,
    wallClockExpired: boolean,
    source = "",
  ): CodeResult {
    // "interrupted" is QuickJS's word for "your deadline fired".
    const timedOut = wallClockExpired || /interrupted/i.test(error.message);
    if (timedOut) extraLimits.add(wallClockExpired ? "timeoutMs" : "cpuTimeoutMs");

    const outOfMemory = /out of memory/i.test(error.message);
    if (outOfMemory) extraLimits.add("memoryBytes");

    // Models reach for `await` by habit, and QuickJS's syntax errors are terse
    // ("expecting ';'"), so check the source rather than the message.
    const usedAwait = error.name === "SyntaxError" && /\bawait\b/.test(source);

    return finishResult({
      outcome: timedOut ? "timeout" : outOfMemory ? "limit_exceeded" : "error",
      error: timedOut
        ? { name: "TimeoutError", message: "The run exceeded its time limit and was stopped." }
        : usedAwait
          ? {
              name: "SyntaxError",
              message:
                `${error.message}. Actions in code mode are synchronous: ` +
                "write `const result = slack.sendMessage({...})` with no `await`.",
            }
          : error,
      bridge: bridge as ActionBridge,
      durationMs: Date.now() - started,
      redactor,
      extraLimits: [...extraLimits],
    });
  }
}

/**
 * The guest's single point of contact with the host.
 *
 * Asyncify lets a host function return a promise: the wasm stack unwinds, the
 * host awaits, and the stack is rewound — so guest code writes a plain
 * `await slack.sendMessage(...)` and gets correct semantics. Calls are
 * serialised per run, because a context cannot be re-entered while unwound.
 */
function installHostBridge(
  context: QuickJSAsyncContext,
  bridge: HostBridge,
  signal: AbortSignal,
): void {
  let seq = 0;

  const host = context.newAsyncifiedFunction(
    "__host_raw",
    async (actionHandle: QuickJSHandle, argsHandle: QuickJSHandle) => {
      const action = context.getString(actionHandle);
      const raw = context.getString(argsHandle);
      const args = raw === "null" ? undefined : (JSON.parse(raw) as Json);

      const response = await bridge.call(
        { v: 1, seq: seq++, action, ...(args !== undefined ? { args } : {}) },
        signal,
      );
      return context.newString(JSON.stringify(response));
    },
  );
  context.setProp(context.global, "__host_raw", host);
  host.dispose();

  // A thin wrapper turns the frame protocol into plain values and exceptions.
  // It is synchronous: asyncify suspends the whole wasm stack across the host
  // call, so the guest sees an ordinary function return.
  const installed = context.evalCode(`
    globalThis.__host = (action, input) => {
      const response = JSON.parse(__host_raw(action, JSON.stringify(input ?? null)));
      // A completed host call already carries the { status, value | error }
      // envelope. A failed frame — a limit, a cancellation — is wrapped in the
      // same shape, so guest code only ever checks one thing.
      if (response.ok) return response.value;
      return { status: "error", error: response.error };
    };
  `);
  if (installed.error) installed.error.dispose();
  else installed.value.dispose();
}

function installLogging(context: QuickJSAsyncContext, bridge: HostBridge): void {
  const log = context.newFunction("__log", (levelHandle, argsHandle) => {
    const level = context.getString(levelHandle) as "log" | "warn" | "error";
    bridge.log(level, context.dump(argsHandle) as unknown[]);
    return context.undefined;
  });
  context.setProp(context.global, "__log", log);
  log.dispose();
}

/** QuickJS puts the position in the stack: `at <eval> (validate.js:3:5)`. */
function lineOf(error: { stack?: string }): number | undefined {
  const match = /validate\.js:(\d+)/.exec(error.stack ?? "");
  if (!match) return undefined;
  // The wrapper adds one line above the model's source.
  const line = Number(match[1]) - 1;
  return line > 0 ? line : undefined;
}

function readError(
  context: QuickJSAsyncContext,
  handle: QuickJSHandle,
): { name: string; message: string; stack?: string } {
  const dumped = context.dump(handle) as
    { name?: string; message?: string; stack?: string } | string;
  if (typeof dumped === "string") return { name: "Error", message: dumped };
  return {
    name: dumped.name ?? "Error",
    message: dumped.message ?? "Unknown error",
    ...(dumped.stack !== undefined ? { stack: dumped.stack } : {}),
  };
}

/** Builds an engine from an already-resolved variant. */
export function engineFromVariant(
  variant: Parameters<typeof newQuickJSAsyncWASMModuleFromVariant>[0],
): QuickJSEngine {
  return new QuickJSEngine(() => newQuickJSAsyncWASMModuleFromVariant(variant));
}
