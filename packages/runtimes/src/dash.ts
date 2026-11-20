import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import type {
  FileMap,
  RunEvent,
  RunOutcome,
  RunRequest,
  RuntimeAvailability,
  SandboxRuntime,
} from "@unsandbox/sandbox-core";

const CANDIDATES = ["/bin/dash", "/usr/bin/dash", "/opt/homebrew/bin/dash", "/bin/sh"] as const;

/**
 * dash - the real POSIX shell binary, as a host process.
 *
 * Unlike the other four engines this one actually forks a process on the
 * host, so it is the least isolated option by a wide margin: the sandbox here
 * is a temporary directory and an empty environment, nothing more. It earns
 * its place by being the ground truth - real `dash`, real coreutils, real
 * exit codes - which is exactly what you want to compare the emulated shells
 * against.
 *
 * In production this adapter is the one you would move inside a microVM.
 */
export const dashRuntime: SandboxRuntime = {
  id: "dash",
  label: "dash (host)",
  language: "shell",
  isolation: "host-process",
  description:
    "The real dash binary in a temp directory with an empty environment. Ground truth, not a sandbox.",
  defaultEntry: "/work/script.sh",
  editorLanguage: "shell",

  async available(): Promise<RuntimeAvailability> {
    const shell = await findShell();
    if (!shell) {
      return { ok: false, detail: `No shell found at ${CANDIDATES.join(", ")}` };
    }
    return {
      ok: true,
      detail: shell.endsWith("/dash") ? shell : `${shell} (dash not installed; POSIX sh fallback)`,
    };
  },

  async run(request: RunRequest, emit: (event: RunEvent) => void): Promise<RunOutcome> {
    const started = Date.now();
    const shell = await findShell();
    if (!shell) throw new Error(`No shell binary found (looked in ${CANDIDATES.join(", ")})`);

    const entry = request.entryPath ?? dashRuntime.defaultEntry;
    const files: FileMap = { ...request.files, [entry]: request.code };
    const timeoutMs = request.limits?.timeoutMs ?? 10_000;

    const root = await mkdtemp(join(tmpdir(), "unsandbox-dash-"));
    try {
      await materialize(root, files);
      const scriptPath = join(root, "__entry.sh");
      await writeFile(scriptPath, request.code, "utf8");

      const code = await new Promise<number>((resolve) => {
        const child = spawn(shell, [scriptPath, ...(request.argv ?? [])], {
          cwd: join(root, "work"),
          // An empty environment: no credentials or host configuration leak in.
          env: {
            PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
            HOME: join(root, "work"),
            PWD: join(root, "work"),
            // The workspace root, since a host process cannot see "/work".
            WORK: join(root, "work"),
          },
          stdio: ["pipe", "pipe", "pipe"],
        });

        const timer = setTimeout(() => {
          emit({ type: "error", message: `Run exceeded the ${timeoutMs}ms limit; process killed` });
          child.kill("SIGKILL");
        }, timeoutMs);

        child.stdout.on("data", (chunk: Buffer) =>
          emit({ type: "stdout", data: chunk.toString("utf8") }),
        );
        child.stderr.on("data", (chunk: Buffer) =>
          emit({ type: "stderr", data: chunk.toString("utf8") }),
        );
        child.on("error", (error) => {
          emit({ type: "error", message: error.message });
          clearTimeout(timer);
          resolve(1);
        });
        child.on("close", (exitCode, signal) => {
          clearTimeout(timer);
          resolve(exitCode ?? (signal ? 137 : 1));
        });

        if (request.stdin !== undefined) child.stdin.write(request.stdin);
        child.stdin.end();
      });

      const after = await collect(root, files);
      const changed = diff(files, after);
      if (changed.length > 0) emit({ type: "files", changed });
      emit({ type: "exit", code, durationMs: Date.now() - started });
      return { files: after };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
};

let cachedShell: string | null | undefined;

async function findShell(): Promise<string | null> {
  if (cachedShell !== undefined) return cachedShell;
  for (const candidate of CANDIDATES) {
    try {
      await access(candidate, constants.X_OK);
      cachedShell = candidate;
      return candidate;
    } catch {
      // Try the next one.
    }
  }
  cachedShell = null;
  return null;
}

/** Writes the workspace under `root`, keeping its directory layout. */
async function materialize(root: string, files: FileMap): Promise<void> {
  await mkdir(join(root, "work"), { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    // Refuse anything that would escape the temp root.
    if (relative(root, target).startsWith(`..${sep}`)) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
}

async function collect(root: string, previous: FileMap): Promise<FileMap> {
  const result: FileMap = {};

  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === "__entry.sh") continue;
      const info = await stat(absolute);
      // Skip anything large enough to suggest it is not source text.
      if (info.size > 512 * 1024) continue;
      const virtualPath = `/${relative(root, absolute).split(sep).join("/")}`;
      try {
        result[virtualPath] = await readFile(absolute, "utf8");
      } catch {
        // Not valid UTF-8: not representable in this text-only workspace.
      }
    }
  };

  // Only the workspace directory: the temp root also holds the entry script
  // and whatever HOME artefacts the shell leaves behind.
  await walk(join(root, "work"));
  for (const [path, contents] of Object.entries(previous)) {
    if (!path.startsWith("/work/") && result[path] === undefined) result[path] = contents;
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
