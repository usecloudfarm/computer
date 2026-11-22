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
        "run('bash', { cmd }). Use the fs refs for files here rather than shell " +
        "redirection: they take the content as an argument, where a heredoc would be " +
        "quoted inside a JS string inside JSON. Every call returns { status: 'ok', value } or " +
        "{ status: 'error', error: { code, message, hint } } — check status, it does not throw. " +
        "Everything is SYNCHRONOUS: no `await`, no promises. Use `return` to report a value " +
        "back; console.log is captured. The source is validated before it runs, so unknown " +
        "refs and syntax errors come back without executing anything.",
    ),
});

export const ListAppsInput = z.object({});

const DESCRIPTIONS = {
  search:
    "Find actions by what you want to do. Returns signatures and examples you can call with `run`, or write against with `code`. Pass `app` to search within one app only.",
  run: "Run one action by reference. Find others with `search`. Answers { status: 'ok', value } or { status: 'error', error: { code, message, hint } }.",
  code: "Run JavaScript that calls several actions at once. Prefer this over many `run` calls when steps depend on each other. Actions are synchronous here: no `await`.",
  list_apps:
    "List the apps installed in this workspace and the actions each one contributes. Use it to see what is available at all; use `search` when you know what you want to do.",
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
 * the shell ({ cmd })` reads exactly like a tool signature, and `code` and
 * `fs`, listed beside it, really were tool names in the same request. `fs` is
 * gone now, but `code` remains, so the exception still has to be closed here
 * rather than left for the model to infer.
 *
 * Files are described through the shell because the shell is where they are:
 * `cat`, `grep` and a heredoc do everything the `fs` tool did, and one way to
 * reach the filesystem is one fewer thing to choose between. The `fs.*` refs
 * stay — they take a path and content as arguments, which beats quoting when
 * the content is awkward, and code mode has nothing else to call.
 */
function describeRun(options: ToolContext): string {
  const has = (ref: string) => options.builtins.includes(ref);
  const calls: string[] = [];

  if (has("bash")) calls.push("{ ref: 'bash', args: { cmd: 'ls -la /data' } } for the shell");
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
  const files = describeFiles(has);
  // The sandbox gets its own sentence. Inline it reads as a run-on, and what
  // the shell cannot do — npm, python — is the part worth landing clearly.
  const shell = options.sandbox ? ` The shell: ${options.sandbox}` : "";
  // Durability is the model's business: whether a file it writes survives the
  // turn changes whether writing it was worth doing.
  const storage = options.storage ? ` Files: ${options.storage}` : "";
  return `Run one action by reference, as { ref, args } — an app's, or one of the computer's own.${own}${only}${files}${shell}${storage} Find others with \`search\`. Answers { status: 'ok', value } or { status: 'error', error: { code, message, hint } }.`;
}

/**
 * How to touch the filesystem, and how not to flood the context doing it.
 *
 * The budget advice is the part that earns its tokens. `cat` on a file the
 * model has not sized is the cheapest way it has to fill its own context with
 * something it cannot use, and the result is clamped anyway — so it pays for
 * the whole file and still gets a truncated one. Naming the cheaper commands
 * is more useful than telling it to be careful.
 */
function describeFiles(has: (ref: string) => boolean): string {
  const shell = has("bash");
  const refs = has("fs.read");
  if (!shell && !refs) return "";

  const how = shell
    ? " Files go through the shell: read with `cat`, `head -n 50` or `sed -n '1,80p'`, search with `grep -n`, list with `ls -la`, and write with a heredoc — { ref: 'bash', args: { cmd: \"cat > /out/notes.md <<'EOF'\\n…\\nEOF\" } }." +
      (refs
        ? " `fs.read` / `fs.write` / `fs.list` do the same with { path } and { path, content } as arguments, which is safer when the content would be awkward to quote."
        : "")
    : " Files go through { ref: 'fs.read', args: { path } }, and fs.write / fs.list.";

  const budget = shell
    ? " Keep results small: `wc -l` or `ls -la` before reading something you have not sized, `grep` instead of reading a file to search it, and `head`/`tail` instead of whole files. Long output is truncated, so reading a large file costs context and still arrives incomplete."
    : " Long output is truncated, so prefer reading what you need over whole files.";

  return how + budget;
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
