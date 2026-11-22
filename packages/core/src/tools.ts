import { z } from "zod";
import { toJsonSchema } from "./typegen.js";
import type { Invoke, Toolset } from "./ports.js";
import type { ToolSpec } from "./schemas.js";

/**
 * The tools handed to a model.
 *
 * In `code` mode there are six of them whatever is installed: adding a tenth
 * app adds zero tokens to the system prompt. That is the whole bet — the model
 * discovers actions with `search` instead of carrying them all in context.
 */

export const BashInput = z.object({
  cmd: z.string().describe("The shell command to run."),
  cwd: z.string().optional().describe("Working directory. Defaults to the workspace root."),
  timeoutMs: z.number().int().positive().optional(),
});

export const SearchInput = z.object({
  useCase: z
    .string()
    .describe("What you are trying to do, in plain language: 'send a message to the team'."),
  limit: z.number().int().positive().max(25).optional(),
  app: z
    .string()
    .optional()
    .describe(
      "Restrict the search to one app's actions, by id — 'slack', or 'computer' for the shell and filesystem. Use list_apps to see the ids.",
    ),
});

export const RunInput = z.object({
  ref: z.string().describe("Action reference, e.g. 'slack.sendMessage'. Find one with search."),
  args: z.record(z.string(), z.unknown()).optional(),
});

export const CodeInput = z.object({
  source: z
    .string()
    .describe(
      "JavaScript to run. Call actions with run(ref, input) — the same refs and the " +
        "same result shape as the `run` tool: run('slack.sendMessage', { channel: '#general', " +
        "text: 'hi' }), run('fs.read', { path }), run('fs.write', { path, content }), " +
        "run('bash', { cmd }). Every call returns { status: 'ok', value } or " +
        "{ status: 'error', error: { code, message, hint } } — check status, it does not throw. " +
        "Everything is SYNCHRONOUS: no `await`, no promises. Use `return` to report a value " +
        "back; console.log is captured. The source is validated before it runs, so unknown " +
        "refs and syntax errors come back without executing anything.",
    ),
});

export const ListAppsInput = z.object({});
/**
 * One filesystem tool, three verbs.
 *
 * Flat rather than a discriminated union per op: models fumble `oneOf` in a
 * JSON Schema far more often than they fumble "this field is needed for that
 * op", and the host validates the combination anyway.
 */
export const FsInput = z.object({
  op: z.enum(["read", "write", "list"]),
  path: z
    .string()
    .optional()
    .describe(
      "File path for read and write. For list, the directory prefix to list; defaults to the workspace root.",
    ),
  content: z.string().optional().describe("Text to write. Required when op is 'write'."),
});

const DESCRIPTIONS = {
  search:
    "Find actions by what you want to do. Returns signatures and examples you can call with `run`, or write against with `code`. Pass `app` to search within one app only.",
  run: "Run one action by reference. Find others with `search`. Answers { status: 'ok', value } or { status: 'error', error: { code, message, hint } }.",
  code: "Run JavaScript that calls several actions at once. Prefer this over many `run` calls when steps depend on each other. Actions are synchronous here: no `await`.",
  list_apps:
    "List the apps installed in this workspace and the actions each one contributes. Use it to see what is available at all; use `search` when you know what you want to do.",
  fs: "Read, write and list files in the workspace. op 'read' needs path, 'write' needs path and content, 'list' takes an optional path prefix.",
} as const;

export interface ToolContext {
  readonly hasCode: boolean;
  /** Built-in refs that are actually available right now. */
  readonly builtins: readonly string[];
  /** The sandbox's own words about what it can and cannot run. */
  readonly sandbox?: string | undefined;
  /** The storage provider's own words about where files live. */
  readonly storage?: string | undefined;
}

export function codeModeSpecs(options: ToolContext): ToolSpec[] {
  const specs: ToolSpec[] = [
    spec("search", "search", DESCRIPTIONS.search, SearchInput, "read"),
    spec("run", "run", describeRun(options), RunInput),
    spec("list_apps", "apps.list", DESCRIPTIONS.list_apps, ListAppsInput, "read"),
    // "write" is the honest annotation for the merged tool: it is the
    // superset of what the three ops do. A reading call loses the read-only
    // hint it used to carry — the one real cost of collapsing these.
    spec("fs", "fs", describeFs(options), FsInput, "write"),
  ];
  if (options.hasCode) {
    specs.splice(1, 0, spec("code", "code", describeCode(options), CodeInput));
  }
  return specs;
}

/**
 * `run`'s description, built from what this computer actually has.
 *
 * A fixed string either names a shell that is not installed or stays silent
 * about one that is — and a model only learns which by calling and failing.
 * The refs here come from the registry, filtered by availability, so the
 * description cannot drift from the dispatch.
 *
 * Refs are shown in call position — `{ ref: 'bash', args: { cmd } }` — rather
 * than as a list of quoted names. Models were calling `bash` as a tool of its
 * own and losing the turn to it. The old phrasing invited that: `'bash' for
 * the shell ({ cmd })` reads exactly like a tool signature, and two of the
 * three names it listed beside it, `code` and `fs`, really are tool names in
 * the same request. Given `code` and `fs` as tools, "and `bash`" is the
 * reasonable generalisation, so the description has to close it explicitly
 * rather than leave the model to infer the exception.
 */
function describeRun(options: ToolContext): string {
  const has = (ref: string) => options.builtins.includes(ref);
  const calls: string[] = [];

  if (has("bash")) calls.push("{ ref: 'bash', args: { cmd: 'ls -la /data' } } for the shell");
  if (has("fs.read")) calls.push("{ ref: 'fs.read', args: { path } }, and fs.write / fs.list");
  if (has("code")) calls.push("{ ref: 'code', args: { source } } to script several calls at once");

  const own =
    calls.length > 0
      ? ` The computer's own actions are called the same way: ${calls.join("; ")}.`
      : "";
  // Worth one blunt sentence: this is the mistake that costs a whole turn,
  // because an undeclared tool name is rejected before anything runs.
  const only = has("bash")
    ? " The shell is reached through this tool — there is no separate `bash` tool."
    : "";
  // The sandbox gets its own sentence. Inline it reads as a run-on, and what
  // the shell cannot do — npm, python — is the part worth landing clearly.
  const shell = options.sandbox ? ` The shell: ${options.sandbox}` : "";
  return `Run one action by reference, as { ref, args } — an app's, or one of the computer's own.${own}${only}${shell} Find others with \`search\`. Answers { status: 'ok', value } or { status: 'error', error: { code, message, hint } }.`;
}

/** The same for `fs`: where the files go is worth saying when it is known. */
function describeFs(options: ToolContext): string {
  return options.storage ? `${DESCRIPTIONS.fs} ${options.storage}` : DESCRIPTIONS.fs;
}

/** And for `code`: only name a shell the script can actually reach. */
function describeCode(options: ToolContext): string {
  const bash = options.builtins.includes("bash") ? ' `run("bash", { cmd })` works here too.' : "";
  return `${DESCRIPTIONS.code}${bash}`;
}

function spec(
  name: string,
  ref: string,
  description: string,
  schema: z.ZodType,
  sideEffects?: "read" | "write" | "destructive",
): ToolSpec {
  return {
    name,
    ref,
    description,
    inputSchema: toJsonSchema(schema),
    ...(sideEffects !== undefined
      ? { annotations: { sideEffects, readOnly: sideEffects === "read" } }
      : {}),
  };
}

/** The default toolset: hand back the specs and let the caller adapt them. */
export class RawToolset implements Toolset<{ specs: readonly ToolSpec[]; invoke: Invoke }> {
  materialize(specs: readonly ToolSpec[], invoke: Invoke) {
    return { specs, invoke };
  }
}
