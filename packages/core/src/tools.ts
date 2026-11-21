import { z } from "zod";
import { toJsonSchema } from "./typegen.js";
import type { Invoke, Toolset } from "./ports.js";
import type { ToolSpec } from "./schemas.js";

/**
 * The tools handed to a model.
 *
 * In `code` mode there are six of them whatever is installed: adding a tenth
 * app adds zero tokens to the system prompt. That is the whole bet — the model
 * discovers capabilities with `search` instead of carrying them all in context.
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
  ref: z.string().describe("Capability reference, e.g. 'slack.sendMessage'. Find one with search."),
  args: z.record(z.string(), z.unknown()).optional(),
});

export const CodeInput = z.object({
  source: z
    .string()
    .describe(
      "JavaScript to run. Everything is SYNCHRONOUS — no `await`, no promises. " +
        "In scope: every capability from search() as an object " +
        "(`slack.sendMessage({ channel: '#general', text: 'hi' })`), the workspace " +
        "filesystem as `fs.read({ path })` / `fs.write({ path, content })` / " +
        "`fs.list({ prefix })` / `fs.remove({ path })`, and `bash({ cmd })` when a " +
        "sandbox is configured. Use `return` to report a value back; console.log is captured.",
    ),
});

export const ReadInput = z.object({ path: z.string() });
export const WriteInput = z.object({ path: z.string(), content: z.string() });
export const ListInput = z.object({ prefix: z.string().optional() });

const DESCRIPTIONS = {
  bash: "Run a shell command in the workspace. Use for file manipulation, text processing and anything the shell does well.",
  search:
    "Find capabilities by what you want to do. Returns signatures and examples you can call with `run`, or write against with `code`.",
  run: "Call one capability directly by reference. Cheaper and more auditable than `code` for a single call.",
  code: "Run JavaScript that calls several capabilities at once. Prefer this over many `run` calls when steps depend on each other. Capabilities are synchronous here: no `await`.",
  fs_read: "Read a text file from the workspace.",
  fs_write: "Write a text file to the workspace.",
  fs_list: "List files in the workspace.",
} as const;

export function codeModeSpecs(options: { hasSandbox: boolean; hasCode: boolean }): ToolSpec[] {
  const specs: ToolSpec[] = [
    spec("search", "search", DESCRIPTIONS.search, SearchInput, "read"),
    spec("run", "run", DESCRIPTIONS.run, RunInput),
    spec("fs_read", "fs.read", DESCRIPTIONS.fs_read, ReadInput, "read"),
    spec("fs_write", "fs.write", DESCRIPTIONS.fs_write, WriteInput, "write"),
    spec("fs_list", "fs.list", DESCRIPTIONS.fs_list, ListInput, "read"),
  ];
  if (options.hasSandbox) {
    specs.unshift(spec("bash", "bash", DESCRIPTIONS.bash, BashInput));
  }
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
