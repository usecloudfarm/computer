import { describe, expect, it } from "vitest";
import { z } from "zod";
import { renderDeclarations, renderSignature, renderType, toJsonSchema } from "./typegen.js";
import type { ActionDefinition } from "./ports.js";

const sendMessage: ActionDefinition = {
  name: "sendMessage",
  summary: "Post a message to a channel or DM.",
  useCases: ["send a message"],
  input: z.object({
    channel: z.string().describe("Channel name or id."),
    text: z.string(),
    threadTs: z.string().optional(),
  }),
  output: z.object({ ts: z.string() }),
  example: 'slack.sendMessage({ channel: "#general", text: "hi" })',
  sideEffects: "write",
  handler: async () => ({}),
};

describe("renderType", () => {
  it("renders objects with optionality and doc comments", () => {
    const rendered = renderType(toJsonSchema(sendMessage.input));

    expect(rendered).toContain("/** Channel name or id. */");
    expect(rendered).toContain("channel: string;");
    expect(rendered).toContain("threadTs?: string;");
  });

  it.each([
    [z.string(), "string"],
    [z.number(), "number"],
    [z.boolean(), "boolean"],
    [z.array(z.string()), "string[]"],
    [z.enum(["a", "b"]), '"a" | "b"'],
  ])("renders primitives", (schema, expected) => {
    expect(renderType(toJsonSchema(schema))).toBe(expected);
  });

  it("renders a union", () => {
    expect(renderType(toJsonSchema(z.union([z.string(), z.number()])))).toBe("string | number");
  });

  it("renders nested objects", () => {
    const schema = z.object({ user: z.object({ id: z.string(), admin: z.boolean() }) });
    const rendered = renderType(toJsonSchema(schema));

    expect(rendered).toContain("user: {");
    expect(rendered).toContain("admin: boolean;");
  });

  it("drops the $schema key that would confuse a model", () => {
    expect(toJsonSchema(z.object({}))["$schema"]).toBeUndefined();
  });
});

describe("renderSignature", () => {
  it("renders a one-line signature with no Promise, because calls are synchronous", () => {
    const signature = renderSignature(sendMessage);

    expect(signature).toMatch(/^sendMessage\(input: \{.*\}\): \{.*\}$/);
    expect(signature).not.toContain("Promise");
    expect(signature).not.toContain("\n");
  });
});

describe("renderDeclarations", () => {
  const entry = {
    ref: "slack.sendMessage",
    appId: "slack",
    appName: "Slack",
    appDescription: "Team messaging.",
    action: sendMessage,
    authenticated: true,
  };

  it("emits a run() overload per action, keyed by ref", () => {
    const declarations = renderDeclarations([entry]);

    expect(declarations).toContain('declare function run(ref: "slack.sendMessage", input: {');
    expect(declarations).toContain("channel: string;");
  });

  it("carries the summary, side effects and example as JSDoc", () => {
    const declarations = renderDeclarations([entry]);

    expect(declarations).toContain("Post a message to a channel or DM. (Slack)");
    expect(declarations).toContain("@sideEffects write");
    expect(declarations).toContain("@example slack.sendMessage");
  });

  it("tells the model that calls are synchronous", () => {
    expect(renderDeclarations([entry])).toContain("no `await`");
  });

  it("flags actions that still need credentials", () => {
    expect(renderDeclarations([{ ...entry, authenticated: false }])).toContain(
      "@auth needs credentials",
    );
  });

  it("declares the ref it was given rather than rebuilding one", () => {
    // A built-in's app is "computer" while its ref is `bash` or
    // `memory.remember`. Rebuilding from appId + name declared
    // `computer.bash` to the one reader who cannot check it.
    const builtin = {
      ref: "memory.remember",
      appId: "computer",
      appName: "Computer",
      appDescription: "The workspace itself.",
      action: sendMessage,
      authenticated: true,
    };

    const declarations = renderDeclarations([builtin]);

    expect(declarations).toContain('run(ref: "memory.remember"');
    expect(declarations).not.toContain("computer.sendMessage");
  });

  it("orders overloads stably by ref", () => {
    const other = {
      ...entry,
      ref: "gmail.sendMessage",
      appId: "gmail",
      appName: "Gmail",
      appDescription: "Email.",
    };
    const declarations = renderDeclarations([entry, other]);

    expect(declarations.indexOf('"gmail.sendMessage"')).toBeLessThan(
      declarations.indexOf('"slack.sendMessage"'),
    );
  });
});

describe("constraints the type cannot express", () => {
  it("puts a numeric range and its default in the doc comment", () => {
    const rendered = renderType(
      toJsonSchema(z.object({ limit: z.number().int().min(1).max(30).default(10) })),
    );

    // The bug this exists for: a script asked for `limit: 50` against a
    // `max(30)` and failed five times, because `limit?: number` said nothing
    // about the bound. A validator enforcing a rule the caller cannot see is
    // a trap.
    expect(rendered).toContain("1 to 30. Defaults to 10.");
  });

  it("keeps the description and adds the bound to it", () => {
    const rendered = renderType(
      toJsonSchema(z.object({ size: z.number().max(5).describe("How many.") })),
    );

    expect(rendered).toContain("/** How many. At most 5. */");
  });

  it("says nothing about a bound that only means positive", () => {
    const rendered = renderType(toJsonSchema(z.object({ id: z.number().int().positive() })));

    // `.positive()` and the implicit MAX_SAFE_INTEGER ceiling are on every id
    // in every signature and constrain nothing a model would try.
    expect(rendered).not.toContain("At least");
    expect(rendered).not.toContain("At most");
    expect(rendered.replace(/\s+/g, " ")).toContain("id: number");
  });

  it("carries string length and format", () => {
    const rendered = renderType(
      toJsonSchema(z.object({ name: z.string().min(2).max(40), site: z.url().optional() })),
    );

    expect(rendered).toContain("2 to 40 characters.");
    expect(rendered).toContain("Format: uri.");
  });
});
