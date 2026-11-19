import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { FirecrackerTimeoutError, VmmExitedError } from "./errors.js";

export interface SpawnOptions {
  /** Path of the API Unix socket to create (`--api-sock`). */
  readonly apiSocketPath: string;
  /** Instance id reported by the API and used by the jailer. Defaults to a random id. */
  readonly id?: string;
  /** Firecracker binary. Defaults to `firecracker` on `PATH`. */
  readonly binaryPath?: string;
  /** Extra arguments appended to the command line. */
  readonly args?: readonly string[];
  /** Working directory for the process. */
  readonly cwd?: string;
  /** Environment for the process. Defaults to the parent environment. */
  readonly env?: NodeJS.ProcessEnv;
  /** How many bytes of stdout/stderr to retain for diagnostics. Defaults to 64 KiB. */
  readonly logBufferBytes?: number;
  /**
   * Run under the jailer instead of invoking Firecracker directly. The jailer
   * chroots, drops privileges and applies a seccomp filter; use it for
   * anything running untrusted guests.
   */
  readonly jailer?: JailerOptions;
}

export interface JailerOptions {
  /** Jailer binary. Defaults to `jailer` on `PATH`. */
  readonly binaryPath?: string;
  /** uid the microVM drops to. */
  readonly uid: number;
  /** gid the microVM drops to. */
  readonly gid: number;
  /** Base directory for the chroot. Defaults to `/srv/jailer`. */
  readonly chrootBaseDir?: string;
  /** Pin the VMM to a cgroup/NUMA node, passed through as `--cgroup` entries. */
  readonly cgroups?: readonly string[];
}

/**
 * A running `firecracker` (or `jailer`) process plus its API socket.
 *
 * The process is a child of this Node process: if Node exits, the VMM is
 * killed with it, so a long-lived supervisor should own these.
 */
export class FirecrackerProcess {
  readonly id: string;
  readonly apiSocketPath: string;
  readonly child: ChildProcess;
  /** Settles when the process exits. Never rejects. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  #stdout = "";
  #stderr = "";
  #exited = false;
  readonly #logBufferBytes: number;

  private constructor(args: {
    id: string;
    apiSocketPath: string;
    child: ChildProcess;
    logBufferBytes: number;
  }) {
    this.id = args.id;
    this.apiSocketPath = args.apiSocketPath;
    this.child = args.child;
    this.#logBufferBytes = args.logBufferBytes;

    const append = (into: "stdout" | "stderr", chunk: Buffer) => {
      const next = (into === "stdout" ? this.#stdout : this.#stderr) + chunk.toString("utf8");
      const trimmed = next.length > this.#logBufferBytes ? next.slice(-this.#logBufferBytes) : next;
      if (into === "stdout") this.#stdout = trimmed;
      else this.#stderr = trimmed;
    };
    args.child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    args.child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));

    this.exited = new Promise((resolve) => {
      args.child.once("exit", (code, signal) => {
        this.#exited = true;
        resolve({ code, signal });
      });
    });
  }

  /** Output the VMM has written so far (bounded by `logBufferBytes`). */
  get stdout(): string {
    return this.#stdout;
  }

  get stderr(): string {
    return this.#stderr;
  }

  get running(): boolean {
    return !this.#exited;
  }

  /** Spawns the VMM. Resolves as soon as the process starts; the socket may not exist yet. */
  static async spawn(options: SpawnOptions): Promise<FirecrackerProcess> {
    const id = options.id ?? `vm-${Math.random().toString(36).slice(2, 10)}`;
    await mkdir(dirname(options.apiSocketPath), { recursive: true });
    // Firecracker refuses to start when the socket path already exists.
    await rm(options.apiSocketPath, { force: true });

    const { command, args } = buildCommand(id, options);
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    });

    const proc = new FirecrackerProcess({
      id,
      apiSocketPath: options.apiSocketPath,
      child,
      logBufferBytes: options.logBufferBytes ?? 64 * 1024,
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    return proc;
  }

  /** Throws {@link VmmExitedError} if the process is already gone. */
  assertRunning(): void {
    if (this.#exited)
      throw new VmmExitedError(this.child.exitCode, this.child.signalCode, this.#stderr);
  }

  /**
   * Sends `signal`, then `SIGKILL` if the process is still alive after
   * `timeoutMs`. Removes the API socket afterwards.
   */
  async kill(signal: NodeJS.Signals = "SIGTERM", timeoutMs = 2_000): Promise<void> {
    if (!this.#exited) {
      this.child.kill(signal);
      const timedOut = await Promise.race([
        this.exited.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), timeoutMs)),
      ]);
      if (timedOut) {
        this.child.kill("SIGKILL");
        await this.exited;
      }
    }
    await rm(this.apiSocketPath, { force: true });
  }

  /** Rejects with {@link FirecrackerTimeoutError} if the process has not exited in time. */
  async waitForExit(
    timeoutMs: number,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    const result = await Promise.race([
      this.exited,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (result === null)
      throw new FirecrackerTimeoutError(`Firecracker ${this.id} exit`, timeoutMs);
    return result;
  }
}

function buildCommand(id: string, options: SpawnOptions): { command: string; args: string[] } {
  const firecracker = options.binaryPath ?? "firecracker";
  const extra = [...(options.args ?? [])];

  if (!options.jailer) {
    return {
      command: firecracker,
      args: ["--api-sock", options.apiSocketPath, "--id", id, ...extra],
    };
  }

  const jailer = options.jailer;
  const args = [
    "--id",
    id,
    "--exec-file",
    firecracker,
    "--uid",
    String(jailer.uid),
    "--gid",
    String(jailer.gid),
    "--chroot-base-dir",
    jailer.chrootBaseDir ?? "/srv/jailer",
  ];
  for (const cgroup of jailer.cgroups ?? []) args.push("--cgroup", cgroup);
  // Everything after `--` goes to Firecracker itself. Inside the chroot the
  // socket path is relative to the jail root.
  args.push("--", "--api-sock", options.apiSocketPath, ...extra);

  return { command: jailer.binaryPath ?? "jailer", args };
}
