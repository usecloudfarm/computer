import type { Invoke, Toolset } from "@cloudfarm/core";
import type { ToolSpec } from "@cloudfarm/core";

/**
 * An AI SDK tool, structurally.
 *
 * Declared here rather than imported from `ai` on purpose: the SDK's `tool()`
 * helper has no runtime behaviour — it exists for type inference — so a plain
 * object of this shape is a valid tool. That keeps `ai` out of this package's
 * dependencies entirely, which matters because v7 is ESM-only and moves fast.
 */
export interface AISDKTool {
  description: string;
  inputSchema: { jsonSchema: Record<string, unknown> } | Record<string, unknown>;
  execute: (input: unknown) => Promise<unknown>;
}

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
export class AISDKToolset implements Toolset<Record<string, AISDKTool>> {
  readonly #options: AISDKToolsetOptions;

  constructor(options: AISDKToolsetOptions = {}) {
    this.#options = options;
  }

  materialize(specs: readonly ToolSpec[], invoke: Invoke): Record<string, AISDKTool> {
    const limit = this.#options.maxOutputChars ?? 24_000;
    const only = this.#options.only;
    const tools: Record<string, AISDKTool> = {};

    for (const spec of specs) {
      if (only && !only.includes(spec.name)) continue;
      tools[spec.name] = {
        description: spec.description,
        // The AI SDK accepts a JSON Schema wrapped in `{ jsonSchema }`, which
        // is what its own `jsonSchema()` helper produces.
        inputSchema: { jsonSchema: spec.inputSchema },
        execute: async (input: unknown) => {
          try {
            const result = await invoke(spec.ref, (input ?? {}) as never);
            return clamp(result, limit);
          } catch (error) {
            // A thrown tool error ends the agent loop; a returned one lets the
            // model read what went wrong and try something else.
            return {
              error: error instanceof Error ? error.message : String(error),
              ref: spec.ref,
            };
          }
        },
      };
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
