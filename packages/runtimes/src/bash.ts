import type { Bash as BashClass } from "just-bash";
import type {
  FileMap,
  RunEvent,
  RunOutcome,
  RunRequest,
  RuntimeAvailability,
  SandboxRuntime,
} from "@unsandbox/sandbox-core";

/**
 * bash, reimplemented in TypeScript by `just-bash`.
 *
 * Nothing executes on the host: the shell, its builtins and the coreutils-ish
 * commands are all JavaScript, operating on an in-memory filesystem. That
 * makes it the only shell option here with no host process at all, at the
 * cost of covering a subset of real bash and a subset of coreutils.
 *
 * Note the isolation kind: this is a simulation running on the host heap, so
 * it is a compatibility boundary rather than a security one.
 */
/** The workspace root, matching the other runtimes. */
const WORKSPACE = "/work";

export const bashRuntime: SandboxRuntime = {
  id: "bash",
  label: "bash (just-bash)",
  language: "shell",
  isolation: "js-interpreter",
  description:
    "bash reimplemented in TypeScript with its own in-memory filesystem. No host process at all.",
  defaultEntry: "/work/script.sh",
  editorLanguage: "shell",

  async available(): Promise<RuntimeAvailability> {
    try {
      const { Bash } = await import("just-bash");
      const probe = new Bash();
      const result = await probe.exec("echo ok");
      return result.stdout.trim() === "ok"
        ? { ok: true, detail: "just-bash, virtual filesystem" }
        : { ok: false, detail: `unexpected probe output: ${result.stdout}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  },

  async run(request: RunRequest, emit: (event: RunEvent) => void): Promise<RunOutcome> {
    const { Bash } = await import("just-bash");
    const started = Date.now();
    const entry = request.entryPath ?? bashRuntime.defaultEntry;
    const files: FileMap = { ...request.files, [entry]: request.code };

    // cwd matches the dash adapter's working directory, so one shell sample
    // runs unchanged on both engines.
    const bash = new Bash({
      files,
      cwd: WORKSPACE,
      env: { WORK: WORKSPACE, HOME: WORKSPACE },
      // just-bash has no wall-clock limit, so bound the work instead: a
      // runaway `while true` stops at the iteration cap rather than spinning.
      executionLimits: { maxLoopIterations: 200_000, maxCommandCount: 200_000 },
    });

    const result = await bash.exec(request.code);
    if (result.stdout) emit({ type: "stdout", data: result.stdout });
    if (result.stderr) emit({ type: "stderr", data: result.stderr });

    const after = await collectFiles(bash, files);
    const changed = diff(files, after);
    if (changed.length > 0) emit({ type: "files", changed });
    emit({ type: "exit", code: result.exitCode, durationMs: Date.now() - started });
    return { files: after };
  },
};

type BashInstance = BashClass;

async function collectFiles(bash: BashInstance, previous: FileMap): Promise<FileMap> {
  const result: FileMap = {};

  const walk = async (dir: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await bash.fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const path = dir === "/" ? `/${name}` : `${dir}/${name}`;
      try {
        const stat = await bash.fs.stat(path);
        if (stat.isDirectory) {
          await walk(path);
          continue;
        }
        result[path] = await bash.fs.readFile(path);
      } catch {
        // Unreadable or binary: leave it out of the text workspace.
      }
    }
  };

  // Only the workspace: just-bash also populates /bin, /usr/bin, /dev and
  // /proc inside its virtual filesystem, which are the shell's own furniture
  // rather than the user's files.
  await walk(WORKSPACE);
  for (const [path, contents] of Object.entries(previous)) {
    if (!path.startsWith(`${WORKSPACE}/`) && result[path] === undefined) result[path] = contents;
  }
  return result;
}

function diff(before: FileMap, after: FileMap): string[] {
  const changed = new Set<string>();
  for (const [path, contents] of Object.entries(after)) {
    if (before[path] !== contents) changed.add(path);
  }
  for (const path of Object.keys(before)) {
    if (after[path] === undefined) changed.add(path);
  }
  return [...changed].sort();
}
