import { z } from "zod";
import type { CapabilityDefinition } from "./ports.js";

/**
 * Zod schemas rendered as TypeScript, for the model to read.
 *
 * A generated `.d.ts` beats a prose signature list: models are trained on it,
 * and it carries optionality, unions and nesting unambiguously — exactly where
 * a prose description leaves a model guessing. The same artefact could later be
 * fed to a real typechecker to validate generated code before running it.
 */

export type JsonSchema = Record<string, unknown>;

export function toJsonSchema(schema: z.ZodType): JsonSchema {
  const generated = z.toJSONSchema(schema, { io: "input" }) as JsonSchema;
  delete generated["$schema"];
  return generated;
}

/** JSON Schema → a TypeScript type literal. Covers the subset Zod emits. */
export function renderType(schema: JsonSchema, indent = 0): string {
  const pad = "  ".repeat(indent);
  const padInner = "  ".repeat(indent + 1);

  if (Array.isArray(schema["enum"])) {
    return (schema["enum"] as unknown[]).map((value) => JSON.stringify(value)).join(" | ");
  }
  if (Array.isArray(schema["anyOf"])) {
    return (schema["anyOf"] as JsonSchema[])
      .map((member) => renderType(member, indent))
      .join(" | ");
  }
  if (Array.isArray(schema["oneOf"])) {
    return (schema["oneOf"] as JsonSchema[])
      .map((member) => renderType(member, indent))
      .join(" | ");
  }
  if (typeof schema["const"] !== "undefined") return JSON.stringify(schema["const"]);

  // Zod emits simple unions and nullables as `type: ["string", "null"]`
  // rather than anyOf, so expand that into a TypeScript union.
  if (Array.isArray(schema["type"])) {
    return (schema["type"] as string[])
      .map((type) => renderType({ ...schema, type }, indent))
      .join(" | ");
  }

  switch (schema["type"]) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `${renderType((schema["items"] as JsonSchema) ?? {}, indent)}[]`;
    case "object": {
      const properties = (schema["properties"] as Record<string, JsonSchema>) ?? {};
      const required = new Set((schema["required"] as string[]) ?? []);
      const entries = Object.entries(properties);
      if (entries.length === 0) return "Record<string, unknown>";

      const lines = entries.map(([key, value]) => {
        const docs =
          typeof value["description"] === "string"
            ? `${padInner}/** ${value["description"]} */\n`
            : "";
        const optional = required.has(key) ? "" : "?";
        return `${docs}${padInner}${key}${optional}: ${renderType(value, indent + 1)};`;
      });
      return `{\n${lines.join("\n")}\n${pad}}`;
    }
    default:
      return "unknown";
  }
}

/**
 * `sendMessage(input: { channel: string; text: string }): { ts: string }`
 *
 * Note the absence of `Promise`. Capabilities are synchronous inside code
 * mode — the isolate suspends its whole stack across a host call — and the
 * signature has to say so, or the model writes `await` and hits a syntax
 * error.
 */
export function renderSignature(capability: CapabilityDefinition): string {
  const input = renderType(toJsonSchema(capability.input)).replace(/\n\s*/g, " ");
  const output = renderType(toJsonSchema(capability.output)).replace(/\n\s*/g, " ");
  return `${capability.name}(input: ${input}): ${output}`;
}

export interface DeclarationEntry {
  readonly appId: string;
  readonly appName: string;
  readonly appDescription: string;
  readonly capability: CapabilityDefinition;
  readonly authenticated: boolean;
}

/**
 * The declarations the model writes against.
 *
 * Emitted as overloads of one `run` function rather than an object per app,
 * because that is literally how the code calls them — `run("slack.sendMessage",
 * {...})` — and an overload set gives the model the ref, the argument shape and
 * the return type in the position it will actually type them.
 */
export function renderDeclarations(entries: readonly DeclarationEntry[]): string {
  const overloads = [...entries]
    .sort(
      (a, b) =>
        a.appId.localeCompare(b.appId) || a.capability.name.localeCompare(b.capability.name),
    )
    .map((entry) => {
      const { capability } = entry;
      const ref = `${entry.appId}.${capability.name}`;
      const input = renderType(toJsonSchema(capability.input), 0);
      const output = renderType(toJsonSchema(capability.output), 0);
      const docs = [
        `/**`,
        ` * ${capability.summary} (${entry.appName})`,
        ` * @sideEffects ${capability.sideEffects}`,
        entry.authenticated ? null : ` * @auth needs credentials`,
        ` * @example ${capability.example}`,
        ` */`,
      ]
        .filter((line): line is string => line !== null)
        .join("\n");
      return `${docs}\ndeclare function run(ref: ${JSON.stringify(ref)}, input: ${input}): ${output};`;
    });

  return ["// Everything is synchronous: call run() directly, with no `await`.", ...overloads].join(
    "\n\n",
  );
}
