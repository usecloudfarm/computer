import { Bash } from "just-bash";
import { snapshot, writeBack } from "@cloudfarm/bash";
import { finishResult, Redactor } from "@cloudfarm/core";
import type { ActionBridge, CodeEngine, CodeJob, CodeResult, HostBridge } from "@cloudfarm/core";

/**
 * Code mode run inside the bash sandbox.
 *
 * `@cloudfarm/quickjs` evaluates a script in an isolate of its own, which runs
 * anywhere — Workers included — and is why it is the default. This engine
 * trades that reach for the thing the isolate cannot have: the script runs in
 * the same process as the shell, so it can `await` a host call instead of
 * blocking on it.
 *
 * It is Node and Bun only, and not by accident. `just-bash` runs the guest in
 * a worker thread and parks it on `Atomics.wait` while the host does async
 * work on the main thread — which is exactly how `await` becomes possible, and
 * exactly what workerd cannot do, because a Worker cannot spawn threads. Pass
 * this engine explicitly; nothing resolves it as a default.
 *
 * The dialect does not change. `job.prelude` is core's, verbatim: the same
 * `run(ref, input)`, the same `console`, the same refusal of `fetch` and
 * `require`. Both engines build on the same two primitives — `__host` and
 * `__log` — so a script written for one runs on the other, and `await`
 * becomes something a script *may* use rather than something it must.
 */
export interface BashCodeOptions {
  /** Working directory for the guest. Defaults to `/`. */
  readonly cwd?: string;
  readonly env?: Record<string, string>;
}

export function bashCode(options: BashCodeOptions = {}): CodeEngine {
  return new BashCodeEngine(options);
}

/** Host function names. The guest reaches the host through these three only. */
const HOST = "host";
const LOG = "log";
const RESULT = "result";

class BashCodeEngine implements CodeEngine {
  readonly id = "bash-code";
  readonly description =
    "Runs JavaScript or TypeScript inside the bash sandbox. `await` works here: a host call " +
    "suspends the script rather than blocking it. No network; files are reached through run().";
  readonly capabilities = {
    asyncHostCalls: true,
    // The guest runs on its own thread, so `await` is ordinary syntax here.
    guestAwait: true,
    // js-exec gives the guest require() and the fs, path, os and process
    // shims behind it. Declaring this is what makes core hand over the
    // workspace filesystem, stop stubbing `require` in the prelude, and stop
    // rejecting it during validation — the three had to agree or the modules
    // would be present and unusable.
    guestModules: true,
    // The guest is parked on Atomics.wait inside a worker, so there is no
    // interrupt handler that can reclaim a non-yielding loop — the timeout
    // is what stops it, and it stops the whole worker.
    interruptible: false,
    memoryCap: true,
  };

  readonly #options: BashCodeOptions;

  constructor(options: BashCodeOptions) {
    this.#options = options;
  }

  async available(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const shell = this.#shell({}, async () => "", 1000);
      const probe = await shell.exec("js-exec -c 'void 0'");
      return probe.exitCode === 0
        ? { ok: true, detail: "QuickJS inside just-bash (Node and Bun only)" }
        : { ok: false, detail: probe.stderr.trim() || `js-exec exited ${probe.exitCode}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async evaluate(job: CodeJob, bridge: HostBridge): Promise<CodeResult> {
    const started = Date.now();
    const controller = new AbortController();
    const limitsHit: string[] = [];

    let seq = 0;
    let outcome: { ok: true; value?: unknown } | { ok: false; error: GuestError } | undefined;

    // Seeded before the shell exists, because just-bash takes its initial
    // files at construction. Without it the guest's `fs` is a scratch
    // filesystem: readFileSync was ENOENT for files the workspace had, and
    // writeFileSync reported success for writes nobody ever saw.
    const seeded = job.fs ? await snapshot(job.fs) : {};

    const shell = this.#shell(
      seeded,
      async (path, argsJson, signal) => {
        const payload: unknown = argsJson ? JSON.parse(argsJson) : {};

        if (path === LOG) {
          const { level, args } = payload as { level: "log" | "warn" | "error"; args: unknown[] };
          bridge.log(level, args ?? []);
          return "";
        }

        if (path === RESULT) {
          // The script's return value, delivered as a call rather than read off
          // stdout: stdout belongs to console.log, and a script that prints and
          // returns must not have the two run into each other.
          outcome = payload as typeof outcome;
          return "";
        }

        if (path === HOST) {
          const { action, args } = payload as { action: string; args?: unknown };
          // The bridge expects the first call to be seq 0 and rejects a gap, so
          // this post-increments. Starting at 1 made every run's first call
          // come back as an out-of-order internal error.
          const response = await bridge.call(
            {
              v: 1,
              seq: seq++,
              action,
              ...(args === null || args === undefined ? {} : { args: args as never }),
            },
            signal,
          );
          return JSON.stringify(response);
        }

        // The guest is given exactly three host functions. Anything else means
        // the prelude was bypassed, which is worth failing loudly rather than
        // quietly answering.
        throw new Error(`the guest may only call run(); got "${path}"`);
      },
      job.limits.timeoutMs,
    );

    const path = `/.cloudfarm/${job.runId}.js`;
    const script = wrap(job);
    await shell.fs.mkdir("/.cloudfarm").catch(() => {});
    await shell.fs.writeFile(path, script.text);

    const timer = setTimeout(() => controller.abort(), job.limits.timeoutMs);
    let timedOut = false;
    try {
      const run = await shell.exec(`js-exec ${path}`, { signal: controller.signal });
      timedOut = controller.signal.aborted;

      if (!timedOut && run.exitCode !== 0 && outcome === undefined) {
        const stderr = run.stderr.trim();
        // The sandbox enforces its own JS deadline, and it fires before the
        // host AbortController does. Without this the run came back as a
        // plain error and `limitsHit` was empty, which reads as a script that
        // failed rather than one that was stopped.
        if (/execution timeout/i.test(stderr)) {
          timedOut = true;
        } else {
          outcome = {
            ok: false,
            error: {
              name: "ExecError",
              message: relocate(stderr || `js-exec exited ${run.exitCode}`, path, script.offset),
            },
          };
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      timedOut = true;
    } finally {
      clearTimeout(timer);
      await shell.fs.rm(path).catch(() => {});
      // Back out again, so a file the script wrote with `fs` is a file the
      // workspace has. Runs even on the timeout path: partial work is still
      // work, and the same is true of the `run("bash")` route.
      if (job.fs) await writeBack(job.fs, shell, seeded);
    }

    if (timedOut) limitsHit.push("timeoutMs");

    // `finishResult` is core's, not reimplemented here: it is what attaches
    // the logs and the per-call audit trail the bridge recorded, folds in the
    // limits the bridge hit, and runs the redactor over everything the model
    // will see. Assembling the shape by hand built a result that looked right
    // and silently reported no calls and no logs at all.
    const common = {
      bridge: bridge as ActionBridge,
      durationMs: Date.now() - started,
      extraLimits: limitsHit,
      // Model-facing output goes through this on the way out: an upstream
      // error that echoed a token back would otherwise land in the result.
      redactor: new Redactor(),
    };

    if (timedOut) {
      return finishResult({
        ...common,
        outcome: "timeout",
        error: {
          name: "TimeoutError",
          message: "The run exceeded its time limit and was stopped.",
        },
      });
    }
    if (outcome === undefined) {
      return finishResult({
        ...common,
        outcome: "error",
        error: {
          name: "NoResultError",
          message: "The script finished without reporting a result.",
        },
      });
    }
    if (!outcome.ok) {
      return finishResult({ ...common, outcome: "error", error: outcome.error });
    }
    return finishResult({
      ...common,
      outcome: "ok",
      ...(outcome.value === undefined || outcome.value === null
        ? {}
        : { value: outcome.value as never }),
    });
  }

  async dispose(): Promise<void> {}

  #shell(
    files: Record<string, string>,
    invokeTool: (path: string, argsJson: string, signal: AbortSignal) => Promise<string>,
    timeoutMs: number,
  ): InstanceType<typeof Bash> {
    const cwd = this.#options.cwd ?? "/";
    return new Bash({
      files,
      cwd,
      env: { ...this.#options.env, HOME: cwd, PWD: cwd },
      executionLimits: { maxJsTimeoutMs: timeoutMs },
      javascript: { bootstrap: BOOTSTRAP, invokeTool },
    });
  }
}

interface GuestError {
  name: string;
  message: string;
  stack?: string;
}

/**
 * The guest's side of the bridge, installed before the script.
 *
 * It defines `__host` and `__log` — the two primitives core's prelude builds
 * `run` and `console` on top of — and then takes `tools` away, so `run()` is
 * the only spelling that exists. The ref travels as an argument rather than
 * as a property path: `tools.slack.sendMessage(...)` would require every ref
 * to be a chain of valid identifiers, and the first ref that is not one would
 * split the dialect from what `run` actually accepts.
 */
const BOOTSTRAP = `
(() => {
  const host = tools.${HOST};
  const log = tools.${LOG};
  globalThis.__cloudfarm_result = tools.${RESULT};
  globalThis.__log = (level, args) => { log({ level, args }); };
  globalThis.__host = (action, input) => {
    const response = host({ action, args: input ?? null });
    // A completed host call already carries the { status, value | error }
    // envelope. A failed frame — a limit, a cancellation — is wrapped in the
    // same shape, so guest code only ever checks one thing.
    if (response.ok) return response.value;
    return { status: "error", error: response.error };
  };
  try { delete globalThis.tools; } catch { globalThis.tools = undefined; }
})();
`;

/**
 * Point a message back at the script the model wrote.
 *
 * Errors arrive with the wrapper's coordinates — `/.cloudfarm/code-2.js:16:7`
 * — because the prelude and the async wrapper sit above the source. Sixteen
 * lines into a nine-line script is worse than no line number at all, so the
 * offset comes off and the temp path goes with it.
 */
function relocate(message: string, path: string, offset: number): string {
  return message
    .replaceAll(
      new RegExp(`${escapeRegExp(path)}:(\\d+):(\\d+)`, "g"),
      (_, line: string, column: string) => `line ${Math.max(1, Number(line) - offset)}:${column}`,
    )
    .replaceAll(path, "the script");
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * The script, wrapped so its return value and its throw both come back.
 *
 * `js-exec` runs a `.js` file as a function body, which is the shape core's
 * code mode already has — `return` reports a value — but it discards that
 * value, and the engine needs it. An async wrapper reports it through a host
 * call instead, and gets `await` support in the bargain: js-exec drains
 * pending promises before it exits, so the wrapper settles.
 */
function wrap(job: CodeJob): { text: string; offset: number } {
  const header = [
    "const __report = globalThis.__cloudfarm_result;",
    "(async () => {",
    "  try {",
    "    const value = await (async () => {",
  ];
  const prelude = job.prelude.replace(/\n+$/, "").split("\n");
  const body = [...header, ...prelude, job.source];
  return {
    // Every line above the source, so a reported line can be brought back
    // down to the one the model actually wrote.
    offset: header.length + prelude.length,
    text: `${body.join("\n")}
    })();
    __report({ ok: true, value: value === undefined ? null : value });
  } catch (error) {
    __report({
      ok: false,
      error: {
        name: (error && error.name) || "Error",
        message: (error && error.message) || String(error),
        stack: error && error.stack ? String(error.stack) : undefined,
      },
    });
  }
})();
`,
  };
}
