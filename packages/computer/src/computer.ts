import { builtinActions, BUILTIN_APP } from "./builtins.js";
import { clampForModel, toLargeRef } from "./clamp.js";
import { createHttpClient } from "./http.js";
import { buildPrelude, ActionBridge, finishResult, resolveLimits } from "./code.js";
import { validateSource } from "./validate.js";
import { fromGuestPath, inSandbox } from "./paths.js";
import {
  ActionFailedError,
  classifyError,
  EgressDeniedError,
  InvalidArgumentsError,
  UnknownRefError,
} from "./errors.js";
import { ActionRegistry, parseInput, summarize } from "./registry.js";
import { Redactor } from "./redact.js";
import { codeModeSpecs, RawToolset } from "./tools.js";
import { renderDeclarations } from "./typegen.js";
import { failed, ok } from "./schemas.js";
import { defaultCodeEngine, defaultProvider } from "./defaults.js";
import { MemoryStorage } from "./vfs.js";
import type {
  App,
  CodeEngine,
  ComputerHost,
  FileSystem,
  Sandbox,
  SandboxProvider,
  StorageProvider,
  Toolset,
} from "./ports.js";
import type {
  CodeLimits,
  CodeResult,
  ExecOptions,
  ExecResult,
  FileStat,
  Json,
  RunResult,
  SearchResult,
  ToolSpec,
  WorkspaceInfo,
} from "./schemas.js";

export interface ComputerOptions<T = unknown> {
  /** Adapts tool specs to an agent framework. Defaults to handing back raw specs. */
  toolset?: Toolset<T>;
  /** Where workspace files live. Defaults to memory. */
  storage?: StorageProvider;
  /**
   * Compiled wasm modules, for Workers only.
   *
   * The shell and the engine are not configurable — which one runs is decided
   * by what is installed, not by what you pass. This is the one exception,
   * and it is not a choice: Workers refuses `WebAssembly.compile` on bytes,
   * so a module has to arrive as a static import and only your bundler can
   * emit one.
   *
   * ```ts
   * import engine from "@jitl/quickjs-wasmfile-release-asyncify/wasm";
   * import shell from "@cloudfarm/rbash/wasm";
   * new Computer({ wasm: { engine, shell } });
   * ```
   *
   * On Node, leave it out: both load their own `.wasm` from disk. Omit
   * `shell` and the shell falls back to `@cloudfarm/bash-sandbox`, which is
   * TypeScript and needs no module.
   */
  wasm?: {
    /** QuickJS, for code mode. */
    readonly engine?: WebAssembly.Module;
    /** `rust-bash`, for the shell. */
    readonly shell?: WebAssembly.Module;
  };
  apps?: readonly App[];
  limits?: Partial<CodeLimits>;
  /** Literal secrets to scrub from anything the model reads. */
  secrets?: readonly string[];
  now?: () => number;
}

/**
 * Options plus the shell and engine, once they have been found.
 *
 * Both are optional here and nowhere else: they are discovered with a dynamic
 * import, so a consumer who installed neither gets a Computer with storage,
 * apps and `search` and no `run`/`code` tools, rather than a crash at
 * construction.
 */
type ResolvedOptions = ComputerOptions<unknown> & {
  provider?: SandboxProvider;
  codeEngine?: CodeEngine;
};

export interface CreateWorkspaceOptions {
  userId: string;
  workspaceId?: string;
  metadata?: Record<string, Json>;
}

/**
 * A computer: storage, a shell, apps and code mode, scoped per workspace.
 *
 * `Computer` itself also exposes the workspace surface, delegating to a lazily
 * created default workspace, so single-tenant scripts never have to think
 * about workspaces. Anything serving more than one user should call
 * `createWorkspace(userId)` and use the returned object.
 */
export class Computer<T = unknown> {
  readonly #options: ComputerOptions<T>;
  readonly #storage: StorageProvider;
  readonly #toolset: Toolset<T>;
  readonly #registry: ActionRegistry;
  readonly #workspaces = new Map<string, Workspace<T>>();
  #defaultWorkspace: Promise<Workspace<T>> | undefined;
  #resolvedOptions: Promise<ResolvedOptions> | undefined;

  constructor(options: ComputerOptions<T> = {}) {
    this.#options = options;
    this.#storage = options.storage ?? new MemoryStorage();
    this.#toolset = options.toolset ?? (new RawToolset() as unknown as Toolset<T>);
    this.#registry = new ActionRegistry(options.apps ?? [], undefined, builtinActions());
  }

  get apps(): readonly App[] {
    return this.#options.apps ?? [];
  }

  /** Resume-or-create. Cheap: the sandbox connects on first use, not here. */
  async createWorkspace(userId: string): Promise<Workspace<T>>;
  async createWorkspace(options: CreateWorkspaceOptions): Promise<Workspace<T>>;
  async createWorkspace(input: string | CreateWorkspaceOptions): Promise<Workspace<T>> {
    const options = typeof input === "string" ? { userId: input } : input;
    const workspaceId = options.workspaceId ?? "default";
    const key = `${options.userId}/${workspaceId}`;

    const existing = this.#workspaces.get(key);
    if (existing) return existing;

    const info: WorkspaceInfo = {
      id: workspaceId,
      userId: options.userId,
      createdAt: (this.#options.now ?? Date.now)(),
      metadata: options.metadata ?? {},
    };
    const scope = { userId: options.userId, workspaceId };
    const fs = await this.#storage.open(scope);
    const workspace = new Workspace<T>({
      info,
      fs,
      storageDescription: this.#storage.description,
      registry: this.#registry,
      toolset: this.#toolset,
      options: await this.#resolved(),
    });
    this.#workspaces.set(key, workspace);
    return workspace;
  }

  getWorkspace(userId: string, workspaceId = "default"): Workspace<T> | undefined {
    return this.#workspaces.get(`${userId}/${workspaceId}`);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#workspaces.values()].map((workspace) => workspace.close()));
    this.#workspaces.clear();
    this.#defaultWorkspace = undefined;
  }

  // --- single-tenant convenience, delegating to one default workspace -------

  async tools(): Promise<T> {
    return (await this.#default()).tools();
  }
  async run(ref: string, args?: Json): Promise<RunResult> {
    return (await this.#default()).run(ref, args);
  }
  async search(useCase: string, options?: { limit?: number; app?: string }): Promise<SearchResult> {
    return (await this.#default()).search(useCase, options);
  }
  async code(source: string, options?: { limits?: Partial<CodeLimits> }): Promise<CodeResult> {
    return (await this.#default()).code(source, options);
  }
  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    return (await this.#default()).exec(command, options);
  }
  async fs(): Promise<FileSystem> {
    return (await this.#default()).fs;
  }

  /**
   * Finds the shell and the engine. Memoised per Computer: it is one dynamic
   * import each, and constructing them is cheap — neither the shell nor the
   * wasm variant does any work until first use.
   */
  #resolved(): Promise<ResolvedOptions> {
    this.#resolvedOptions ??= (async () => {
      const options = this.#options as ComputerOptions<unknown>;
      const [provider, codeEngine] = await Promise.all([
        defaultProvider(options.wasm?.shell),
        defaultCodeEngine(options.wasm?.engine),
      ]);
      return {
        ...options,
        ...(provider !== undefined ? { provider } : {}),
        ...(codeEngine !== undefined ? { codeEngine } : {}),
      };
    })();
    return this.#resolvedOptions;
  }

  #default(): Promise<Workspace<T>> {
    this.#defaultWorkspace ??= this.createWorkspace({ userId: "default" });
    return this.#defaultWorkspace;
  }
}

interface WorkspaceInit<T> {
  info: WorkspaceInfo;
  fs: FileSystem;
  /** The storage provider's own words, for the `fs` tool description. */
  storageDescription: string;
  registry: ActionRegistry;
  toolset: Toolset<T>;
  options: ResolvedOptions;
}

/** One user's computer: their files, their shell, their app calls. */
export class Workspace<T = unknown> {
  readonly info: WorkspaceInfo;
  readonly fs: FileSystem;

  readonly #registry: ActionRegistry;
  readonly #toolset: Toolset<T>;
  readonly #options: ResolvedOptions;
  readonly #redactor = new Redactor();
  readonly #controller = new AbortController();
  #sandbox: Promise<Sandbox> | undefined;
  #runCounter = 0;

  readonly #storageDescription: string;

  constructor(init: WorkspaceInit<T>) {
    this.info = init.info;
    this.fs = init.fs;
    this.#storageDescription = init.storageDescription;
    this.#registry = init.registry;
    this.#toolset = init.toolset;
    this.#options = init.options;
    for (const secret of init.options.secrets ?? []) this.#redactor.add(secret);
  }

  /** The tools to hand a model. Six of them, however many apps are installed. */
  async tools(): Promise<T> {
    const specs = this.toolSpecs();
    return this.#toolset.materialize(specs, (ref, args) => this.run(ref, args));
  }

  toolSpecs(): readonly ToolSpec[] {
    const provider = this.#options.provider;
    return codeModeSpecs({
      hasCode: this.#options.codeEngine !== undefined,
      guestAwait: this.#options.codeEngine?.capabilities.guestAwait ?? false,
      // One source of truth: the same list `search` and `apps.list` use, so
      // the description cannot name a ref that dispatch would reject.
      builtins: this.#registry.builtins((needs) => this.#has(needs)).map((entry) => entry.ref),
      ...(provider ? { sandbox: provider.description } : {}),
      ...(this.#storageDescription ? { storage: this.#storageDescription } : {}),
    });
  }

  /** Find actions by intent, with the types needed to call them. */
  async search(
    useCase: string,
    options: { limit?: number; app?: string } = {},
  ): Promise<SearchResult> {
    // A typo'd app id would otherwise return zero hits, which reads as "this
    // computer cannot do that" rather than "no such app".
    if (options.app !== undefined && !this.#registry.ids().includes(options.app)) {
      throw new InvalidArgumentsError("search", [
        `no app called "${options.app}"; installed: ${this.#registry.ids().join(", ")}`,
      ]);
    }

    const hits = this.#registry.search(
      useCase,
      options.limit ?? 8,
      (needs) => this.#has(needs),
      options.app,
    );
    return {
      actions: hits.map((hit) => summarize(hit.entry, hit.score, true)),
      types: renderDeclarations(
        hits.map((hit) => ({
          ref: hit.entry.ref,
          appId: hit.entry.app.id,
          appName: hit.entry.app.name,
          appDescription: hit.entry.app.description,
          action: hit.entry.action,
          authenticated: true,
        })),
      ),
    };
  }

  /**
   * Dispatch one ref, always answering with the same envelope.
   *
   * Nothing here throws for an expected failure — an unknown ref, bad
   * arguments or an upstream refusal all come back as `{ status: "error" }`
   * with a code the model can branch on. A model should never have to learn
   * that some calls throw and others return, nor guess whether a bare value
   * meant success.
   */
  async run(ref: string, args?: Json): Promise<RunResult> {
    try {
      // These two already answer in the envelope's own terms; wrapping again
      // would hand the model `{ status: "ok", value: { status: ... } }`.
      if (ref === "run") {
        const record = (args ?? {}) as Record<string, Json>;
        return this.run(stringField(args, "ref"), record["args"] ?? null);
      }
      // The `code` tool's own dispatch ref, not a discoverable action: it is
      // absent from the registry, so `search` never offers it and a script
      // that calls run("code", …) is rejected by validation rather than
      // recursing. Reaching code mode twice over, by two shapes, was the
      // confusion worth removing.
      if (ref === "code") {
        return toEnvelope(await this.code(stringField(args, "source")));
      }
      return ok(await this.#dispatch(ref, args));
    } catch (error) {
      const { code, retryable, hint } = classifyError(error);
      return failed({
        code,
        message: this.#redactor.text(error instanceof Error ? error.message : String(error)),
        retryable,
        ...(hint !== undefined ? { hint } : {}),
      });
    }
  }

  /** The raw dispatch. Throws; `run` is the wrapper that never does. */
  async #dispatch(ref: string, args?: Json): Promise<Json> {
    const [namespace = "", member] = splitRef(ref);

    switch (namespace) {
      case "bash":
        return (await this.exec(
          stringField(args, "cmd"),
          optionalExecOptions(args),
        )) as unknown as Json;
      case "search": {
        // `app` must be absent rather than undefined: exactOptionalPropertyTypes.
        const app = optionalString(args, "app");
        const options = app === undefined ? {} : { app };
        return (await this.search(stringField(args, "useCase"), options)) as unknown as Json;
      }

      // The filesystem the `require("fs")` shim calls, and nothing else.
      // Deliberately not in `builtinActions` or `#builtinRefs`: `search` never
      // offers it, and a script writing run("fs.read", …) is rejected by
      // validation. The prelude reaches it through __host, which does not go
      // through that check — so there is exactly one spelling, `require`.
      case "fs":
        return this.#runFs(member ?? stringField(args, "op"), args);
      case "apps":
        if (member !== "list") {
          throw new UnknownRefError(`apps.${member ?? ""}`, ["apps.list"]);
        }
        return {
          apps: [
            // The computer is listed first and as an app, because that is what
            // `run` treats it as.
            {
              id: BUILTIN_APP.id,
              name: BUILTIN_APP.name,
              description: BUILTIN_APP.description,
              actions: this.#registry.builtins((needs) => this.#has(needs)).map((e) => e.ref),
              auth: "none",
            },
            ...this.#registry.apps(),
          ],
        } as unknown as Json;
      default:
        return this.#runAction(ref, args);
    }
  }

  /** Run a shell command. The returned result is already clamped for a model. */
  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const provider = this.#options.provider;
    if (!provider) {
      throw new UnknownRefError("bash", ["install @cloudfarm/bash-sandbox to get a shell"]);
    }
    const sandbox = await this.#connectSandbox(provider);

    // No syncing: the shell runs in this process over this filesystem, so
    // there is one filesystem and nothing to reconcile. There used to be two,
    // and a push/pull around every command to pretend otherwise.
    const handle = sandbox.exec(command, options);
    const result = await handle.result();

    const limit = options.maxInlineBytes ?? 32_768;
    const runId = `run-${++this.#runCounter}`;
    const stdout = await clampForModel(result.stdout, limit, {
      fs: this.fs,
      path: `/.cloudfarm/output/${runId}.stdout.txt`,
    });
    const stderr = await clampForModel(result.stderr, limit, {
      fs: this.fs,
      path: `/.cloudfarm/output/${runId}.stderr.txt`,
    });

    return {
      ...result,
      stdout: this.#redactor.text(stdout.text),
      stderr: this.#redactor.text(stderr.text),
      ...((stdout.truncated ?? stderr.truncated)
        ? { truncated: stdout.truncated ?? stderr.truncated! }
        : {}),
    };
  }

  /** Run generated code against the action proxies. */
  async code(source: string, options: { limits?: Partial<CodeLimits> } = {}): Promise<CodeResult> {
    const engine = this.#options.codeEngine;
    const limits = resolveLimits({ ...this.#options.limits, ...options.limits });
    const bridge = new ActionBridge({
      invoke: (ref, args) => this.run(ref, args),
      limits,
      redactor: this.#redactor,
    });

    if (!engine) {
      return finishResult({
        outcome: "error",
        error: {
          name: "NoCodeEngineError",
          message:
            "Code mode could not start: @cloudfarm/qjs-engine is not installed. " +
            "Install it. On Workers, also pass `wasm.engine` — the wasm has to " +
            "be a static import, which only your bundler can emit.",
        },
        bridge,
        durationMs: 0,
        redactor: this.#redactor,
      });
    }

    if (new TextEncoder().encode(source).byteLength > limits.maxSourceBytes) {
      return finishResult({
        outcome: "limit_exceeded",
        error: {
          name: "SourceTooLargeError",
          message: `Source exceeds ${limits.maxSourceBytes} bytes`,
        },
        bridge,
        durationMs: 0,
        redactor: this.#redactor,
        extraLimits: ["maxSourceBytes"],
      });
    }

    // Validate before anything executes. A typo on line three would otherwise
    // land two real side effects before failing, leaving the agent to reason
    // about a half-applied script.
    const diagnostics = validateSource({
      source,
      registry: this.#registry,
      builtins: this.#builtinRefs(),
      allowAwait: engine.capabilities.guestAwait,
    });
    if (engine.validate) diagnostics.push(...(await engine.validate(source)));

    if (diagnostics.length > 0) {
      return finishResult({
        outcome: "invalid",
        error: {
          name: "ValidationError",
          message: diagnostics.map((d) => `${d.message}${d.hint ? ` ${d.hint}` : ""}`).join(" "),
        },
        bridge,
        durationMs: 0,
        redactor: this.#redactor,
        diagnostics,
      });
    }

    return engine.evaluate(
      {
        source,
        prelude: buildPrelude(),
        limits,
        runId: `code-${++this.#runCounter}`,
      },
      bridge,
    );
  }

  /**
   * The host half of code mode's `fs`.
   *
   * Paths arrive as the guest sees them, so they are sandbox paths and get
   * translated on the way in — and `FileStat.path` is translated back on the
   * way out, or `readdirSync` would hand the script paths it cannot then
   * read. The isolate and the in-sandbox engine agree because of this; one of
   * them has a real `fs` and could not have been talked out of it.
   */
  async #runFs(member: string, args?: Json): Promise<Json> {
    switch (member) {
      case "read":
        return this.fs.readText(fromGuestPath(stringField(args, "path")));
      case "write": {
        const stat = await this.fs.write(
          fromGuestPath(stringField(args, "path")),
          stringField(args, "content"),
        );
        return toGuestStat(stat) as unknown as Json;
      }
      case "list": {
        const entries: Json[] = [];
        const prefix = optionalString(args, "prefix") ?? optionalString(args, "path") ?? "/";
        for await (const entry of this.fs.list(fromGuestPath(prefix))) {
          entries.push(toGuestStat(entry) as unknown as Json);
        }
        return entries;
      }
      case "stat": {
        const stat = await this.fs.stat(fromGuestPath(stringField(args, "path")));
        return (stat ? toGuestStat(stat) : null) as unknown as Json;
      }
      case "remove":
        await this.fs.remove(fromGuestPath(stringField(args, "path")), { recursive: true });
        return null;
      default:
        throw new UnknownRefError(`fs.${member}`, ["fs.read", "fs.write", "fs.list", "fs.remove"]);
    }
  }

  async close(): Promise<void> {
    this.#controller.abort();
    const sandbox = this.#sandbox;
    this.#sandbox = undefined;
    if (sandbox) await (await sandbox).close();
  }

  /** Everything needed to rehydrate this workspace elsewhere. */
  serialize(): Json {
    return { info: this.info as unknown as Json };
  }

  // --- internals ------------------------------------------------------------

  /**
   * Refs that exist without an app behind them. Validation needs these so it
   * does not reject `run("bash", …)` as an unknown action.
   */
  /** Whether the optional package a built-in needs actually resolved. */
  #has(needs: "sandbox"): boolean {
    return needs === "sandbox"
      ? this.#options.provider !== undefined
      : this.#options.codeEngine !== undefined;
  }

  #builtinRefs(): Set<string> {
    const refs = new Set(["search", "apps.list"]);
    if (this.#options.provider) refs.add("bash");
    return refs;
  }

  #connectSandbox(provider: SandboxProvider): Promise<Sandbox> {
    this.#sandbox ??= provider.connect(this.#host());
    return this.#sandbox;
  }

  #host(): ComputerHost {
    return {
      workspace: this.info,
      fetch: globalThis.fetch.bind(globalThis),
      fs: this.fs,
      signal: this.#controller.signal,
    };
  }

  async #runAction(ref: string, args?: Json): Promise<Json> {
    const entry = this.#registry.get(ref);
    const parsed = parseInput(entry.action.input, args ?? {});
    if (!parsed.ok) throw new InvalidArgumentsError(ref, parsed.issues);

    const app = entry.app;
    // Egress is scoped to the hosts the app declared, so a prompt-injected URL
    // argument cannot redirect a credentialed request somewhere else.
    const authorizedFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (!isAllowed(url.hostname, app.allowedHosts)) {
        throw new EgressDeniedError(url.hostname, app.allowedHosts);
      }
      return globalThis.fetch(app.authorize(new Request(url, init)));
    };

    try {
      const output = await entry.action.handler(parsed.value, {
        fetch: authorizedFetch,
        // Built per call, over the same allowlisted fetch, so an app cannot
        // acquire wider reach by using the convenient path.
        http: createHttpClient(authorizedFetch, app.http ?? {}),
        workspace: this.info,
        signal: this.#controller.signal,
        ref: (data, mime) =>
          toLargeRef(data, {
            fs: this.fs,
            path: `/.cloudfarm/refs/${ref}-${++this.#runCounter}`,
            ...(mime !== undefined ? { mime } : {}),
          }),
      });
      return this.#redactor.value(output) as Json;
    } catch (error) {
      if (error instanceof EgressDeniedError || error instanceof InvalidArgumentsError) throw error;
      throw new ActionFailedError(
        ref,
        this.#redactor.text(error instanceof Error ? error.message : String(error)),
        error,
      );
    }
  }
}

/**
 * A code run becomes a call like any other: rejected source is a failed call
 * carrying its diagnostics, anything that actually executed is a success whose
 * value says how it ended.
 */
function toEnvelope(result: CodeResult): RunResult {
  if (result.outcome === "invalid") {
    return failed({
      code: "invalid_code",
      message: result.error?.message ?? "The source was rejected before it ran.",
      retryable: false,
      hint: "Fix the reported lines and send it again; nothing was executed.",
      details: result.diagnostics as unknown as Json,
    });
  }
  return ok(result as unknown as Json);
}

function splitRef(ref: string): [string, string | undefined] {
  const index = ref.indexOf(".");
  return index === -1 ? [ref, undefined] : [ref.slice(0, index), ref.slice(index + 1)];
}

/** `*.slack.com` matches a subdomain; a bare host matches exactly. */
function isAllowed(hostname: string, allowed: readonly string[]): boolean {
  return allowed.some((pattern) =>
    pattern.startsWith("*.")
      ? hostname === pattern.slice(2) || hostname.endsWith(pattern.slice(1))
      : hostname === pattern,
  );
}

function stringField(args: Json | undefined, field: string): string {
  const value = (args as Record<string, unknown> | undefined)?.[field];
  if (typeof value !== "string") {
    throw new InvalidArgumentsError(field, [`${field} must be a string`]);
  }
  return value;
}

function optionalString(args: Json | undefined, field: string): string | undefined {
  const value = (args as Record<string, unknown> | undefined)?.[field];
  return typeof value === "string" ? value : undefined;
}

function optionalExecOptions(args: Json | undefined): ExecOptions {
  const record = (args ?? {}) as Record<string, unknown>;
  return {
    ...(typeof record["cwd"] === "string" ? { cwd: record["cwd"] } : {}),
    ...(typeof record["timeoutMs"] === "number" ? { timeoutMs: record["timeoutMs"] } : {}),
  };
}

/**
 * A `FileStat` as the guest should see it: its path in sandbox terms.
 *
 * Without this, `fs.readdirSync("/data")` returns workspace paths and the
 * very next `readFileSync` on one of them resolves somewhere else.
 */
function toGuestStat(stat: FileStat): FileStat {
  return { ...stat, path: inSandbox(stat.path) };
}
