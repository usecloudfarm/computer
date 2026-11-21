import type { z } from "zod";
import type { App, ActionContext, ActionDefinition } from "./ports.js";
import type { SideEffects } from "./schemas.js";

/**
 * Authoring an app.
 *
 * `createApp` exists for one reason: in a hand-written `ActionDefinition`
 * the handler's `input` is `unknown`, so every handler opens with a cast that
 * restates the Zod schema sitting three lines above it. The cast is unchecked —
 * widen the schema and it keeps compiling while the handler reads a field that
 * is no longer there.
 *
 * `createAction()` closes that: `I` is inferred from `input`, so the handler is
 * typed and its return value is checked against `output`. The helper per
 * action is not stylistic. A bare record constraint
 * (`Record<string, Spec<any, any>>`) makes TypeScript give up and type the
 * handler parameter `any`, which compiles `input.nope.totally.made.up` without
 * a word of complaint — verified, not assumed.
 *
 * @example
 * export const reports = createApp({
 *   id: "reports",
 *   description: "Publishes finished reports to the team.",
 *   actions: {
 *     publish: createAction({
 *       summary: "Publish a report so the team can read it.",
 *       useCases: ["publish a report", "share results"],
 *       sideEffects: "write",
 *       input: z.object({ title: z.string(), body: z.string() }),
 *       output: z.object({ url: z.string() }),
 *       example: '{ title: "Q4", body: "# Q4" }',
 *       handler: async (input) => ({ url: publish(input.title) }),
 *     }),
 *   },
 * });
 */

/** An action minus its name, which the record key supplies. */
export interface ActionSpec<I, O> {
  /** Imperative, one line: "Post a message to a channel or DM." */
  readonly summary: string;
  /** Phrases this action answers. The primary ranking signal for search(). */
  readonly useCases: readonly string[];
  readonly keywords?: readonly string[];
  readonly input: z.ZodType<I>;
  readonly output: z.ZodType<O>;
  /**
   * Prompt text, shown in search results and as JSDoc on the generated types.
   *
   * Write just the input literal — `{ channel: "#general", text: "hi" }` — and
   * the `run("app.name", …)` wrapper is added for you, so the ref can never
   * drift from the action it documents. A full `run(…)` line is taken
   * verbatim if you need something the wrapper cannot express.
   */
  readonly example: string;
  readonly sideEffects: SideEffects;
  handler(input: I, context: ActionContext): Promise<O> | O;
}

declare const ACTION: unique symbol;

/**
 * An action that has been through `createAction()`.
 *
 * The brand is what `createApp` constrains on. Constraining on the generic
 * shape instead would need `ActionSpec<any, any>`, which both defeats the
 * inference this file exists for and re-opens the `any` hole; branding checks
 * nothing but provenance, so variance never enters into it. The practical
 * effect is that a bare object literal is rejected — and a bare object literal
 * is precisely the unsafe spelling.
 */
export type DefinedAction<I = unknown, O = unknown> = ActionSpec<I, O> & {
  readonly [ACTION]: true;
};

/**
 * Identity at runtime; it exists so TypeScript infers `I` from `input` and
 * checks the handler's return against `output`.
 */
export function createAction<I, O>(spec: ActionSpec<I, O>): DefinedAction<I, O> {
  return spec as DefinedAction<I, O>;
}

export interface AppDefinition<C> {
  /** Lowercase; it is the first half of every ref this app contributes. */
  readonly id: string;
  /** Human-facing name. Defaults to the id. */
  readonly name?: string;
  /** Prompt text. The model reads this to decide whether the app is relevant. */
  readonly description: string;
  /**
   * Hosts this app may call. A prompt-injected URL argument cannot redirect a
   * credentialed request off this list. Required once `authorize` is given:
   * applying a credential with no allowlist is how a token leaks.
   */
  readonly allowedHosts?: readonly string[];
  /**
   * Applies the app's credential. Called per request, so the token stays in
   * this closure and never reaches a handler, a result, or code mode.
   */
  readonly authorize?: (request: Request) => Request;
  readonly actions: C;
}

/** Brand-only, so the constraint checks provenance rather than variance. */
type Branded = { readonly [ACTION]: true };

/**
 * How createApp reads a spec once the generics have done their work. The
 * handler takes `unknown` here: it was already checked at the createAction()
 * call, and the registry hands it a value parsed by `input`.
 */
interface SpecView {
  readonly summary: string;
  readonly useCases: readonly string[];
  readonly keywords?: readonly string[];
  readonly input: z.ZodType<unknown>;
  readonly output: z.ZodType<unknown>;
  readonly example: string;
  readonly sideEffects: SideEffects;
  handler(input: unknown, context: ActionContext): Promise<unknown> | unknown;
}

const APP_ID = /^[a-z][a-z0-9_-]*$/;
const MEMBER = /^[a-z][a-zA-Z0-9]*$/;

/**
 * Build an `App` from a record of actions keyed by member name.
 *
 * Authoring mistakes throw here, at construction, rather than surfacing as a
 * missing search hit or an unparseable ref once an agent is already running.
 */
export function createApp(definition: AppDefinition<Record<string, Branded>>): App {
  const { id, description } = definition;
  if (!APP_ID.test(id)) {
    throw new Error(
      `App id "${id}" must be lowercase and start with a letter: it is the first half of every ref, as in "${id}.doSomething".`,
    );
  }
  if (!description.trim()) {
    throw new Error(`App "${id}" needs a description: the model reads it to decide relevance.`);
  }
  if (definition.authorize && (definition.allowedHosts?.length ?? 0) === 0) {
    throw new Error(
      `App "${id}" applies a credential but allows no hosts. List the hosts it may call, or drop authorize().`,
    );
  }

  const entries = Object.entries(definition.actions) as unknown as [string, SpecView][];
  if (entries.length === 0) throw new Error(`App "${id}" defines no actions.`);

  const definitions = entries.map(([name, spec]) => toDefinition(id, name, spec));

  return {
    id,
    name: definition.name ?? id,
    description,
    allowedHosts: definition.allowedHosts ?? [],
    authorize: definition.authorize ?? ((request) => request),
    actions: () => definitions,
  };
}

function toDefinition(appId: string, name: string, spec: SpecView): ActionDefinition {
  const ref = `${appId}.${name}`;
  if (!MEMBER.test(name)) {
    throw new Error(
      `Action name "${name}" on app "${appId}" must be a camelCase identifier: it is written as run("${ref}", …) and as a TypeScript member.`,
    );
  }
  if (!spec.summary.trim()) throw new Error(`Action "${ref}" needs a summary.`);
  if (spec.useCases.length === 0) {
    throw new Error(
      `Action "${ref}" needs at least one useCase: they are the primary ranking signal, so without one it is unreachable by search().`,
    );
  }

  return {
    name,
    summary: spec.summary,
    useCases: spec.useCases,
    ...(spec.keywords ? { keywords: spec.keywords } : {}),
    input: spec.input,
    output: spec.output,
    example: toExample(ref, spec.example),
    sideEffects: spec.sideEffects,
    // A spec handler may be sync; ActionDefinition's is always async.
    handler: async (input, context) => spec.handler(input, context),
  };
}

/**
 * An input literal becomes a full call; anything else is taken verbatim.
 *
 * Keyed on the literal rather than on a leading `run(`, because an example may
 * legitimately open with something else — `const summary = run(…)` — and a
 * prefix test would wrap that into nonsense.
 */
function toExample(ref: string, example: string): string {
  const trimmed = example.trim();
  if (!trimmed) throw new Error(`Action "${ref}" needs an example: it is prompt text.`);
  const isInputLiteral = trimmed.startsWith("{") || trimmed.startsWith("[");
  return isInputLiteral ? `run("${ref}", ${trimmed})` : trimmed;
}
