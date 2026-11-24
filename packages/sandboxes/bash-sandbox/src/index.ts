import { Bash } from "just-bash";
import { WORKSPACE_ROOT } from "@cloudfarm/computer";
import type {
  ComputerHost,
  ExecHandle,
  FileSystem,
  Sandbox,
  SandboxProvider,
} from "@cloudfarm/computer";
import type { ExecEvent, ExecOptions, ExecResult, Json } from "@cloudfarm/computer";

export interface JustBashOptions {
  /** Working directory inside the sandbox. Defaults to the workspace root. */
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  /**
   * `just-bash` has no wall clock of its own, so runaway loops are bounded by
   * work instead: a `while true` stops at the iteration cap rather than
   * spinning forever. Lower these for stricter sandboxes.
   */
  readonly maxLoopIterations?: number;
  readonly maxCommandCount?: number;
}

/**
 * The zero-infrastructure default: bash reimplemented in TypeScript, running
 * in this process over the workspace filesystem.
 *
 * It starts instantly, needs no API key and no container, and runs unchanged
 * on Workers — which is why it is the default. The trade is fidelity and
 * isolation: it covers a large subset of bash and coreutils rather than all of
 * it, and it is a compatibility boundary, not a security one. For untrusted
 * code, or anything needing npm, python or real binaries, pass a provider like
 * `@cloudfarm/e2b-sandbox` instead.
 */
export class JustBash implements SandboxProvider {
  readonly id = "just-bash";
  readonly description =
    "A bash shell with the common coreutils (cat, grep, sed, awk, jq, find, sort, head, tail, " +
    "wc, curl-free). Starts instantly and shares the workspace filesystem. Cannot run npm, " +
    "node, python or other binaries.";
  readonly capabilities = new Set(["bash" as const]);

  readonly #options: JustBashOptions;

  constructor(options: JustBashOptions = {}) {
    this.#options = options;
  }

  async connect(host: ComputerHost): Promise<Sandbox> {
    return new JustBashSandbox(host.fs, this.#options);
  }
}

class JustBashSandbox implements Sandbox {
  readonly #fs: FileSystem;
  readonly #options: JustBashOptions;

  constructor(fs: FileSystem, options: JustBashOptions) {
    this.#fs = fs;
    this.#options = options;
  }

  exec(command: string, options: ExecOptions = {}): ExecHandle {
    const started = Date.now();
    const cwd = options.cwd ?? this.#options.cwd ?? WORKSPACE_ROOT;

    const run = (async (): Promise<ExecResult> => {
      // The workspace is the source of truth: mount it, run, write back what
      // changed. Copying is fine at this size and keeps the shell's virtual
      // filesystem from drifting away from the real one.
      const files = await snapshot(this.#fs);
      const shell = new Bash({
        files,
        cwd,
        env: { ...this.#options.env, ...options.env, HOME: cwd, PWD: cwd },
        executionLimits: {
          maxLoopIterations: this.#options.maxLoopIterations ?? 200_000,
          maxCommandCount: this.#options.maxCommandCount ?? 200_000,
        },
      });

      const result = await shell.exec(command);
      await writeBack(this.#fs, shell, files);

      return {
        status: result.exitCode === 0 ? "completed" : "failed",
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - started,
      };
    })();

    return makeHandle(run);
  }

  serialize(): Json {
    // Nothing to re-attach to: the shell is stateless between runs and the
    // workspace filesystem holds everything that survives.
    return { kind: "just-bash" };
  }

  async close(): Promise<void> {}
}

/**
 * Reads the workspace into the shape just-bash wants for its initial files.
 *
 * Keyed by sandbox path, so the workspace appears under `WORKSPACE_ROOT` just
 * as it does in a real sandbox — mounted or copied. This shell could have put
 * it at `/`, since it owns the whole virtual filesystem, but then
 * `/data/sales.csv` would name a file here and nothing there.
 */
async function snapshot(fs: FileSystem): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for await (const entry of fs.list("/")) {
    if (entry.type !== "file") continue;
    // Skip the runtime's own bookkeeping so it never shows up in `ls`.
    if (entry.path.startsWith("/.cloudfarm/")) continue;
    try {
      files[inSandbox(entry.path)] = await fs.readText(entry.path);
    } catch {
      // Not valid UTF-8: the text-only shell cannot represent it.
    }
  }
  return files;
}

/** Workspace path → sandbox path. */
function inSandbox(path: string): string {
  return `${WORKSPACE_ROOT}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Sandbox path → workspace path, or undefined if it is not ours. */
function inWorkspace(path: string): string | undefined {
  if (!path.startsWith(`${WORKSPACE_ROOT}/`)) return undefined;
  return path.slice(WORKSPACE_ROOT.length);
}

/** Writes back anything the command created or changed. */
async function writeBack(
  fs: FileSystem,
  shell: InstanceType<typeof Bash>,
  before: Record<string, string>,
): Promise<void> {
  const seen = new Set<string>();

  const walk = async (directory: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await shell.fs.readdir(directory);
    } catch {
      return;
    }
    for (const name of entries) {
      const path = directory === "/" ? `/${name}` : `${directory}/${name}`;
      // just-bash populates /bin, /usr, /dev and /proc with its own furniture.
      if (IGNORED.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) continue;
      try {
        const stat = await shell.fs.stat(path);
        if (stat.isDirectory) {
          await walk(path);
          continue;
        }
        seen.add(path);
        const workspacePath = inWorkspace(path);
        if (workspacePath === undefined) continue;
        const contents = await shell.fs.readFile(path);
        if (before[path] !== contents) await fs.write(workspacePath, contents);
      } catch {
        // Unreadable or binary; leave the workspace copy alone.
      }
    }
  };

  // Only the workspace's own directory. Anything the command leaves elsewhere
  // is scratch that dies with the shell, which is what a mounted sandbox does
  // too — there, only the mount is the bucket.
  await walk(WORKSPACE_ROOT);

  for (const path of Object.keys(before)) {
    if (seen.has(path)) continue;
    const workspacePath = inWorkspace(path);
    if (workspacePath !== undefined) await fs.remove(workspacePath).catch(() => {});
  }
}

const IGNORED = ["/bin", "/usr", "/dev", "/proc", "/tmp", "/etc", "/.cloudfarm"];

function makeHandle(run: Promise<ExecResult>): ExecHandle {
  let resolved: ExecResult | undefined;
  const settled = run.then((result) => {
    resolved = result;
    return result;
  });

  const stream = new ReadableStream<ExecEvent>({
    async start(controller) {
      const result = await settled;
      if (result.stdout) controller.enqueue({ type: "stdout", data: result.stdout });
      if (result.stderr) controller.enqueue({ type: "stderr", data: result.stderr });
      controller.enqueue({ type: "exit", exitCode: result.exitCode, status: result.status });
      controller.close();
    },
  }) as ExecHandle;

  Object.defineProperties(stream, {
    id: { value: `bash-${Math.random().toString(36).slice(2, 10)}` },
    result: { value: () => settled },
    kill: {
      value: async () => {
        // just-bash runs synchronously to completion; the iteration caps are
        // what actually bound a runaway command.
        void resolved;
      },
    },
  });
  return stream;
}
