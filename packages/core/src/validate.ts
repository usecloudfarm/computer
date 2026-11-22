import { UnknownRefError } from "./errors.js";
import type { ActionRegistry } from "./registry.js";
import type { Diagnostic } from "./schemas.js";

/**
 * Checks generated code before any of it runs.
 *
 * The value here is not safety — the isolate already handles that — it is the
 * agent's loop. A script that calls `run("slack.sendMesage", …)` on its third
 * line would otherwise send two real messages before failing on a typo, and
 * the model would have to reason about partially-applied side effects. Catching
 * it up front turns a messy half-run into one clear message it can act on.
 *
 * Static analysis only sees literal refs. A computed one (`run(name, args)`)
 * cannot be checked here and still fails at call time, which is why the bridge
 * keeps its own validation.
 */
export interface ValidationInput {
  readonly source: string;
  readonly registry: ActionRegistry;
  /** Built-in refs that are not in the registry: `bash`, `fs.read`, … */
  readonly builtins: ReadonlySet<string>;
  /** From the engine's capabilities. Defaults to false, the isolate's rule. */
  readonly allowAwait?: boolean;
  /** Likewise: whether the guest has a real `require` to call. */
  readonly allowModules?: boolean;
}

/** Matches `run("ref"` / `run('ref'` with a literal first argument. */
const RUN_CALL = /\brun\s*\(\s*(["'])([^"']+)\1/g;

const REQUIRE = {
  pattern: /\brequire\s*\(/,
  message: "`require` is not available in code mode.",
  hint: "Every action is already in scope through `run`.",
};

const AWAIT = {
  pattern: /\bawait\b/,
  message: "`await` is not available: everything in code mode is synchronous.",
  hint: 'Call directly: `const result = run("slack.sendMessage", { ... })`.',
};

const FORBIDDEN: ReadonlyArray<{
  pattern: RegExp;
  message: string;
  hint: string;
}> = [
  {
    pattern: /\b(?:import|export)\s/,
    message: "Modules are not available in code mode.",
    hint: "Every action is already in scope through `run`.",
  },
  {
    pattern: /\bfetch\s*\(/,
    message: "There is no network access in code mode.",
    hint: 'Use an action, or `run("bash", { cmd })` if a sandbox is configured.',
  },
];

/** Diagnostics that can be found without parsing. Cheap, and runs everywhere. */
export function validateSource(input: ValidationInput): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = input.source.split("\n");

  const rules = [
    ...(input.allowAwait ? [] : [AWAIT]),
    ...(input.allowModules ? [] : [REQUIRE]),
    ...FORBIDDEN,
  ];
  for (const { pattern, message, hint } of rules) {
    const index = lines.findIndex((line) => pattern.test(stripStrings(line)));
    if (index >= 0) {
      diagnostics.push({ code: "forbidden_construct", message, hint, line: index + 1 });
    }
  }

  const seen = new Set<string>();
  for (const [lineIndex, line] of lines.entries()) {
    RUN_CALL.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = RUN_CALL.exec(line)) !== null) {
      const ref = match[2]!;
      if (seen.has(ref)) continue;
      seen.add(ref);
      if (input.builtins.has(ref) || input.registry.has(ref)) continue;

      // Reuse the dispatcher's own suggestion logic, so a typo gets the same
      // "did you mean" the runtime would have produced.
      let hint: string | undefined;
      try {
        input.registry.get(ref);
      } catch (error) {
        if (error instanceof UnknownRefError && error.suggestions.length > 0) {
          hint = `Did you mean: ${error.suggestions.join(", ")}?`;
        }
      }
      diagnostics.push({
        code: "unknown_ref",
        message: `No action named "${ref}".`,
        ref,
        line: lineIndex + 1,
        ...(hint !== undefined ? { hint } : { hint: "Use `search` to find the right ref." }),
      });
    }
  }

  return diagnostics;
}

/** Keeps a `fetch(` inside a string from being read as a call. */
function stripStrings(line: string): string {
  return line
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}
