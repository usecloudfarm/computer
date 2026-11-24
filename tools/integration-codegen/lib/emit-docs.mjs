/**
 * Emits an app's page in the docs catalogue.
 *
 * The catalogue builds its cards from these pages, so a generated app with no
 * page is an app that exists in npm and nowhere a reader can find it. Writing
 * the page here rather than by hand is the same bargain the package itself
 * makes: the spec is the one description, and an action added to it appears in
 * the table without anyone remembering to go and add it.
 */

/** `AppDefinition.auth.kind` as the catalogue's credential badge. */
const CREDENTIAL = {
  none: "none",
  apiKey: "api-key",
  basic: "basic",
};

/** Two letters for the card, used only if the icon ever fails to load. */
function mark(name) {
  const words = name.split(/[\s-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2);
  return letters[0].toUpperCase() + (letters[1] ?? "").toLowerCase();
}

/** The factory call a reader copies, with every required option present. */
function connectCall(spec) {
  const args = [];
  if (spec.auth.kind === "apiKey") args.push(`apiKey: process.env.${envName(spec)}`);
  if (spec.auth.kind === "basic") {
    args.push(`username: process.env.${envName(spec, "EMAIL")}`);
    args.push(`password: process.env.${envName(spec, "TOKEN")}`);
  }
  for (const [name, option] of Object.entries(spec.options)) {
    args.push(`${name}: ${JSON.stringify(option.sample ?? "…")}`);
  }
  const inner = args.length > 0 ? `{\n      ${args.join(",\n      ")},\n    }` : "{}";
  return `${spec.constName}(${inner})`;
}

function envName(spec, suffix = "API_KEY") {
  return `${spec.id.toUpperCase().replace(/-/g, "_")}_${suffix}`;
}

function optionRows(spec) {
  const rows = [];
  if (spec.auth.kind === "apiKey") {
    rows.push(["`apiKey`", "`string`", `Required. ${spec.auth.describe ?? "The app's API key."}`]);
  }
  if (spec.auth.kind === "basic") {
    rows.push(["`username`", "`string`", "Required."]);
    rows.push(["`password`", "`string`", "Required."]);
  }
  for (const [name, option] of Object.entries(spec.options)) {
    rows.push([`\`${name}\``, "`string`", `Required. ${option.describe ?? ""}`.trim()]);
  }
  return rows;
}

function table(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

export function emitDocsPage(spec) {
  const actionRows = spec.actions.map((action) => [
    `\`${spec.id}.${action.name}\``,
    action.summary.replace(/\.$/, ""),
    action.sideEffects === "read" ? "no" : "yes",
  ]);

  // Two calls, not one: a reader scanning for the shape of a call learns more
  // from a read and a write than from two reads.
  const write = spec.actions.find((action) => action.sideEffects !== "read");
  const read = spec.actions.find((action) => action.sideEffects === "read");
  const examples = [read, write]
    .filter(Boolean)
    .map((action) => `run({ ref: "${spec.id}.${action.name}", args: ${exampleArgs(action)} });`);

  const parts = [
    "---",
    `title: ${spec.name}`,
    `description: ${spec.description}`,
    "app:",
    `  package: "${spec.packageName}"`,
    `  icon: "${spec.icon}"`,
    `  credential: ${CREDENTIAL[spec.auth.kind]}`,
    `  mark: ${mark(spec.name)}`,
    "---",
    "",
    "## Install",
    "",
    "```bash",
    `pnpm add ${spec.packageName}`,
    "```",
    "",
    "## Connect",
    "",
    "```ts",
    `import { ${spec.constName} } from "${spec.packageName}";`,
    "",
    "const computer = new Computer({",
    `  apps: [${connectCall(spec)}],`,
    "});",
    "```",
    "",
    spec.credentials,
    "",
    table(["Option", "Type", "Notes"], optionRows(spec)),
    "",
    // `{site}` is the spec's interpolation syntax; `<site>` is what a reader
    // understands as "your value here".
    `Requests may only reach ${spec.allowedHosts
      .map((host) => `\`${host.replace(/\{(\w+)\}/g, "<$1>")}\``)
      .join(" and ")}.`,
    "",
    "## What the agent can do",
    "",
    table(["Action", "Does", "Writes"], actionRows),
    "",
    "```ts",
    ...examples,
    "```",
  ];

  if (spec.notes?.length) {
    parts.push("", "## Notes", "", spec.notes.join("\n"));
  }
  parts.push("", `Upstream API docs: <${spec.docsUrl}>`, "");
  return parts.join("\n");
}

/** The example input literal, rebuilt from the action's declared inputs. */
function exampleArgs(action) {
  const fields = Object.entries(action.input ?? {})
    .filter(([, field]) => !field.optional)
    .map(([name, field]) => `${name}: ${sample(field)}`);
  return fields.length > 0 ? `{ ${fields.join(", ")} }` : "{}";
}

function sample(field) {
  if (field.sample !== undefined) return JSON.stringify(field.sample);
  if (field.values?.length) return JSON.stringify(field.values[0]);
  if (field.type === "int" || field.type === "number") return String(field.min ?? 1);
  if (field.type === "boolean") return "true";
  return '"…"';
}
