/**
 * Expression rendering: the part of the generator that turns spec data into
 * TypeScript source text.
 *
 * Everything here is pure string building, and deliberately so — the emitters
 * compose these helpers, the CLI runs the result through prettier, and nothing
 * in between touches the filesystem. That is what makes `--check` able to
 * compare a regenerated file byte-for-byte with the one on disk.
 */

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** `{ a: 1 }` where the key allows it, `{ "Notion-Version": 1 }` where it does not. */
export function quoteKey(key) {
  return IDENT.test(key) ? key : JSON.stringify(key);
}

export function lit(value) {
  return JSON.stringify(value);
}

export function pascal(name) {
  return name.replace(/(^|[-_])([a-z0-9])/g, (_match, _sep, char) => char.toUpperCase());
}

/** Escapes spec text for a TypeScript template literal (GraphQL documents). */
export function template(text) {
  return `\`${text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}\``;
}

/**
 * Renders a spec value as a TypeScript expression.
 *
 * - `"$field"` becomes the input binding `field`, and records the use so the
 *   handler destructures exactly the fields it needs and no more.
 * - `"$$text"` is the escape for a literal string that starts with `$`.
 * - `{ raw: "expr" }` is passed through verbatim: the escape hatch for the one
 *   value a declarative spec cannot express.
 */
export function renderValue(value, inputs, used, where) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => renderValue(item, inputs, used, where)).join(", ")}]`;
  }
  if (typeof value === "object") {
    if ("raw" in value) {
      // `uses` declares which inputs the expression reads, because the
      // generator cannot see inside it — and an input nothing references is
      // an error, not a warning.
      for (const name of value.uses ?? []) {
        if (!inputs.has(name)) {
          throw new Error(`${where}: raw value declares uses: "${name}", not an input field.`);
        }
        used.add(name);
      }
      return String(value.raw);
    }
    const entries = Object.entries(value).map(([key, inner]) => {
      const rendered = renderValue(inner, inputs, used, where);
      // `{ title }` rather than `{ title: title }` when the binding already
      // carries the name the upstream field has.
      return rendered === key ? key : `${quoteKey(key)}: ${rendered}`;
    });
    return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
  }
  if (typeof value === "string") {
    if (value.startsWith("$$")) return lit(value.slice(1));
    if (value.startsWith("$")) {
      const name = value.slice(1);
      if (!inputs.has(name)) {
        throw new Error(`${where}: "$${name}" is not an input field of this action.`);
      }
      used.add(name);
      return name;
    }
    return lit(value);
  }
  return String(value);
}

/**
 * The same walk, evaluated against concrete arguments instead of rendered.
 *
 * The generated tests assert the request body an action actually sends, and
 * this is how the expected body is computed: from the sample arguments in the
 * spec, by the same rules the handler will follow. A `{ raw }` value is not
 * evaluable, so the body assertion is dropped rather than guessed at.
 */
export function evalValue(value, args) {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return { known: true, value };
  }
  if (Array.isArray(value)) {
    const items = [];
    for (const item of value) {
      const resolved = evalValue(item, args);
      if (!resolved.known) return { known: false };
      items.push(resolved.value);
    }
    return { known: true, value: items };
  }
  if (typeof value === "object") {
    if ("raw" in value) return { known: false };
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      const resolved = evalValue(inner, args);
      if (!resolved.known) return { known: false };
      if (resolved.value !== undefined) out[key] = resolved.value;
    }
    return { known: true, value: out };
  }
  if (value.startsWith("$$")) return { known: true, value: value.slice(1) };
  if (value.startsWith("$")) return { known: true, value: args[value.slice(1)] };
  return { known: true, value };
}

// --- input schemas ----------------------------------------------------------

/** One input field as a Zod expression. */
function renderField(name, field, where) {
  let expr;
  switch (field.type) {
    case "string":
      expr = "z.string()";
      if (field.min !== undefined) expr += `.min(${field.min})`;
      if (field.max !== undefined) expr += `.max(${field.max})`;
      break;
    case "int":
      expr = "z.number().int()";
      if (field.min !== undefined) expr += `.min(${field.min})`;
      if (field.max !== undefined) expr += `.max(${field.max})`;
      break;
    case "number":
      expr = "z.number()";
      break;
    case "boolean":
      expr = "z.boolean()";
      break;
    case "enum":
      expr = `z.enum([${field.values.map((value) => lit(value)).join(", ")}])`;
      break;
    case "string[]":
      expr = "z.array(z.string())";
      break;
    case "json":
      expr = "z.unknown()";
      break;
    default:
      throw new Error(`${where}: input "${name}" has unknown type "${field.type}".`);
  }
  if (field.describe) expr += `.describe(${lit(field.describe)})`;
  if (field.optional || field.default !== undefined) expr += ".optional()";
  return expr;
}

export function renderInputSchema(fields, where) {
  const entries = Object.entries(fields);
  if (entries.length === 0) return "z.object({})";
  const lines = entries.map(
    ([name, field]) => `${quoteKey(name)}: ${renderField(name, field, where)},`,
  );
  return `z.object({\n${lines.join("\n")}\n})`;
}

// --- output schemas ---------------------------------------------------------

const LEAF_SCHEMA = {
  string: "z.string()",
  number: "z.number()",
  boolean: "z.boolean()",
  json: "z.unknown()",
};

export function renderOutputSchema(shape, where) {
  if (shape.raw) return String(shape.raw);
  let expr;
  if (shape.type === "object") {
    const lines = Object.entries(shape.fields).map(
      ([key, field]) => `${quoteKey(key)}: ${renderOutputSchema(field, where)},`,
    );
    expr = lines.length === 0 ? "z.object({})" : `z.object({\n${lines.join("\n")}\n})`;
  } else if (shape.type === "array") {
    expr = `z.array(${renderOutputSchema(shape.item, where)})`;
  } else {
    expr = LEAF_SCHEMA[shape.type];
    if (!expr) throw new Error(`${where}: output has unknown type "${shape.type}".`);
  }
  if (shape.describe) expr += `.describe(${lit(shape.describe)})`;
  if (shape.optional) expr += ".optional()";
  return expr;
}

// --- response mapping -------------------------------------------------------

const COERCE = { string: "str", number: "num", boolean: "bool", json: null };

function join(prefix, from) {
  if (!from) return prefix;
  return prefix ? `${prefix}.${from}` : from;
}

function read(base, path) {
  return path ? `at(${base}, ${lit(path)})` : base;
}

/**
 * Renders the expression that turns a parsed response body into the action's
 * declared output.
 *
 * `scope` collects the `const` lines an optional field needs — a field that
 * may be absent is read once into a local, so the generated code can drop the
 * key entirely rather than send `undefined` through a schema that was told the
 * property is optional. An array starts a new scope because its `.map()`
 * callback is a new function body.
 *
 * A leaf's source path defaults to its own key, so a field that is simply
 * `{ type: "string" }` reads the field of the same name. `from` overrides it,
 * and an object or array applies its own `from` as a prefix for everything
 * underneath, which is what keeps a deep response shape to one line of spec.
 */
export function renderMapping(shape, base, path, state, scope, where, depth = 0, hint = "items") {
  if (shape.type === "object") {
    const here = join(path, shape.from ?? "");
    const parts = [];
    for (const [key, field] of Object.entries(shape.fields)) {
      const nested = field.type === "object" || field.type === "array";
      if (field.optional) {
        if (nested) {
          throw new Error(
            `${where}: only leaf fields may be optional ("${key}" is ${field.type}). ` +
              `Give the action a raw handler if the upstream shape needs it.`,
          );
        }
        const name = scope.name(key);
        scope.consts.push(`const ${name} = ${read(base, join(here, field.from ?? key))};`);
        const coerce = COERCE[field.type];
        const value = coerce ? `${use(state, coerce)}(${name})` : name;
        parts.push(
          `...(${name} === undefined || ${name} === null ? {} : { ${quoteKey(key)}: ${value} })`,
        );
        continue;
      }
      // A nested object or array applies its own `from`, so it is given the
      // prefix and its key as the default — `{ available: { type: "array" } }`
      // reads `available` without having to say so twice. `from: ""` is how a
      // group that shares its parent's path opts out.
      const child = nested && field.from === undefined ? { ...field, from: key } : field;
      const childPath = nested ? here : join(here, field.from ?? key);
      parts.push(
        `${quoteKey(key)}: ${renderMapping(child, base, childPath, state, scope, where, depth, key)}`,
      );
    }
    if (parts.length === 0) return "{}";
    // `{ ...(cond ? {} : { x }) }` is a spread into a fresh object and nothing
    // else, which oxlint rejects as redundant — and it is: the conditional
    // already evaluates to the object we want.
    if (parts.length === 1 && parts[0].startsWith("...")) return parts[0].slice(3);
    return `{ ${parts.join(", ")} }`;
  }

  if (shape.type === "array") {
    const here = join(path, shape.from ?? "");
    const binding = depth === 0 ? "item" : `item${depth}`;
    const inner = { consts: [], name: nameFactory() };
    // A leaf item reads its own `from` off each element — `{ type: "string",
    // from: "name" }` over a list of objects. An object or array item applies
    // its `from` itself, so it starts from the element.
    const itemNested = shape.item.type === "object" || shape.item.type === "array";
    const itemPath = itemNested ? "" : (shape.item.from ?? "");
    const body = renderMapping(shape.item, binding, itemPath, state, inner, where, depth + 1, hint);
    const source = `${use(state, "list")}(${read(base, here)})`;
    if (inner.consts.length === 0) {
      // An object literal body needs parentheses, or it reads as a block.
      const concise = body.startsWith("{") ? `(${body})` : body;
      return `${source}.map((${binding}) => ${concise})`;
    }
    // An item with optional fields reads them into locals first, and a spread
    // inside a `map` callback is what oxlint's no-map-spread rule rejects — so
    // the list is built by a loop hoisted into the enclosing scope instead.
    const name = scope.name(hint, "mapped");
    scope.consts.push(
      `const ${name} = [];`,
      `for (const ${binding} of ${source}) {`,
      ...inner.consts,
      `${name}.push(${body});`,
      `}`,
    );
    return name;
  }

  const coerce = COERCE[shape.type];
  const value = read(base, path);
  return coerce ? `${use(state, coerce)}(${value})` : value;
}

function use(state, helper) {
  state.helpers.add(helper);
  if (helper !== "at") state.helpers.add("at");
  return helper;
}

/** Unique `const` names inside one scope, derived from the output key. */
export function nameFactory() {
  const taken = new Set();
  return (key, prefix = "raw") => {
    const base = `${prefix}${pascal(key)}`;
    let name = base;
    let n = 2;
    while (taken.has(name)) name = `${base}${n++}`;
    taken.add(name);
    return name;
  };
}

/** The helper functions the mapping code above compiles against. */
export const HELPERS = {
  at: `/**
 * Reads a dotted path out of a parsed JSON body. Numeric segments index into
 * arrays, so "results.0.title" works. A missing step yields undefined rather
 * than throwing: a field the upstream omitted is normal, not exceptional.
 */
function at(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const key of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}`,
  str: `function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}`,
  num: `function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}`,
  bool: `function bool(value: unknown): boolean {
  return value === true || value === "true";
}`,
  list: `function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}`,
};
