import { execHandle, toExecResult } from "@cloudfarm/core";
import type {
  ComputerHost,
  ExecHandle,
  ExecOptions,
  Json,
  Sandbox as CloudfarmSandbox,
  SandboxProvider,
} from "@cloudfarm/core";
import { Sandbox } from "@vercel/sandbox";

export interface VercelSandboxOptions {
  /** A Vercel access token. Falls back to the SDK's own environment lookup. */
  readonly token?: string;
  readonly teamId?: string;
  readonly projectId?: string;
  /** How long the sandbox lives. */
  readonly timeout?: number;
  readonly runtime?: string;
}

/**
 * Vercel Sandbox as a provider.
 *
 * An ephemeral Linux microVM, created per workspace and stopped with it.
 */
export class VercelSandbox implements SandboxProvider {
  readonly id = "vercel-sandbox";
  readonly description =
    "An ephemeral Linux microVM per workspace: node, python, package installs and real " +
    "binaries. Each command is a network round trip.";
  readonly capabilities = new Set(["bash" as const, "ports" as const]);

  readonly #options: VercelSandboxOptions;

  constructor(options: VercelSandboxOptions = {}) {
    this.#options = options;
  }

  async connect(host: ComputerHost): Promise<CloudfarmSandbox> {
    const { token, teamId, projectId, timeout, runtime } = this.#options;
    const sandbox = await Sandbox.create({
      ...(token !== undefined ? { token } : {}),
      ...(teamId !== undefined ? { teamId } : {}),
      ...(projectId !== undefined ? { projectId } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
      ...(runtime !== undefined ? { runtime } : {}),
    } as Parameters<typeof Sandbox.create>[0]);

    return new VercelSandboxSession(sandbox, host);
  }
}

/** Convenience for the common case: `provider: vercelSandbox({ token })`. */
export function vercelSandbox(options: VercelSandboxOptions = {}): VercelSandbox {
  return new VercelSandbox(options);
}

class VercelSandboxSession implements CloudfarmSandbox {
  constructor(
    readonly sandbox: Awaited<ReturnType<typeof Sandbox.create>>,
    readonly host: ComputerHost,
  ) {}

  exec(command: string, options: ExecOptions = {}): ExecHandle {
    const startedAt = Date.now();

    const run = (async () => {
      // The API takes a program and its arguments, not a shell line, so the
      // command is handed to bash rather than split here — quoting a shell
      // line correctly is the shell's job, not ours.
      const finished = await this.sandbox.runCommand("bash", ["-lc", command], {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
      });

      return toExecResult({
        exitCode: finished.exitCode,
        stdout: await finished.stdout(),
        stderr: await finished.stderr(),
        startedAt,
      });
    })();

    return execHandle({ id: `vercel-${this.sandbox.name}-${startedAt}`, run });
  }

  serialize(): Json {
    return { kind: "vercel-sandbox", name: this.sandbox.name };
  }

  async close(): Promise<void> {
    await this.sandbox.stop();
  }
}
