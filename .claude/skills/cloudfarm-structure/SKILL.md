---
name: cloudfarm-structure
description: The layout of the cloudfarm monorepo and the conventions every package follows. Use this whenever you are adding a package, implementing a sandbox provider / app integration / code engine / toolset / storage or memory backend, wiring a new dependency, or wondering where a file belongs — and also when you are only reading the repo and need to know what lives where. Read it before creating any directory under packages/, because the folder a package sits in is what declares which interface it implements.
---

# cloudfarm monorepo structure

## The organising idea

`@cloudfarm/core` defines a handful of plugin interfaces. **Every other package
implements exactly one of them, and lives in the folder named after it.** The
path tells you the contract:

```
packages/
├── core/                    @cloudfarm/core — the Computer, and every interface below
├── sandboxes/               SandboxProvider — where bash runs
│   ├── bash/                @cloudfarm/bash-sandbox   (default: just-bash, no infrastructure)
│   └── e2b/                 @cloudfarm/e2b-sandbox    (planned)
├── integrations/            App — third-party actions
│   └── slack/               @cloudfarm/slack
├── engines/                 CodeEngine — where code mode executes
│   └── quickjs/             @cloudfarm/qjs-engine
├── toolsets/                Toolset — adapters for agent frameworks
│   └── ai/                  @cloudfarm/ai-sdk-toolset     (Vercel AI SDK)
├── storage/                 StorageProvider — where workspace files live  (empty)
└── memory/                  MemoryStore — searchable agent memory         (empty)

examples/
└── node-agent/              the brief's snippet, typechecked in CI, plus a runnable demo
```

`storage/` and `memory/` have no packages yet; create the directory when you
add the first one rather than leaving an empty placeholder.

This mapping is worth preserving because it answers "where does this go?"
without anyone having to ask. If you are about to add a package that does not
fit one of these kinds, that is a signal worth raising — either it belongs in
`core`, or there is a new interface to define first.

## Adding a package

1. **Pick the folder from the interface you implement.** A thing that runs
   shell commands is a `SandboxProvider`, so it goes in `packages/sandboxes/`.
   A thing that exposes third-party actions is an `App` → `integrations/`.
2. **Copy the nearest sibling.** `packages/sandboxes/bash-sandbox` is the best template
   for a provider; `packages/integrations/slack` for an app. Both are small and
   already have the right config.
3. **Fix the relative paths** — grouped packages sit one level deeper than
   `core`:

   | file                       | in `packages/core`         | in `packages/<kind>/<name>`   |
   | -------------------------- | -------------------------- | ----------------------------- |
   | `tsconfig.json` extends    | `../../tsconfig.base.json` | `../../../tsconfig.base.json` |
   | `vitest.config.ts` imports | `../../vitest.config.js`   | `../../../vitest.config.js`   |

   Do **not** add `references` / `composite`: they pin typecheck to built
   output. Workspace imports resolve from `src` through the
   `@cloudfarm/source` export condition instead.

4. **Name it `@cloudfarm/<name>`** — the npm name is flat even though the
   folder is nested, so `packages/integrations/slack` is `@cloudfarm/slack`.
5. `pnpm-workspace.yaml` already globs every kind directory, so a new package
   in an existing folder needs no change there. A brand-new _kind_ does.
6. Run `pnpm install` so the workspace link exists, then `pnpm build`.

## Writing an app

Most new integrations should not be hand-written at all:
`tools/integration-codegen` generates a whole package — source, tests, README,
changeset — from one declarative spec in `tools/integration-codegen/specs/`.
Copy the nearest spec, run `pnpm gen:integrations <id>`, and `pnpm check`
verifies the committed package still matches it. Read
`tools/integration-codegen/README.md` first; hand-write an app only when the
spec format genuinely cannot express it, and even then prefer a spec with a raw
`handler` for the one awkward action.

The rest of this section is what the generator emits, and what to write by hand
when you do.

Use `createApp` from core, with one `createAction()` per member:

```ts
import { createAction, createApp } from "@cloudfarm/core";

export function linear(options: { apiKey: string }) {
  return createApp({
    id: "linear",                       // first half of every ref
    description: "Issue tracking.",     // prompt text: review it as API
    allowedHosts: ["api.linear.app"],   // required when authorize() is given
    authorize: (request) => {           // the token lives in this closure only
      const authorized = new Request(request);
      authorized.headers.set("authorization", options.apiKey);
      return authorized;
    },
    actions: {
      createIssue: createAction({
        summary: "Open an issue on a team's board.",
        useCases: ["file a bug", "create an issue"],   // the ranking signal
        sideEffects: "write",
        input: z.object({ team: z.string(), title: z.string() }),
        output: z.object({ id: z.string(), url: z.string() }),
        example: '{ team: "ENG", title: "Login fails" }',
        handler: async (input, context) => {           // input is typed
          ...
        },
      }),
    },
  });
}
```

Why it is shaped this way:

- **`createAction()` is not optional sugar.** It is what infers the handler's
  `input` from the schema. Passing a bare object literal is rejected by the
  type system on purpose — with a record constraint TypeScript silently types
  the parameter `any`, so `input.nope.totally.made.up` would compile.
- **The record key is the action name**, so a ref cannot disagree with the
  member it names, and duplicates are impossible.
- **`example` is the input literal only** — `{ team: "ENG" }`. The
  `run("linear.createIssue", …)` wrapper is generated, so the ref in prompt
  text cannot drift. A full line is taken verbatim if you need one.
- **Authoring mistakes throw at construction**: a non-identifier name, an app
  with no actions, empty `useCases` (unreachable by search), or
  `authorize` without `allowedHosts` (how a token leaks).

### Credentials

Declare an auth scheme instead of hand-rolling `authorize`:

```ts
export const linear = createApp({
  id: "linear",
  description: "Issue tracking.",
  auth: apiKey({ prefix: "", describe: "A Linear personal API key." }),
  options: z.object({ baseUrl: z.string().url().optional() }),  // non-credential config
  http: ({ baseUrl }) => ({ baseUrl: baseUrl ?? "https://api.linear.app" }),
  actions: { … },
});

linear({ apiKey: "lin_api_…" });   // the factory's parameter is the scheme's input
```

**`auth` changes what `createApp` returns**: without it you get an `App`, with
it you get `(input) => App`. The integration no longer writes its own
constructor, so the dev-facing signature cannot drift from what the scheme
actually needs.

Built in: `apiKey({ header, prefix, query })`, `basic()`, `oauth({ scopes })`,
`noAuth()`. `defineAuth` builds a custom one — `input` and `credentials` are
separate schemas precisely so they can differ, as when a developer passes
`{ team, secret }` and what gets stored is a single derived token.

- The credential is **never on `ActionContext`**. Only the scheme sees it;
  handlers sign requests by using `context.http`/`context.fetch`. An app that
  closed over a string would be shorter and strictly worse.
- `app.auth` publishes the scheme's _shape_ — `kind` and both schemas, no
  values — so a credential store can later learn what to hold.
- Invalid credentials throw at construction with the fix in the message, not
  as a 401 halfway through a task.
- `oauth()` defines the credential shape and signs with the access token. **The
  flow is not implemented**: no consent redirect, no refresh. It exists now so
  the stored shape is right before anything persists it.
- `options` is separate from `auth.input` because `http` and `allowedHosts`
  receive the options and not the credentials — there is no path that bakes a
  token into a static header map.

### Talking to a service

Configure `http` on the app and use `context.http` in handlers:

```ts
createApp({
  id: "linear",
  http: {
    baseUrl: "https://api.linear.app",
    // Only for APIs that answer 200 with a failure body.
    validate: (body) => {
      if ((body as { errors?: unknown }).errors) throw new UpstreamRejectedError("…");
    },
  },
  actions: { … },
});

// in a handler:
const body = await context.http.get("issues", { query: { team, limit } });
await context.http.post("issues", { title, teamId });
```

It builds the URL, encodes JSON (or `form` for older APIs), drops `undefined`
query values, parses the response, and throws `HttpError` with the status on a
non-2xx. `baseUrl`'s host joins `allowedHosts` automatically.

**Do not hand-roll this.** The reason is not tidiness: a hand-thrown
`new Error("HTTP 429 …")` is an anonymous Error, and `classifyError` can only
call that `internal`/`retryable: false`. A rate limit then reaches the model as
a permanent fault. `HttpError` carries the status, so 429 becomes
`rate_limited` (retryable), 401/403 `not_authenticated`, 5xx a retryable
`upstream_error`, and other 4xx a non-retryable one. `context.fetch` is still
there for anything `http` cannot express — streaming, binary, odd verbs.

Hand-written `App` objects still work — `createApp` returns a plain `App` — but
new apps should use the factory.

## The default packages

`@cloudfarm/bash-sandbox` and `@cloudfarm/qjs-engine` are the defaults for `provider` and
`codeEngine`. Core cannot import them — they depend on core — so it declares
them as **optional peer dependencies** and resolves them at runtime through a
dynamic import in `packages/core/src/defaults.ts`. Installed means default;
absent means the matching tool is simply missing.

pnpm reports a cyclic workspace dependency because of those peers. It is
expected and harmless here: turbo still orders the graph, and a published
consumer resolves peers from their own tree with no cycle at all.

If you add another package that ought to be a default, follow the same shape —
never a real dependency from core.

## Conventions every package follows

**Scripts.** `build` (tsup), `dev`, `test` (vitest), `test:watch`, `lint`,
`typecheck`, `clean`. Turbo drives them from the root; `test` and `typecheck`
depend on `^build`, so a package's dependencies are built before it is checked.

**ESM only, no CJS.** Every runtime cloudfarm targets supports it, and the AI
SDK is ESM-only anyway.

**Private until v1.** Packages carry `"private": true`; changesets are written
but nothing publishes.

**Zod for data, interfaces for behaviour.** Anything that crosses a boundary —
action inputs and outputs, run results, wire frames — is a Zod schema in
`packages/core/src/schemas.ts` with its TypeScript type inferred from it. One
definition validates the model's arguments, generates the JSON Schema that tool
definitions need, and renders the TypeScript the model writes against in code
mode. Things with methods (filesystems, providers, engines) stay plain
interfaces in `packages/core/src/ports.ts`; Zod has nothing useful to say about
a method.

**Descriptions are prompt text.** Every `description` field on a provider, app
or action ships to a language model. Editing one changes behaviour for
every consumer, so treat it as API: review it like a function signature and
expect tests to assert on it.

## The isomorphism rule

`@cloudfarm/core` runs on Node **and** Cloudflare Workers, and that is enforced
mechanically rather than by discipline:

- it has no `@types/node` dependency and `"types": []` in its tsconfig, so
  `node:*` imports and `process` do not typecheck;
- oxlint bans `node:` imports and browser-only globals inside `packages/core/src`;
- `pnpm test:workers` runs core's **entire** suite inside workerd, and CI runs
  it alongside the Node suite.

That last one is the actual guarantee — the other two just fail faster. When
you need a platform API in core, don't; put it behind an interface in
`ports.ts` and implement it in a leaf package.

Leaf packages may use platform APIs, but say so in their README, because a
package that only works on Node constrains every consumer that wanted Workers.

## Verifying a change

```sh
pnpm check                                         # the gate: format, lint,
                                                   # typecheck, build, test,
                                                   # test:workers — examples too
pnpm --filter @cloudfarm/example-node-agent demo   # offline, no keys needed
```

Typecheck resolves `@cloudfarm/*` from `src`, not `dist`: every package
exports a `@cloudfarm/source` condition and `tsconfig.base.json` selects it
through `customConditions`. So `tsc` works on a fresh clone with nothing built,
and so does your editor. Node and bundlers ignore that condition and still get
`dist`. If you add a package, give its `exports` the source condition too, and
do not add `references` / `composite` back — that is what used to pin typecheck
to build output.

Run `pnpm check` after every change of substance, not only before committing.
It spans `examples/` as well as `packages/`, which is what catches a core
change that compiles in isolation but breaks a consumer.

The demo is the fastest end-to-end signal: it exercises the filesystem, the
shell, action search, code mode chaining several calls, and a runaway loop
being stopped at its deadline. `examples/node-agent/src/main.ts` is the public
API's regression test — if it stops compiling, the surface has drifted.
