import { z } from "zod";

/**
 * Every value that crosses a boundary — into a capability handler, out to a
 * model, through the code-mode bridge — is defined here as a Zod schema, with
 * the TypeScript type inferred from it. One definition, used for both static
 * types and runtime validation.
 *
 * Behavioural contracts (filesystems, providers, engines) are plain interfaces
 * in `ports.ts`: they are objects with methods, not data, and Zod has nothing
 * useful to say about them.
 */

/** Anything that survives `JSON.stringify`. */
export const Json: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(Json),
    z.record(z.string(), Json),
  ]),
);
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// --- identity ---------------------------------------------------------------

/** `bash`, `browser.getPage`, `slack.sendMessage`. */
export const Ref = z
  .string()
  .regex(
    /^[a-z][a-z0-9_-]*(\.[a-zA-Z][a-zA-Z0-9_]*)?$/,
    "expected `namespace` or `namespace.member`",
  );
export type Ref = z.infer<typeof Ref>;

export const WorkspaceInfo = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  createdAt: z.number().int(),
  metadata: z.record(z.string(), Json).default({}),
});
export type WorkspaceInfo = z.infer<typeof WorkspaceInfo>;

// --- filesystem -------------------------------------------------------------

export const FileStat = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  mtime: z.number().int(),
  type: z.enum(["file", "directory"]),
});
export type FileStat = z.infer<typeof FileStat>;

/**
 * A pointer to a payload too large to hand a model inline. The body lives in
 * the workspace filesystem; the model sees the path, the size and a preview.
 */
export const LargeRef = z.object({
  $ref: z.string(),
  bytes: z.number().int().nonnegative(),
  mime: z.string().optional(),
  preview: z.string().optional(),
});
export type LargeRef = z.infer<typeof LargeRef>;

// --- exec -------------------------------------------------------------------

export const ExecStatus = z.enum(["completed", "failed", "cancelled"]);
export type ExecStatus = z.infer<typeof ExecStatus>;

export const ExecEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stdout"), data: z.string() }),
  z.object({ type: z.literal("stderr"), data: z.string() }),
  z.object({
    type: z.literal("exit"),
    exitCode: z.number().int().nullable(),
    status: ExecStatus,
  }),
]);
export type ExecEvent = z.infer<typeof ExecEvent>;

export const ExecResult = z.object({
  /** Separate from exitCode on purpose: a timeout has no exit code at all. */
  status: ExecStatus,
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().int().nonnegative(),
  /** Set when output was clipped for the model; the whole thing is at `path`. */
  truncated: z
    .object({ bytesDropped: z.number().int().nonnegative(), path: z.string() })
    .optional(),
});
export type ExecResult = z.infer<typeof ExecResult>;

export const ExecOptions = z.object({
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().default(30_000),
  /** Bytes of stdout+stderr kept inline before spilling to the filesystem. */
  maxInlineBytes: z.number().int().positive().default(32_768),
});
export type ExecOptions = z.input<typeof ExecOptions>;

// --- the result envelope ----------------------------------------------------

/**
 * Why a call failed, in a form a model can act on. These are the same codes
 * the code-mode bridge reports, so one vocabulary covers both paths.
 */
export const RunErrorCode = z.enum([
  "unknown_ref",
  "invalid_args",
  "invalid_code",
  "not_authenticated",
  "egress_denied",
  "rate_limited",
  "upstream_error",
  "limit_exceeded",
  "cancelled",
  "internal",
]);
export type RunErrorCode = z.infer<typeof RunErrorCode>;

export const RunError = z.object({
  code: RunErrorCode,
  message: z.string(),
  /** What to do about it, when there is something useful to say. */
  hint: z.string().optional(),
  /** True when the same call might succeed later. */
  retryable: z.boolean(),
  /** Structured extras: validation diagnostics, for instance. */
  details: Json.optional(),
});
export type RunError = z.infer<typeof RunError>;

/**
 * Every call returns this, whether it came from the `run` tool or from
 * `run()` inside code mode. One shape to check means a model never has to
 * guess whether a bare value means success, and never has to learn that some
 * tools throw while others return an error object.
 */
export const RunResult = z.union([
  z.object({ status: z.literal("ok"), value: Json.optional() }),
  z.object({ status: z.literal("error"), error: RunError }),
]);
export type RunResult = z.infer<typeof RunResult>;

export function ok(value?: Json): RunResult {
  return value === undefined ? { status: "ok" } : { status: "ok", value };
}

export function failed(error: RunError): RunResult {
  return { status: "error", error };
}

// --- capabilities -----------------------------------------------------------

export const SideEffects = z.enum(["read", "write", "destructive"]);
export type SideEffects = z.infer<typeof SideEffects>;

export const AuthStatus = z.enum(["authenticated", "needs_auth", "not_required"]);
export type AuthStatus = z.infer<typeof AuthStatus>;

/** What `search()` hands back: enough to write a correct call on the first try. */
export const CapabilitySummary = z.object({
  ref: Ref,
  app: z.object({ id: z.string(), name: z.string() }),
  summary: z.string(),
  /** Rendered TypeScript signature, e.g. `sendMessage(input: {...}): Promise<...>`. */
  signature: z.string(),
  /** One runnable line. The highest-leverage field for first-try correctness. */
  example: z.string(),
  sideEffects: SideEffects,
  auth: AuthStatus,
  score: z.number(),
});
export type CapabilitySummary = z.infer<typeof CapabilitySummary>;

export const SearchResult = z.object({
  capabilities: z.array(CapabilitySummary),
  /** Ambient .d.ts covering exactly these capabilities, for the model to read. */
  types: z.string(),
});
export type SearchResult = z.infer<typeof SearchResult>;

// --- code mode --------------------------------------------------------------

export const CodeLimits = z.object({
  /** Total wall clock, including time spent inside host calls. */
  timeoutMs: z.number().int().positive().default(15_000),
  /** Uninterrupted guest CPU, enforced by the engine's own interrupt handler. */
  cpuTimeoutMs: z.number().int().positive().default(5_000),
  memoryBytes: z
    .number()
    .int()
    .positive()
    .default(64 * 1024 * 1024),
  maxHostCalls: z.number().int().positive().default(32),
  maxResultBytes: z
    .number()
    .int()
    .positive()
    .default(256 * 1024),
  maxTotalBytes: z
    .number()
    .int()
    .positive()
    .default(1024 * 1024),
  maxLogBytes: z
    .number()
    .int()
    .positive()
    .default(32 * 1024),
  maxSourceBytes: z
    .number()
    .int()
    .positive()
    .default(64 * 1024),
});
export type CodeLimits = z.infer<typeof CodeLimits>;
export type CodeLimitsInput = z.input<typeof CodeLimits>;

export const HostCallError = z.object({
  code: z.enum([
    "unknown_capability",
    "invalid_args",
    "not_authenticated",
    "rate_limited",
    "upstream_error",
    "limit_exceeded",
    "cancelled",
    "internal",
  ]),
  message: z.string(),
  retryable: z.boolean(),
});
export type HostCallError = z.infer<typeof HostCallError>;

export const HostCallRequest = z.object({
  v: z.literal(1),
  /** Monotonic per run; the host rejects replays and gaps. */
  seq: z.number().int().nonnegative(),
  capability: Ref,
  args: Json.optional(),
});
export type HostCallRequest = z.infer<typeof HostCallRequest>;

export const HostCallResponse = z.union([
  z.object({
    v: z.literal(1),
    seq: z.number().int().nonnegative(),
    ok: z.literal(true),
    value: Json.optional(),
    bytes: z.number().int().nonnegative(),
    truncated: z.boolean().optional(),
  }),
  z.object({
    v: z.literal(1),
    seq: z.number().int().nonnegative(),
    ok: z.literal(false),
    error: HostCallError,
  }),
]);
export type HostCallResponse = z.infer<typeof HostCallResponse>;

export const CodeCall = z.object({
  capability: Ref,
  ok: z.boolean(),
  durationMs: z.number().int().nonnegative(),
});
export type CodeCall = z.infer<typeof CodeCall>;

/** Why a run was rejected before it executed. */
export const Diagnostic = z.object({
  code: z.enum(["syntax_error", "unknown_ref", "forbidden_construct", "source_too_large"]),
  message: z.string(),
  /** The ref the diagnostic is about, when it is about one. */
  ref: Ref.optional(),
  /** 1-indexed, relative to the source the model wrote. */
  line: z.number().int().positive().optional(),
  /** What to do instead. Written for the model, not for a log. */
  hint: z.string().optional(),
});
export type Diagnostic = z.infer<typeof Diagnostic>;

export const CodeResult = z.object({
  /**
   * How the run ended. Deliberately not called `status`: that word belongs to
   * the envelope every call is wrapped in, and two nested `status` keys
   * meaning different things is exactly the confusion worth avoiding.
   */
  outcome: z.enum(["ok", "invalid", "error", "timeout", "limit_exceeded"]),
  value: Json.optional(),
  error: z
    .object({ name: z.string(), message: z.string(), stack: z.string().optional() })
    .optional(),
  logs: z.string(),
  /** Every host call attempted, in order: the audit trail and the partial-work report. */
  calls: z.array(CodeCall),
  durationMs: z.number().int().nonnegative(),
  limitsHit: z.array(z.string()),
  /** Populated when `status` is `invalid`; empty otherwise. */
  diagnostics: z.array(Diagnostic).default([]),
});
export type CodeResult = z.infer<typeof CodeResult>;

// --- tools ------------------------------------------------------------------

export const ToolSpec = z.object({
  /** Model-visible name; dots become underscores. */
  name: z.string(),
  ref: Ref,
  description: z.string(),
  /** JSON Schema, produced from the capability's Zod schema. */
  inputSchema: z.record(z.string(), z.unknown()),
  annotations: z
    .object({ readOnly: z.boolean().optional(), sideEffects: SideEffects.optional() })
    .optional(),
});
export type ToolSpec = z.infer<typeof ToolSpec>;

// --- memory (interface only in v1) -----------------------------------------

export const MemoryRecord = z.object({
  id: z.string(),
  text: z.string(),
  metadata: z.record(z.string(), Json).optional(),
  createdAt: z.number().int(),
  score: z.number().optional(),
});
export type MemoryRecord = z.infer<typeof MemoryRecord>;
