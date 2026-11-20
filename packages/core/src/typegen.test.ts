import { describe, expect, it } from "vitest";
import { z } from "zod";
import { renderDeclarations, renderSignature, renderType, toJsonSchema } from "./typegen.js";
import type { CapabilityDefinition } from "./ports.js";

const sendMessage: CapabilityDefinition = {
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
    appId: "slack",
    appName: "Slack",
    appDescription: "Team messaging.",
    capability: sendMessage,
    authenticated: true,
  };

  it("tells the model that capabilities are synchronous", () => {
    expect(renderDeclarations([entry])).toContain("without `await`");
  });

  it("emits an ambient const per app with JSDoc", () => {
    const declarations = renderDeclarations([entry]);

    expect(declarations).toContain("/** Slack — Team messaging. */");
    expect(declarations).toContain("declare const slack: {");
    expect(declarations).toContain("@example slack.sendMessage");
    expect(declarations).toContain("@sideEffects write");
  });

  it("flags capabilities that still need credentials", () => {
    expect(renderDeclarations([{ ...entry, authenticated: false }])).toContain(
      "@auth needs credentials",
    );
  });

  it("groups capabilities by app and sorts stably", () => {
    const other = { ...entry, appId: "gmail", appName: "Gmail", appDescription: "Email." };
    const declarations = renderDeclarations([entry, other]);

    expect(declarations.indexOf("declare const gmail")).toBeLessThan(
      declarations.indexOf("declare const slack"),
    );
  });
});
