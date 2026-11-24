import { WORKSPACE_ROOT, inSandbox, inWorkspace } from "@cloudfarm/computer";
import type {
  ComputerHost,
  ExecHandle,
  FileSystem,
  Sandbox,
  SandboxProvider,
} from "@cloudfarm/computer";
import type { ExecEvent, ExecOptions, ExecResult, Json } from "@cloudfarm/computer";
import { execHandle } from "@cloudfarm/computer";

import type {
  ExecOutput,
  Shell,
  ShellConstructor,
  ShellRequest,
  ShellResponse,
} from "@cloudfarm/rbash";

// Re-exported so a consumer of the provider does not have to reach for
// the shell package to name what it works with.
export type { ExecOutput, Shell, ShellConstructor, ShellRequest, ShellResponse };

export interface RbashOptions {
  /** Working directory. Defaults to the workspace root. */
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  /**
   * Gives the shell `curl` and `wget`, over the host's own fetch.
   *
   * Off by default, and deliberately: a shell that can reach the network is a
   * different security proposition from one that cannot, and the decision is
   * the embedding program's rather than this package's. `just-bash` gates its
   * own `curl` the same way.
   *
   * Requests go through `ComputerHost.fetch`, which is the allowlisted path
   * everything else uses — so whatever egress policy is already in force
   * applies here without this package knowing about it.
   */
  readonly network?: boolean;
}

/**
 * `rust-bash` as a sandbox provider: a bash interpreter compiled to
 * WebAssembly, running in this process over the workspace filesystem.
 *
 * The same shape as `@cloudfarm/bash-sandbox` and for the same reasons — it
 * starts instantly, needs no container, and runs wherever wasm does. What it
 * changes is the interpreter underneath: a Rust implementation in wasm rather
 * than one in TypeScript.
 *
 * The wasm has to be instantiated before any of this works, which is why the
 * entry points are `./node` and `./workers` rather than a single default.
 * Workers refuses `WebAssembly.compile` on bytes, so the module must arrive as
 * a static import that only the caller's bundler can emit — the same
 * constraint `@cloudfarm/qjs-engine` has.
 */
export class Rbash implements SandboxProvider {
  readonly id = "rbash";
  // Prompt text: the model reads this to decide what to try. The absences
  // are the load-bearing part — a command that is not here costs a turn, so
  // `curl` is named only when it is actually there.
  get description(): string {
    return `${this.#base}${this.#options.network ? " curl and wget reach the network." : " No network."}`;
  }

  readonly #base =
    "Bash over the workspace filesystem, compiled to WebAssembly. Supports pipelines, " +
    "redirection, loops, functions and heredocs, with awk, grep, rg, sed, cut, sort, " +
    "uniq, tr, find, tee, xargs, diff, comm, join, base64, md5sum, gzip, tar, jq, yq, " +
    "xan (CSV), sqlite3 and html-to-markdown. Cannot run npm, node or python.";
  readonly capabilities = new Set(["bash" as const]);

  readonly #Bash: ShellConstructor;
  readonly #options: RbashOptions;

  constructor(Bash: ShellConstructor, options: RbashOptions = {}) {
    this.#Bash = Bash;
    this.#options = options;
  }

  async connect(host: ComputerHost): Promise<Sandbox> {
    return new RbashSandbox(this.#Bash, host.fs, this.#options, host);
  }
}

class RbashSandbox implements Sandbox {
  readonly #Bash: ShellConstructor;
  readonly #fs: FileSystem;
  readonly #options: RbashOptions;
  readonly #host: ComputerHost;

  constructor(Bash: ShellConstructor, fs: FileSystem, options: RbashOptions, host: ComputerHost) {
    this.#Bash = Bash;
    this.#fs = fs;
    this.#options = options;
    this.#host = host;
  }

  exec(command: string, options: ExecOptions = {}): ExecHandle {
    const started = Date.now();
    const cwd = options.cwd ?? this.#options.cwd ?? WORKSPACE_ROOT;

    const run = async (): Promise<ExecResult> => {
      // One interpreter per command, as `bash-sandbox` does: the workspace is
      // the only state that outlives a command, and a fresh instance cannot
      // leak a variable or a stray file from the last one.
      const shell = new this.#Bash();
      if (this.#options.network) shell.setFetch(fetcher(this.#host));
      const before = await push(shell, this.#fs);

      const env = { ...this.#options.env, ...options.env };
      const exported = Object.entries(env)
        .map(([key, value]) => `export ${key}=${shellQuote(value)}\n`)
        .join("");

      // `mkdir -p` because the root only exists once something is in it, and
      // `cd` has to succeed even for an empty workspace.
      const script = `mkdir -p ${shellQuote(cwd)}\ncd ${shellQuote(cwd)}\n${exported}${command}`;
      // The async path only when it is needed: it costs a promise per command
      // and a replay per request, and most commands have neither.
      const result = this.#options.network ? await shell.execAsync(script) : shell.exec(script);

      await pull(shell, this.#fs, before);
      shell.free();

      return {
        status: result.exitCode === 0 ? "completed" : "failed",
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - started,
      };
    };

    return execHandle({ id: `rbash-${started}`, run: run() });
  }

  serialize(): Json {
    // Nothing to re-attach to: the interpreter is per-command and the
    // workspace filesystem holds everything that survives.
    return { kind: "rbash" };
  }

  async close(): Promise<void> {}
}

/**
 * Workspace → shell, keyed by sandbox path. Returns what was sent.
 *
 * Bytes, not text. The string API loses anything that is not valid UTF-8,
 * which is every tarball and every gzip stream — a `tar -czf` in one command
 * would not survive to the next.
 */
async function push(shell: Shell, fs: FileSystem): Promise<Map<string, string>> {
  const before = new Map<string, string>();
  for await (const entry of fs.list("/")) {
    if (entry.type !== "file") continue;
    // Skip the runtime's own bookkeeping so it never shows up in `ls`.
    if (entry.path.startsWith("/.cloudfarm/")) continue;
    let bytes: Uint8Array;
    try {
      bytes = await fs.read(entry.path);
    } catch {
      continue;
    }
    const path = inSandbox(entry.path);
    shell.writeFileBytes(path, bytes);
    before.set(path, fingerprint(bytes));
  }
  return before;
}

/**
 * A cheap stand-in for comparing two files.
 *
 * Only ever compared against another fingerprint of the same shape, so it
 * needs to change when the bytes change — not to be collision-proof.
 */
function fingerprint(bytes: Uint8Array): string {
  let hash = 2166136261;
  for (const b of bytes) {
    hash ^= b;
    hash = Math.imul(hash, 16777619);
  }
  return `${bytes.byteLength}:${hash >>> 0}`;
}

/**
 * Shell → workspace, over the workspace root only.
 *
 * The enumeration is `find`, run in the shell itself, because the wasm API
 * exposes `readFile` and no way to list. That is not the workaround it looks
 * like: `find` is one of its own builtins and reads the same in-memory
 * filesystem the script wrote to, so it sees exactly what a caller would.
 */
async function pull(shell: Shell, fs: FileSystem, before: Map<string, string>): Promise<void> {
  const listing = shell.exec(`find ${WORKSPACE_ROOT} -type f 2>/dev/null`);
  const paths = listing.stdout.split("\n").filter((line) => line.startsWith(`${WORKSPACE_ROOT}/`));
  const seen = new Set(paths);

  for (const path of paths) {
    const bytes = shell.readFileBytes(path);
    if (bytes === undefined) continue;
    if (before.get(path) === fingerprint(bytes)) continue;
    const workspacePath = inWorkspace(path);
    if (workspacePath === undefined) continue;
    await fs.write(workspacePath, bytes);
  }

  // A file the command deleted should not come back on the next push.
  for (const path of before.keys()) {
    if (seen.has(path)) continue;
    const workspacePath = inWorkspace(path);
    if (workspacePath !== undefined) await fs.remove(workspacePath).catch(() => {});
  }
}

/**
 * The shell's network, over the host's fetch.
 *
 * `ComputerHost.fetch` is the allowlisted path the rest of the system uses,
 * so `curl` is bound by whatever egress policy is already in force. A failure
 * comes back as a value rather than a throw: `curl` should report it and exit
 * non-zero, not take the script down.
 */
function fetcher(host: ComputerHost): (request: ShellRequest) => Promise<ShellResponse> {
  return async (request) => {
    try {
      const response = await host.fetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === null ? {} : { body: request.body }),
        // The workspace's own signal, so a cancelled run cancels its requests.
        signal: host.signal,
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      return { status: response.status, headers, body: await response.text() };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };
}

/** Single quotes, with the one escape that needs: `'` closes and reopens. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export type { ExecEvent };
