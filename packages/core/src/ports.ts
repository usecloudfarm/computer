import type { z } from "zod";
import type {
  CodeLimits,
  CodeResult,
  Diagnostic,
  ExecEvent,
  ExecOptions,
  ExecResult,
  FileStat,
  HostCallRequest,
  HostCallResponse,
  Json,
  LargeRef,
  MemoryRecord,
  Ref,
  RunResult,
  SideEffects,
  ToolSpec,
  WorkspaceInfo,
} from "./schemas.js";

/**
 * The behavioural contracts. These are objects with methods rather than data,
 * so they stay as TypeScript interfaces; everything that crosses a boundary as
 * a *value* is a Zod schema in `schemas.ts`.
 */

/**
 * Identity plus a description written **for the model**. Every description in
 * this codebase is prompt text that ships to an LLM: changing one changes
 * behaviour for every consumer, so treat it as API and snapshot it in tests.
 */
export interface Described {
  readonly id: string;
  readonly description: string;
}

// --- filesystem -------------------------------------------------------------

export interface FileSystem {
  read(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  write(path: string, data: Uint8Array | string): Promise<FileStat>;
  list(prefix?: string): AsyncIterable<FileStat>;
  stat(path: string): Promise<FileStat | null>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  move(from: string, to: string): Promise<void>;
}

export interface StorageProvider extends Described {
  /** One filesystem per workspace. Called once, lazily, per workspace. */
  open(scope: { userId: string; workspaceId: string }): Promise<FileSystem>;
}

// --- sandbox ----------------------------------------------------------------

/** The handle is the event stream, and also resolves to a final result. */
export interface ExecHandle extends ReadableStream<ExecEvent> {
  readonly id: string;
  result(): Promise<ExecResult>;
  kill(): Promise<void>;
}

export interface Sandbox {
  exec(command: string, options?: ExecOptions): ExecHandle;
  /** Everything needed to re-attach after a process or Durable Object restart. */
  serialize(): Json;
  close(): Promise<void>;
}

export type SandboxCapability = "bash" | "ports";

export interface SandboxProvider extends Described {
  readonly capabilities: ReadonlySet<SandboxCapability>;
  connect(host: ComputerHost, resume?: Json): Promise<Sandbox>;
}

// --- the host seam ----------------------------------------------------------

/**
 * What a plugin is handed at connect time. Note what is absent: no `env`, no
 * credentials, no way to reach another user's workspace.
 */
export interface ComputerHost {
  readonly workspace: WorkspaceInfo;
  /** The only network path, so egress stays observable and allowlistable. */
  readonly fetch: typeof globalThis.fetch;
  readonly fs: FileSystem;
  readonly signal: AbortSignal;
}

// --- apps -------------------------------------------------------------------

/** `fetch` with the app's credential already applied. The token is never a value here. */
export type AuthorizedFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface CapabilityContext {
  readonly fetch: AuthorizedFetch;
  readonly workspace: WorkspaceInfo;
  readonly signal: AbortSignal;
  /** Park a large payload in the filesystem and hand back a pointer. */
  readonly ref: (data: Uint8Array | string, mime?: string) => Promise<LargeRef>;
}

export interface CapabilityDefinition<I = unknown, O = unknown> {
  /** Member name; the ref is `${app.id}.${name}`. */
  readonly name: string;
  /** Imperative, one line: "Post a message to a channel or DM." */
  readonly summary: string;
  /** Phrases this capability answers. The primary ranking signal for search(). */
  readonly useCases: readonly string[];
  readonly keywords?: readonly string[];
  readonly input: z.ZodType<I>;
  readonly output: z.ZodType<O>;
  /** One runnable line, shown in search results and as JSDoc in generated types. */
  readonly example: string;
  readonly sideEffects: SideEffects;
  handler(input: I, context: CapabilityContext): Promise<O>;
}

export interface App extends Described {
  readonly name: string;
  /** Hosts this app is allowed to call. Blocks a prompt-injected URL argument. */
  readonly allowedHosts: readonly string[];
  capabilities(): readonly CapabilityDefinition[];
  /** Applies the app's credential. Called per request; the token stays in this closure. */
  authorize(request: Request): Request;
}

// --- code mode --------------------------------------------------------------

export interface CodeEngineCapabilities {
  /** Can suspend guest execution across a host promise. */
  readonly asyncHostCalls: boolean;
  /** Can stop a non-yielding loop without killing the host thread. */
  readonly interruptible: boolean;
  readonly memoryCap: boolean;
}

/** The host side of the bridge. Must never throw: it returns error frames. */
export interface HostBridge {
  call(request: HostCallRequest, signal: AbortSignal): Promise<HostCallResponse>;
  log(level: "log" | "warn" | "error", args: unknown[]): void;
}

export interface CodeJob {
  readonly source: string;
  /** Capability proxies and console shim, prepended to the source. */
  readonly prelude: string;
  readonly limits: CodeLimits;
  readonly runId: string;
}

export interface CodeEngine extends Described {
  readonly capabilities: CodeEngineCapabilities;
  available(): Promise<{ ok: boolean; detail?: string }>;
  /**
   * Compiles without running, so a syntax error reaches the agent before any
   * side effect. Optional: an engine that cannot compile separately simply
   * surfaces the error at evaluation time instead.
   */
  validate?(source: string): Promise<Diagnostic[]>;
  /**
   * Evaluates in a fresh, single-use context. `bridge` is the only authority
   * the guest receives: no fetch, no filesystem, no timers that outlive the run.
   */
  evaluate(job: CodeJob, bridge: HostBridge): Promise<CodeResult>;
  dispose(): Promise<void>;
}

// --- toolsets ---------------------------------------------------------------

/** Every dispatch path answers with the same envelope — see `RunResult`. */
export type Invoke = (ref: Ref, args?: Json) => Promise<RunResult>;

/**
 * Turns library-free tool specs into whatever an agent framework expects.
 * Core never imports an agent SDK; adapters are leaf packages.
 */
export interface Toolset<T = unknown> {
  materialize(specs: readonly ToolSpec[], invoke: Invoke): T;
}

// --- memory (contract only in v1) ------------------------------------------

export interface MemoryStore extends Described {
  remember(text: string, metadata?: Record<string, Json>): Promise<MemoryRecord>;
  search(query: string, options?: { limit?: number }): Promise<MemoryRecord[]>;
  get(id: string): Promise<MemoryRecord | null>;
  forget(id: string): Promise<void>;
}
