import { z } from "zod";
import { toJsonSchema } from "./typegen.js";
import type { Invoke, Toolset } from "./ports.js";
import type { ToolSpec } from "./schemas.js";

/**
 * The tools handed to a model.
 *
 * Three, whatever is installed: adding a tenth app adds zero tokens to the
 * system prompt. That is the whole bet — the model discovers actions with
 * `search` instead of carrying them all in context.
 *
 * `search` finds, `code` chains, `run` does. Everything else a computer can do
 * is an action behind `run`, including listing what is installed: `list_apps`
 * was `search` with an empty query and a different result shape, and it was
 * the second place a model could learn a ref exists without learning how to
 * call it.
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
      "Restrict the search to one app's actions, by id — 'slack', or 'computer' for the shell. Search for 'what is installed' to see the ids.",
    ),
});

export const RunInput = z.object({
  ref: z.string().describe("Action reference, e.g. 'slack.sendMessage'. Find one with search."),
  args: z.record(z.string(), z.unknown()).optional(),
});

export const CodeInput = z.object({
  source: z.string().describe(
    // The example is an app's action, not a built-in. Naming the shell here
    // is what produced scripts that read a file by shelling out to `cat`,
    // and the refs a script needs are the ones `search` just returned.
    "JavaScript to run. Call actions with run(ref, input) — the same refs and the " +
      "same result shape as the `run` tool: run('slack.sendMessage', { channel: '#general', " +
      "text: 'hi' }). Every call returns " +
      "{ status: 'ok', value } or " +
      "{ status: 'error', error: { code, message, hint } } — check status, it does not throw. " +
      "Use `return` to report a value back; console.log is captured. The source is validated " +
      "before it runs, so unknown refs and syntax errors come back without executing anything.",
  ),
});

const DESCRIPTIONS = {
  search:
    "Find actions by what you want to do. Returns signatures and examples you can call with `run`, or write against with `code`. Pass `app` to search within one app only.",
  run: "Run one action by reference. Find others with `search`. Answers { status: 'ok', value } or { status: 'error', error: { code, message, hint } }.",
  // The concurrency rule is not here: it depends on the engine, and a fixed
  // sentence saying "no `await`" was still being emitted in front of the
  // generated one saying it is available.
  code: "Run JavaScript that calls several actions at once. Prefer this over many `run` calls when steps depend on each other.",
} as const;

export interface ToolContext {
  readonly hasCode: boolean;
  /** Built-in refs that are actually available right now. */
  readonly builtins: readonly string[];
  /** Whether the engine accepts `await` in the guest's source. */
  readonly guestAwait?: boolean | undefined;
  /** The sandbox's own words about what it can and cannot run. */
  readonly sandbox?: string | undefined;
  /** The storage provider's own words about where files live. */
  readonly storage?: string | undefined;
}

export function codeModeSpecs(options: ToolContext): ToolSpec[] {
  const specs: ToolSpec[] = [
    spec("search", "search", DESCRIPTIONS.search, SearchInput, "read"),
    spec("run", "run", describeRun(options), RunInput),
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

  if (has("bash"))
    calls.push("{ ref: 'bash', args: { cmd: 'grep -c ERROR /logs/app.log' } } for the shell");

  const own =
    calls.length > 0
      ? ` The computer's own actions are called the same way: ${calls.join("; ")}.`
      : "";
  // Worth one blunt sentence: this is the mistake that costs a whole turn,
  // because an undeclared tool name is rejected before anything runs.
  const only = has("bash")
    ? " The shell is reached through this tool — there is no separate `bash` tool."
    : "";
  const files = describeFiles(has, options.hasCode);
  // The sandbox gets its own sentence. Inline it reads as a run-on, and what
  // the shell cannot do — npm, python — is the part worth landing clearly.
  const shell = options.sandbox ? ` The shell: ${options.sandbox}` : "";
  // Durability is the model's business: whether a file it writes survives the
  // turn changes whether writing it was worth doing.
  const storage = options.storage ? ` Storage: ${options.storage}` : "";
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
function describeFiles(has: (ref: string) => boolean, hasCode: boolean): string {
  if (!has("bash")) return "";

  // This used to teach `cat`, `ls -la`, `grep -n` and heredocs. It was the
  // only filesystem `run` had, so it had to — and the result was a model
  // writing `run("bash", { cmd: "find / -name sales.csv" })` from inside
  // `code`, where one line of `fs` does it. Two descriptions in one request
  // teaching different filesystems is a coin toss, so this one stops
  // teaching and points at the other.
  // Neither a tutorial nor a prohibition. Teaching cat/ls/grep/heredocs here
  // had a model shelling out from inside `code`; banning them outright sent
  // it to `code` for a single read. One call is one call either way — the
  // difference only shows up once there are several.
  const files = hasCode
    ? " `cat`, `ls` and `>` are fine here for a single file. For several, or for anything you want as data rather than text, the `code` tool has fs.readFileSync / writeFileSync / readdirSync and does the lot in one call."
    : "";

  return (
    files +
    " Shell output is truncated when long, so prefer a command that returns what you need" +
    " over one that returns everything."
  );
}

/**
 * And for `code`: only name a shell the script can actually reach, and only
 * claim the concurrency the engine actually has.
 *
 * The synchronous rule used to sit in `CodeInput`'s schema, which is a fixed
 * string — so a computer running an engine that accepts `await` was telling
 * the model the opposite of what its validator would allow.
 */
function describeCode(options: ToolContext): string {
  const lines = [DESCRIPTIONS.code, ""];

  lines.push(
    options.guestAwait
      ? "- Actions: run(ref, input). `await` is available, and optional — a call without it returns the same value."
      : "- Actions: run(ref, input). Everything is SYNCHRONOUS: no `await`, no promises.",
  );

  // The shell is not named here, deliberately. It is an action like any
  // other — `run` describes it and `search` finds it — and naming it in the
  // tool whose whole point is writing JavaScript is what produced scripts
  // that read a file by shelling out to `cat`: shell, quoted inside a JS
  // string, inside JSON, to do what one line of JS does.
  lines.push(
    // The bare-global spelling, because that is the one that is shortest and
    // the one a model writes unprompted. `require` works too, but naming it
    // first made the description read as though the import were required.
    "- Files: fs.readFileSync(path, 'utf8'), fs.writeFileSync(path, text), fs.readdirSync(dir), fs.existsSync(path) — already in scope, no import. Also path, os, util, and require() for the same four.",
  );

  return lines.join("\n");
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
