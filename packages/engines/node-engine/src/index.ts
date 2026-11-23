import { finishResult, Redactor } from "@cloudfarm/core";
import type {
  ActionBridge,
  CodeEngine,
  CodeJob,
  CodeResult,
  HostBridge,
  SandboxFiles,
} from "@cloudfarm/core";

/**
 * Code mode run with `node`, inside the sandbox.
 *
 * `@cloudfarm/qjs-engine` evaluates a script in a wasm isolate in this
 * process. That runs anywhere, which is why it is the default — and it is
 * also why it is small: 64 MiB, no real filesystem, and `fs` only as a shim
 * that turns every read into a host call.
 *
 * Here the script is written into the sandbox and run by the runtime that is
 * already there. It gets node's own `fs` — binary-safe, no size limit, no
 * host call per read — real CPU, and whatever the image has installed. The
 * ceiling stops being the engine and becomes the machine.
 *
 * This is not Node-only. The work happens in the sandbox, so the engine is an
 * HTTP client; it runs wherever the provider does, Cloudflare Workers
 * included. What it cannot do is run without a sandbox, which is why
 * `qjs-engine` remains the fallback and the zero-config default.
 */
export interface NodeEngineOptions {
  /** The interpreter in the image. Defaults to `node`. */
  readonly runtime?: string;
  /** Where scripts and their frames are written. Defaults to `/tmp/.cloudfarm`. */
  readonly scratch?: string;
}

export function nodeEngine(options: NodeEngineOptions = {}): CodeEngine {
  return new NodeEngine(options);
}

class NodeEngine implements CodeEngine {
  readonly id = "node";
  readonly description =
    "Runs JavaScript with node inside the sandbox: a real filesystem with no size limit, " +
    "real CPU, and the packages the image has. Actions reach the host through run().";
  readonly capabilities = {
    asyncHostCalls: true,
    guestAwait: true,
    guestModules: true,
    sandboxed: true,
    interruptible: false,
    memoryCap: false,
  };

  readonly #options: NodeEngineOptions;

  constructor(options: NodeEngineOptions) {
    this.#options = options;
  }

  async available(): Promise<{ ok: boolean; detail?: string }> {
    // Whether `node` is in the image is a fact about the sandbox, and there
    // is none at construction time. The check belongs to the first run.
    return { ok: true, detail: `${this.#runtime} inside the sandbox` };
  }

  async evaluate(job: CodeJob, bridge: HostBridge): Promise<CodeResult> {
    const started = Date.now();
    const common = {
      bridge: bridge as ActionBridge,
      durationMs: 0,
      redactor: new Redactor(),
    };

    const sandbox = job.sandbox;
    const files = sandbox?.files;
    if (!sandbox || !files) {
      return finishResult({
        ...common,
        durationMs: Date.now() - started,
        outcome: "error",
        error: {
          name: "NoSandboxError",
          message:
            "This engine runs code inside the sandbox, and this computer has none that can " +
            "move files. Configure a provider that implements `files`, or use " +
            "@cloudfarm/qjs-engine.",
        },
      });
    }

    const dir = `${this.#scratch}/${job.runId}`;
    const paths = {
      script: `${dir}/script.mjs`,
      request: `${dir}/request.json`,
      response: `${dir}/response.json`,
      result: `${dir}/result.json`,
    };

    await files.write(paths.script, wrap(job, paths));

    // Started, not awaited: the script blocks on a response file as soon as
    // it makes a host call, so the bridge has to be pumped while it runs.
    const handle = sandbox.exec(`${this.#runtime} ${paths.script}`, {
      timeoutMs: job.limits.timeoutMs,
    });

    const pumping = this.#pump(files, paths, bridge, job);
    const exec = await handle.result();
    await pumping.stop();

    const outcome = await readJson<Outcome>(files, paths.result);
    await files.remove(paths.script).catch(() => {});

    const durationMs = Date.now() - started;

    if (exec.status === "cancelled") {
      return finishResult({
        ...common,
        durationMs,
        outcome: "timeout",
        error: {
          name: "TimeoutError",
          message: "The run exceeded its time limit and was stopped.",
        },
        extraLimits: ["timeoutMs"],
      });
    }
    if (!outcome) {
      return finishResult({
        ...common,
        durationMs,
        outcome: "error",
        error: {
          name: "ExecError",
          message: exec.stderr.trim() || `${this.#runtime} exited ${exec.exitCode}`,
        },
      });
    }
    if (!outcome.ok) {
      return finishResult({ ...common, durationMs, outcome: "error", error: outcome.error });
    }

    return finishResult({
      ...common,
      durationMs,
      outcome: "ok",
      ...(outcome.value === undefined || outcome.value === null
        ? {}
        : { value: outcome.value as never }),
    });
  }

  async dispose(): Promise<void> {}

  get #runtime(): string {
    return this.#options.runtime ?? "node";
  }

  get #scratch(): string {
    return this.#options.scratch ?? "/tmp/.cloudfarm";
  }

  /**
   * The host side of the bridge, over two files.
   *
   * Not the transport anyone would choose — a round trip costs a poll
   * interval plus two file operations, where a pipe would cost one. It is
   * the transport that needs nothing new: `exec` is one-way today, so giving
   * the guest a pipe means putting stdin on the port and into every
   * provider. Worth doing; worth doing after the rest is proven.
   */
  #pump(
    files: SandboxFiles,
    paths: { request: string; response: string },
    bridge: HostBridge,
    job: CodeJob,
  ): { stop: () => Promise<void> } {
    // An AbortController rather than a boolean: the flag is set from outside
    // the loop, which a linter cannot see and a reader has to take on trust.
    const stopped = new AbortController();
    let seq = 0;

    const loop = (async () => {
      while (!stopped.signal.aborted) {
        const request = await readJson<HostRequest>(files, paths.request);
        if (!request) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          continue;
        }
        await files.remove(paths.request).catch(() => {});

        const { action, args } = request;
        const response = await bridge.call(
          {
            v: 1,
            seq: seq++,
            action,
            ...(args === null || args === undefined ? {} : { args: args as never }),
          },
          AbortSignal.timeout(job.limits.timeoutMs),
        );
        await files.write(paths.response, JSON.stringify(response));
      }
    })();

    return {
      stop: async () => {
        stopped.abort();
        await loop.catch(() => {});
      },
    };
  }
}

interface GuestError {
  name: string;
  message: string;
}

type Outcome = { ok: true; value?: unknown } | { ok: false; error: GuestError };

interface HostRequest {
  action: string;
  args?: unknown;
}

async function readJson<T>(files: SandboxFiles, path: string): Promise<T | null> {
  try {
    return JSON.parse(await files.read(path)) as T;
  } catch {
    // Absent, half-written, or not ours — all the same to the caller: not
    // ready. Polling means reading a file mid-write is routine, not an error.
    return null;
  }
}

/**
 * The script, plus the guest half of the bridge.
 *
 * `run` is synchronous from the script's point of view, the same as in the
 * isolate: it writes a request and spins on the response file. Spinning
 * rather than awaiting keeps one dialect across both engines — a script that
 * works here works there — and `await` still parses, so a model that reaches
 * for it is not punished.
 */
function wrap(job: CodeJob, paths: { request: string; response: string; result: string }): string {
  return `import fs from "node:fs";
import { createRequire } from "node:module";

// The script is ESM, so that \`await\` works at the top level — and ESM has
// no \`require\`. Models write both, and the isolate's prelude offers both,
// so the guest gets both here too.
const require = createRequire(import.meta.url);

// Node allows Atomics.wait on the main thread, unlike a browser. The first
// version slept by spawning \`sleep\`, one process per poll, which cost
// twelve seconds for a single host call against a microVM.
const __idle = new Int32Array(new SharedArrayBuffer(4));
const __sleep = (ms) => { Atomics.wait(__idle, 0, 0, ms); };

const __logs = [];
const __hostCall = (action, args) => {
  fs.writeFileSync(${JSON.stringify(paths.request)}, JSON.stringify({ action, args: args ?? null }));
  // A busy wait would pin a core for the whole round trip, so sleep between
  // looks. \`sleep\` rather than Atomics.wait: this is the main thread.
  for (;;) {
    try {
      const raw = fs.readFileSync(${JSON.stringify(paths.response)}, "utf8");
      fs.rmSync(${JSON.stringify(paths.response)}, { force: true });
      const response = JSON.parse(raw);
      if (response.ok) return response.value;
      return { status: "error", error: response.error };
    } catch {
      __sleep(5);
    }
  }
};
globalThis.__host = __hostCall;
globalThis.__log = (level, args) => {
  __logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
};

const __report = (payload) => {
  fs.mkdirSync(${JSON.stringify(paths.result.slice(0, paths.result.lastIndexOf("/")))}, { recursive: true });
  fs.writeFileSync(${JSON.stringify(paths.result)}, JSON.stringify(payload));
  for (const line of __logs) process.stdout.write(line + "\\n");
};

try {
  const value = await (async () => {
${job.prelude}
${job.source}
  })();
  __report({ ok: true, value: value === undefined ? null : value });
} catch (error) {
  __report({
    ok: false,
    error: {
      name: (error && error.name) || "Error",
      message: (error && error.message) || String(error),
    },
  });
}
`;
}
