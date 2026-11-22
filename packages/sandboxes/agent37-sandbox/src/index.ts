import { execHandle, toExecResult } from "@cloudfarm/core";
import type {
  ComputerHost,
  ExecHandle,
  ExecOptions,
  Json,
  Sandbox,
  SandboxProvider,
} from "@cloudfarm/core";

const CONTROL = "https://api.agent37.com/v1";
const MACHINE = "https://sandbox.agent37.app/v1";

export interface Agent37Options {
  /** An Agent37 key (`sk_live_…`). Sent as `X-Agent37-Key`, not as a bearer token. */
  readonly apiKey: string;
  /** Which template the instance runs. Defaults to the account's own default. */
  readonly template?: string;
  /** Extra fields for instance creation — region, size, budget — passed through. */
  readonly create?: Record<string, unknown>;
  readonly controlUrl?: string;
  readonly machineUrl?: string;
}

/**
 * Agent37 as a sandbox provider.
 *
 * Two planes, one key, which is the thing to know before reading this file:
 * instances are created and destroyed on the control API, while `exec` is
 * answered by the machine the instance runs on. Sending exec to the control
 * plane also works, but the direct host is the shorter path.
 */
export class Agent37 implements SandboxProvider {
  readonly id = "agent37";
  readonly description =
    "A gVisor sandbox or full VM per workspace: any binary, package managers, long-running " +
    "processes. Starts in seconds and bills while it runs.";
  readonly capabilities = new Set(["bash" as const, "ports" as const]);

  readonly #options: Agent37Options;

  constructor(options: Agent37Options) {
    if (!options.apiKey) throw new Error("agent37 needs an apiKey (sk_live_…)");
    this.#options = options;
  }

  async connect(host: ComputerHost, resume?: Json): Promise<Sandbox> {
    const existing = (resume as { id?: string } | undefined)?.id;
    const id = existing ?? (await create(this.#options));
    return new Agent37Sandbox(id, this.#options, host);
  }
}

/** Convenience for the common case: `provider: agent37({ apiKey })`. */
export function agent37(options: Agent37Options): Agent37 {
  return new Agent37(options);
}

class Agent37Sandbox implements Sandbox {
  constructor(
    readonly id: string,
    readonly options: Agent37Options,
    readonly host: ComputerHost,
  ) {}

  exec(command: string, options: ExecOptions = {}): ExecHandle {
    const startedAt = Date.now();

    const run = (async () => {
      const body = await call<{
        exitCode?: number;
        stdout?: string;
        stderr?: string;
        timedOut?: boolean;
      }>(
        this.options,
        `${this.options.machineUrl ?? MACHINE}/instances/${this.id}/exec`,
        "POST",
        {
          command: options.cwd ? `cd ${quote(options.cwd)} && ${command}` : command,
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        },
        this.host.signal,
      );

      return toExecResult({
        // A timed-out command has no exit code, and reporting 0 would read as
        // success to everything downstream.
        exitCode: body.timedOut ? null : (body.exitCode ?? null),
        ...(body.stdout !== undefined ? { stdout: body.stdout } : {}),
        ...(body.stderr !== undefined ? { stderr: body.stderr } : {}),
        startedAt,
        ...(body.timedOut ? { status: "failed" as const } : {}),
      });
    })();

    return execHandle({ id: `agent37-${this.id}-${startedAt}`, run });
  }

  serialize(): Json {
    return { kind: "agent37", id: this.id };
  }

  async close(): Promise<void> {
    // Stop, not delete: the instance can be started again under the same id,
    // and deleting would throw away a workspace that may still be wanted.
    await call(
      this.options,
      `${this.options.controlUrl ?? CONTROL}/instances/${this.id}/stop`,
      "POST",
      {},
    );
  }
}

async function create(options: Agent37Options): Promise<string> {
  const body = await call<{ id?: string; instance?: { id?: string } }>(
    options,
    `${options.controlUrl ?? CONTROL}/instances`,
    "POST",
    {
      ...(options.template ? { template: options.template } : {}),
      ...options.create,
    },
  );
  // The create response is documented as "the full instance object"; accept
  // it either bare or wrapped rather than assume one.
  const id = body.id ?? body.instance?.id;
  if (!id) throw new Error("agent37 did not return an instance id");
  return id;
}

async function call<T>(
  options: Agent37Options,
  url: string,
  method: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await globalThis.fetch(url, {
    method,
    headers: {
      // Not an Authorization header: Agent37 takes its own.
      "X-Agent37-Key": options.apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    throw new Error(`agent37 returned HTTP ${response.status} for ${url}: ${await text(response)}`);
  }
  return (await response.json()) as T;
}

async function text(response: Response): Promise<string> {
  try {
    const body = await response.text();
    return body.length > 300 ? `${body.slice(0, 300)}…` : body;
  } catch {
    return "";
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
