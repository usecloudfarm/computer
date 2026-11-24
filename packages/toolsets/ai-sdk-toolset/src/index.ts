import { jsonSchema, tool, NoSuchToolError } from "ai";
import type { Tool, ToolCallRepairFunction, ToolSet } from "ai";
import type { Invoke, Toolset } from "@cloudfarm/computer";
import type { ToolSpec } from "@cloudfarm/computer";

/**
 * The AI SDK adapter.
 *
 * It imports the SDK and uses its own helpers rather than hand-rolling the
 * shapes: `tool()` for the definition and `jsonSchema()` for the schema. That
 * matters more than it looks — `jsonSchema()` brands a raw JSON Schema with
 * `Symbol.for("vercel.ai.schema")`, and the SDK refuses anything unbranded, so
 * an approximation of the shape type-checks against itself and then fails
 * against a real model.
 *
 * `ai` is a peer dependency, not a direct one: a second copy of the SDK in the
 * tree would mean two sets of its types for the same objects. (Its schema
 * brand uses a global symbol, so the runtime would survive it — the types
 * would not.)
 */
export type { Tool, ToolSet } from "ai";

export interface AISDKToolsetOptions {
  /**
   * Characters of tool output kept before truncation. Mirrors the clamping the
   * workspace already applies to command output, so a tool result cannot blow
   * up a context window on its own. Defaults to 24_000.
   */
  readonly maxOutputChars?: number;
  /** Restrict to a subset of tools by name. */
  readonly only?: readonly string[];
}

/**
 * Materialises Computer's tool specs as an AI SDK `ToolSet`.
 *
 * ```ts
 * const result = await generateText({
 *   model,
 *   tools: await workspace.tools(),
 *   prompt: "Summarise #eng and save it to /notes/eng.md",
 * });
 * ```
 */
export class AISDKToolset implements Toolset<ToolSet> {
  readonly #options: AISDKToolsetOptions;

  constructor(options: AISDKToolsetOptions = {}) {
    this.#options = options;
  }

  materialize(specs: readonly ToolSpec[], invoke: Invoke): ToolSet {
    const limit = this.#options.maxOutputChars ?? 24_000;
    const only = this.#options.only;
    const tools: Record<string, Tool> = {};

    for (const spec of specs) {
      if (only && !only.includes(spec.name)) continue;

      tools[spec.name] = tool({
        description: spec.description,
        // Action schemas are Zod on our side and JSON Schema by the time
        // they reach a tool spec; jsonSchema() is what the SDK will accept.
        inputSchema: jsonSchema(spec.inputSchema),
        execute: async (input: unknown) => {
          try {
            return clamp(await invoke(spec.ref, (input ?? {}) as never), limit);
          } catch (error) {
            // A thrown tool error ends the agent loop. Dispatch already
            // answers failures in the envelope, so reaching here means
            // something unexpected — report it in the same shape rather than
            // letting it escape.
            return {
              status: "error",
              error: {
                code: "internal",
                message: error instanceof Error ? error.message : String(error),
                retryable: false,
              },
            };
          }
        },
      });
    }
    return tools;
  }
}

function clamp(value: unknown, limit: number): unknown {
  if (typeof value === "string") {
    return value.length <= limit ? value : `${value.slice(0, limit)}\n…[truncated]`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined || serialized.length <= limit) return value;
  return { truncated: true, preview: serialized.slice(0, limit) };
}

/**
 * Turn a call to a tool that does not exist into a `run` call for that ref.
 *
 * ```ts
 * streamText({ model, tools: await workspace.tools(), repairToolCall: repairToRun() });
 * ```
 *
 * A computer's actions are refs reached through `run`, but two of them —
 * `code` and `fs` — are also tools in their own right, and a model that has
 * been handed those reasonably generalises to calling `bash` the same way.
 * The SDK rejects an undeclared tool name before anything executes, so that
 * slip costs the whole turn rather than one call.
 *
 * Rewriting it as `{ ref: <the name it used>, args: <what it passed> }` is a
 * faithful reading of the intent, and it is safe when the guess is wrong:
 * dispatch answers an unknown ref with `{ status: 'error' }` carrying a hint,
 * which the model can act on. Either way it gets a result instead of a dead
 * conversation.
 *
 * This repairs the name only. A tool whose *arguments* are malformed is a
 * different failure — the SDK raises `InvalidToolInputError` for that, and
 * guessing at a fix there would hide a real schema mismatch.
 */
export function repairToRun<TOOLS extends ToolSet>(): ToolCallRepairFunction<TOOLS> {
  return async ({ toolCall, tools, error }) => {
    if (!NoSuchToolError.isInstance(error)) return null;
    // Without `run` there is nothing to repair to, and rewriting to a tool
    // this computer does not expose would only trade one bad name for another.
    if (!("run" in tools)) return null;

    return {
      ...toolCall,
      toolName: "run",
      input: JSON.stringify({ ref: toolCall.toolName, args: parseInput(toolCall.input) }),
    };
  };
}

/**
 * The model's arguments, as an object.
 *
 * `input` is a JSON string by contract, but a repair runs on calls that were
 * already wrong once — so a malformed one goes through as empty rather than
 * throwing inside the hook and taking the turn with it.
 */
function parseInput(input: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(input);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
