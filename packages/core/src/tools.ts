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
    "Find actions by what you want to do. Returns signatures and examples you can call with `run`, or write against with `code`.",
  run: "Run one action by reference — an app's, or one of the computer's own: 'bash' for the shell ({ cmd }), 'code' to script several calls, 'fs.read' / 'fs.write' / 'fs.list'. Find others with `search`. Answers { status: 'ok', value } or { status: 'error', error: { code, message, hint } }.",
  code: "Run JavaScript that calls several actions at once. Prefer this over many `run` calls when steps depend on each other. Actions are synchronous here: no `await`.",
  list_apps:
    "List the apps installed in this workspace and the actions each one contributes. Use it to see what is available at all; use `search` when you know what you want to do.",
  fs: "Read, write and list files in the workspace. op 'read' needs path, 'write' needs path and content, 'list' takes an optional path prefix.",
} as const;

export function codeModeSpecs(options: { hasCode: boolean }): ToolSpec[] {
  const specs: ToolSpec[] = [
    spec("search", "search", DESCRIPTIONS.search, SearchInput, "read"),
    spec("run", "run", DESCRIPTIONS.run, RunInput),
    spec("list_apps", "apps.list", DESCRIPTIONS.list_apps, ListAppsInput, "read"),
    // "write" is the honest annotation for the merged tool: it is the
    // superset of what the three ops do. A reading call loses the read-only
    // hint it used to carry — the one real cost of collapsing these.
    spec("fs", "fs", DESCRIPTIONS.fs, FsInput, "write"),
  ];
  if (options.hasCode) {
    specs.splice(1, 0, spec("code", "code", DESCRIPTIONS.code, CodeInput));
  }
  return specs;
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
