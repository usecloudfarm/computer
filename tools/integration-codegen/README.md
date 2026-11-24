# integration-codegen

Generates a `packages/integrations/<id>` package from one declarative spec, so
adding an integration is a data-entry job with a known shape rather than a
fresh design exercise each time.

```sh
pnpm gen:integrations                 # every spec
pnpm gen:integrations linear stripe   # named specs
pnpm gen:integrations:check           # fail if a package has drifted from its spec
node tools/integration-codegen/generate.mjs --list
```

`pnpm check` runs the `--check` form, so a hand edit inside a generated `src/`
fails CI with the file name and the fix. The spec is the source of truth.

## Adding one

1. Copy the nearest spec in `specs/`. `linear.mjs` is the GraphQL example,
   `github.mjs` the REST one, `stripe.mjs` form-encoded writes, `jira.mjs` basic
   auth with a per-site base URL, `notion.mjs` deeply nested response bodies.
2. Fill in the app header, then one entry in `actions` per action.
3. `pnpm gen:integrations <id> && pnpm install && pnpm check`.

Three minutes of typing, and what comes out is a package with a README, a
changeset, and a test per action.

## What a spec says

```js
export default {
  id: "linear", // the first half of every ref: linear.createIssue
  name: "Linear",
  description: "…", // prompt text: the model reads this
  npmDescription: "…", // package.json
  credentials: "…", // README prose: how a developer gets a key
  docsUrl: "https://…",
  auth: { kind: "apiKey", prefix: "", describe: "…" }, // apiKey | basic | none
  baseUrl: "https://api.linear.app",
  allowedHosts: ["api.linear.app"],
  headers: { "Notion-Version": "2022-06-28" }, // sent on every request
  options: { site: { describe: "…", sample: "acme" } }, // non-credential config
  validate: { kind: "graphqlErrors" }, // 200-means-failure APIs
  notes: ["module docblock, one entry per line"],
  actions: [/* below */],
};
```

`baseUrl` and `allowedHosts` may interpolate an option — `https://{site}.atlassian.net`
— and the generator emits the function forms that core expects. An option that
decides where a credentialed request may go is deliberately not an action
argument: that value must not arrive from a model.

**OAuth is not generated.** `core`'s `oauth()` defines a credential shape but no
consent redirect and no refresh, so a generated OAuth app would look finished
and not be. That is also why the integrations here are the API-key half of a
catalogue like executor.sh's, and Gmail, Calendar and Drive are not in it.

## What an action says

```js
{
  name: "createIssue",            // the member name, and the second half of the ref
  summary: "Open an issue on a team's board.",
  useCases: ["file a bug", "create an issue"],   // the ranking signal for search()
  keywords: ["ticket"],
  sideEffects: "read" | "write" | "destructive",
  input: { title: { type: "string", min: 1, describe: "…" },
           limit: { type: "int", default: 25, optional: true } },
  request: { method: "POST", path: "repos/{repo*}/issues",
             query: { per_page: "$limit" }, body: { title: "$title" } },
  output: { type: "object", from: "data.issueCreate.issue",
            fields: { id: { type: "string" }, url: { type: "string" } } },
  args:   { title: "Login fails" },   // the test's arguments
  sample: { /* a recorded upstream response */ },
  expect: { id: "issue_1", url: "…" },  // what the mapping should produce
}
```

- **Input types** are `string`, `int`, `number`, `boolean`, `enum` (with
  `values`), `string[]`, `json`, plus `min`, `max`, `describe`, `optional` and
  `default`. A `default` is applied in the handler, so the schema stays
  optional and the upstream still receives the value.
- **`"$field"`** anywhere in `query`, `body`, `form` or GraphQL `variables` is
  that input. `"$$text"` is the escape for a literal `$text`, and
  `{ raw: "expr", uses: ["field"] }` passes TypeScript through untouched —
  `uses` names the inputs it reads, since the generator cannot see inside the
  expression and an unreferenced input is an error.
- **Paths** interpolate `{field}` percent-encoded, so an argument cannot climb
  the URL. `{field*}` is unencoded, for the APIs whose segment is itself a path
  (`owner/name`).
- **Writes** use `body` for JSON or `form` for the older urlencoded APIs; never
  both. GraphQL replaces the whole thing with
  `request: { graphql: { query, variables } }`.
- **Output** is a tree of `object`, `array` and leaf shapes. A leaf reads the
  response field of the same name; `from` overrides it with a dotted path, and
  numeric segments index arrays (`"properties.title.title.0.plain_text"`). An
  object or array applies its own `from` as a prefix for everything beneath, so
  a deep body costs one line. `from: ""` opts out — that is how an action whose
  response is a bare JSON array says so. An `optional` leaf is dropped when the
  upstream omits it rather than set to `undefined`.
- **Only leaves may be optional.** A conditional object or array means the
  response shape is genuinely irregular, and that case gets a raw handler.

### The escape hatch

`handler: "async ({ id }, context) => { … }"` replaces the generated body with
source of your own, and everything else — schemas, search metadata, the
package, the README — is still generated. Use it for the one action a
declarative mapping cannot express rather than hand-writing the whole app.

## Why `args` / `sample` / `expect` are required

They are not documentation. The generated suite replays `sample` through the
real `Computer` for every action and asserts the request that went out (method,
path, query, body) and the value that came back, plus — once per app — that the
credential was applied by the host and never by a handler, and that an upstream
404 becomes an error result rather than a thrown value. A generated integration
nobody exercised is a guess about an upstream API written in a confident tone;
requiring a recorded response is what turns the guess into a test. Two real
mapping bugs were caught this way while the first specs were being written.

## Layout

| file                 | what it does                                                   |
| -------------------- | -------------------------------------------------------------- |
| `generate.mjs`       | CLI: load, emit, prettier, write or `--check`                  |
| `lib/spec.mjs`       | validation — every mistake a spec can make, named with its fix |
| `lib/render.mjs`     | expressions: Zod schemas, request values, response mapping     |
| `lib/emit-src.mjs`   | `src/index.ts`                                                 |
| `lib/emit-test.mjs`  | `src/index.test.ts`                                            |
| `lib/emit-files.mjs` | manifest, tsconfig, tsup, vitest, README, changeset            |
| `specs/*.mjs`        | one per integration                                            |

Every emitted file goes through prettier with the repo's own config before it is
written or compared, which is what makes `--check` exact rather than advisory.
