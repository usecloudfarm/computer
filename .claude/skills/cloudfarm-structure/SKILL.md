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
│   ├── bash/                @cloudfarm/bash   (default: just-bash, no infrastructure)
│   └── e2b/                 @cloudfarm/e2b    (planned)
├── integrations/            App — third-party capabilities
│   └── slack/               @cloudfarm/slack
├── engines/                 CodeEngine — where code mode executes
│   └── quickjs/             @cloudfarm/quickjs
├── toolsets/                Toolset — adapters for agent frameworks
│   └── ai/                  @cloudfarm/ai     (Vercel AI SDK)
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
   A thing that exposes third-party capabilities is an `App` → `integrations/`.
2. **Copy the nearest sibling.** `packages/sandboxes/bash` is the best template
   for a provider; `packages/integrations/slack` for an app. Both are small and
   already have the right config.
3. **Fix the relative paths** — grouped packages sit one level deeper than
   `core`:

   | file                       | in `packages/core`         | in `packages/<kind>/<name>`   |
   | -------------------------- | -------------------------- | ----------------------------- |
   | `tsconfig.json` extends    | `../../tsconfig.base.json` | `../../../tsconfig.base.json` |
   | `tsconfig.json` references | —                          | `{ "path": "../../core" }`    |
   | `vitest.config.ts` imports | `../../vitest.config.js`   | `../../../vitest.config.js`   |

4. **Name it `@cloudfarm/<name>`** — the npm name is flat even though the
   folder is nested, so `packages/integrations/slack` is `@cloudfarm/slack`.
5. `pnpm-workspace.yaml` already globs every kind directory, so a new package
   in an existing folder needs no change there. A brand-new _kind_ does.
6. Run `pnpm install` so the workspace link exists, then `pnpm build`.

## The default packages

`@cloudfarm/bash` and `@cloudfarm/quickjs` are the defaults for `provider` and
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
capability inputs and outputs, run results, wire frames — is a Zod schema in
`packages/core/src/schemas.ts` with its TypeScript type inferred from it. One
definition validates the model's arguments, generates the JSON Schema that tool
definitions need, and renders the TypeScript the model writes against in code
mode. Things with methods (filesystems, providers, engines) stay plain
interfaces in `packages/core/src/ports.ts`; Zod has nothing useful to say about
a method.

**Descriptions are prompt text.** Every `description` field on a provider, app
or capability ships to a language model. Editing one changes behaviour for
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
shell, capability search, code mode chaining several calls, and a runaway loop
being stopped at its deadline. `examples/node-agent/src/main.ts` is the public
API's regression test — if it stops compiling, the surface has drifted.
