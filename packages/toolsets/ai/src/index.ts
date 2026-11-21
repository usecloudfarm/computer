import { jsonSchema } from "ai";
import type { Tool, ToolSet } from "ai";
import type { Invoke, Toolset } from "@cloudfarm/core";
import type { ToolSpec } from "@cloudfarm/core";

/**
 * `ai` is a peer dependency. The SDK's `tool()` helper is inference-only and
 * is not needed, but `jsonSchema()` is not: it brands a raw JSON Schema so the
 * SDK will validate against it, and a bare object is rejected.
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
      tools[spec.name] = {
        type: "function",
        description: spec.description,
        // Capability schemas are Zod on our side and JSON Schema by the time
        // they reach a tool spec; jsonSchema() is what makes the SDK accept one.
        inputSchema: jsonSchema(spec.inputSchema),
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
