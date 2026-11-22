import { execHandle, toExecResult } from "@cloudfarm/core";
import type {
  ComputerHost,
  ExecHandle,
  ExecOptions,
  Json,
  Sandbox as CloudfarmSandbox,
  SandboxProvider,
} from "@cloudfarm/core";
import { Sandbox } from "e2b";

export interface E2BOptions {
  /** An E2B API key. */
  readonly apiKey: string;
  /** Template to boot. Defaults to E2B's base image. */
  readonly template?: string;
  /** How long the sandbox lives without activity. */
  readonly timeoutMs?: number;
}

/**
 * E2B as a sandbox provider.
 *
 * Firecracker microVMs, so the isolation is real rather than a compatibility
 * boundary: untrusted code belongs here, not in the in-process default. The
 * cost is a network round trip per command, which is exactly why code mode
 * runs in-process instead of here — twelve actions in a script would be
 * twelve round trips.
 */
export class E2B implements SandboxProvider {
  readonly id = "e2b";
  readonly description =
    "A Firecracker microVM per workspace: any binary, npm, pip, apt, and real isolation for " +
    "untrusted code. Each command is a network round trip.";
  readonly capabilities = new Set(["bash" as const, "ports" as const]);

  readonly #options: E2BOptions;

  constructor(options: E2BOptions) {
    if (!options.apiKey) throw new Error("e2b needs an apiKey");
    this.#options = options;
  }

  async connect(host: ComputerHost, resume?: Json): Promise<CloudfarmSandbox> {
    const existing = (resume as { sandboxId?: string } | undefined)?.sandboxId;
    const { apiKey, template, timeoutMs } = this.#options;

    // Reconnecting beats booting a second microVM: the old one would keep
    // running until its timeout, billing the whole time.
    const sandbox = existing
      ? await Sandbox.connect(existing, { apiKey })
      : await Sandbox.create(template ?? "base", {
          apiKey,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        });

    // Workspace paths are mirrored at their real locations — /data/sales.csv
    // is /data/sales.csv — so the shell has to be able to create a top-level
    // directory. It cannot by default: `mkdir /out` is denied, which left a
    // script able to read seeded files and unable to write new ones anywhere
    // but its home. The alternative was mirroring under /home/user and
    // translating every path, which puts the two filesystems back out of step
    // in a subtler way. This is an ephemeral microVM running model-written
    // code either way.
    await sandbox.commands.run("sudo chmod a+w / 2>/dev/null || true").catch(() => undefined);

    return new E2BSandbox(sandbox, host);
  }
}

/** Convenience for the common case: `provider: e2b({ apiKey })`. */
export function e2b(options: E2BOptions): E2B {
  return new E2B(options);
}

class E2BSandbox implements CloudfarmSandbox {
  constructor(
    readonly sandbox: Sandbox,
    readonly host: ComputerHost,
  ) {}

  /**
   * The SDK's filesystem, not the shell's.
   *
   * It matters which: the shell user cannot `mkdir /data`, but a write
   * through here creates the directory owned by that user, after which the
   * shell can read and write it freely. So workspace paths mirror exactly —
   * `/data/sales.csv` means the same thing in storage and in the microVM,
   * and nothing has to translate between them.
   */
  readonly files = {
    read: async (path: string): Promise<string> => this.sandbox.files.read(path),
    write: async (path: string, content: string): Promise<void> => {
      await this.sandbox.files.write(path, content);
    },
    list: async (prefix: string): Promise<string[]> => {
      const out: string[] = [];
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > 8) return;
        // depth 1, always. The default recurses, and listing `/` that way
        // walks the whole image — it turned `echo hi` into 96 seconds.
        const entries = await this.sandbox.files.list(dir, { depth: 1 }).catch(() => []);
        for (const entry of entries) {
          const path = dir.endsWith("/") ? `${dir}${entry.name}` : `${dir}/${entry.name}`;
          if (entry.type === "dir") await walk(path, depth + 1);
          else out.push(path);
        }
      };
      await walk(prefix, 0);
      return out;
    },
    entries: async (path: string): Promise<string[]> =>
      (await this.sandbox.files.list(path, { depth: 1 }).catch(() => [])).map(
        (entry) => entry.name,
      ),
    remove: async (path: string): Promise<void> => {
      await this.sandbox.files.remove(path);
    },
  };

  exec(command: string, options: ExecOptions = {}): ExecHandle {
    const startedAt = Date.now();

    const run = (async () => {
      const result = await this.sandbox.commands.run(command, {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.env !== undefined ? { envs: options.env } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });

      return toExecResult({
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        startedAt,
      });
    })();

    return execHandle({ id: `e2b-${this.sandbox.sandboxId}-${startedAt}`, run });
  }

  serialize(): Json {
    return { kind: "e2b", sandboxId: this.sandbox.sandboxId };
  }

  async close(): Promise<void> {
    await this.sandbox.kill();
  }
}
