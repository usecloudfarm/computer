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
