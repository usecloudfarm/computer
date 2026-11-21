import { execHandle, toExecResult } from "@cloudfarm/core";
import type {
  ComputerHost,
  ExecHandle,
  ExecOptions,
  Json,
  Sandbox,
  SandboxProvider,
} from "@cloudfarm/core";

const API = "https://boat.dev/api/v1";

export interface BoatOptions {
  /** A boat API key (`boat_…`), from `boat api-key create` or the dashboard. */
  readonly apiKey: string;
  /** Stop and snapshot the machine after this long. Defaults to one hour. */
  readonly ttlSeconds?: number;
  /** Per-command limit. The API waits up to 60s for a cold machine on top of this. */
  readonly timeoutSeconds?: number;
  readonly baseUrl?: string;
}

/**
 * boat.dev as a sandbox provider.
 *
 * A whole machine rather than a container: real binaries, Docker, npm, python.
 * The trade against the in-process default is latency — a first command pays
 * for the machine starting — and money, since a running machine bills until it
 * is stopped or its TTL expires.
 *
 * Plain REST, so it runs on Node and Workers alike. Its SDK is Node-shaped and
 * would have cost us the Workers target for no capability we need.
 */
export class Boat implements SandboxProvider {
  readonly id = "boat";
  readonly description =
    "A full Linux machine per workspace: any binary, Docker, npm, python, apt. Starts in " +
    "seconds and bills while it runs, so prefer it for work the built-in shell cannot do.";
  readonly capabilities = new Set(["bash" as const, "ports" as const]);

  readonly #options: BoatOptions;

  constructor(options: BoatOptions) {
    if (!options.apiKey) throw new Error("boat needs an apiKey (boat_…)");
    this.#options = options;
  }

  async connect(host: ComputerHost, resume?: Json): Promise<Sandbox> {
    const existing = (resume as { id?: string } | undefined)?.id;
    // Re-attach rather than start a second machine: the id is the whole of
    // the state, and a leaked machine bills until its TTL runs out.
    const id = existing ?? (await create(this.#options));
    return new BoatSandbox(id, this.#options, host);
  }
}

/** Convenience for the common case: `provider: boat({ apiKey })`. */
export function boat(options: BoatOptions): Boat {
  return new Boat(options);
}

class BoatSandbox implements Sandbox {
  constructor(
    readonly id: string,
    readonly options: BoatOptions,
    readonly host: ComputerHost,
  ) {}

  exec(command: string, options: ExecOptions = {}): ExecHandle {
    const startedAt = Date.now();
    const seconds =
      options.timeoutMs !== undefined
        ? Math.ceil(options.timeoutMs / 1000)
        : this.options.timeoutSeconds;

    const run = (async () => {
      const body = await call<{ exitCode?: number; stdout?: string; stderr?: string }>(
        this.options,
        `sandboxes/${this.id}/commands`,
        {
          command: options.cwd ? `cd ${quote(options.cwd)} && ${command}` : command,
          ...(seconds !== undefined ? { timeoutSeconds: seconds } : {}),
        },
        this.host.signal,
      );
      return toExecResult({
        exitCode: body.exitCode ?? null,
        ...(body.stdout !== undefined ? { stdout: body.stdout } : {}),
        ...(body.stderr !== undefined ? { stderr: body.stderr } : {}),
        startedAt,
      });
    })();

    return execHandle({ id: `boat-${this.id}-${startedAt}`, run });
  }

  serialize(): Json {
    return { kind: "boat", id: this.id };
  }

  async close(): Promise<void> {
    // Stop rather than delete: boat snapshots the disk, so the next connect
    // with the same id resumes the machine instead of losing its state.
    await call(this.options, `sandboxes/${this.id}/stop`, {});
  }
}

async function create(options: BoatOptions): Promise<string> {
  const body = await call<{ sandbox?: { id?: string } }>(options, "sandboxes", {
    ttlSeconds: options.ttlSeconds ?? 3600,
  });
  const id = body.sandbox?.id;
  if (!id) throw new Error("boat did not return a sandbox id");
  return id;
}

async function call<T>(
  options: BoatOptions,
  path: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await globalThis.fetch(`${options.baseUrl ?? API}/${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    throw new Error(`boat returned HTTP ${response.status} for ${path}: ${await text(response)}`);
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

/** The API takes one command string, so a working directory becomes a `cd`. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
