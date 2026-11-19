# unsandbox

A pnpm + Turborepo monorepo for TypeScript libraries.

## Layout

```
packages/
  firecracker/  @unsandbox/firecracker  – Firecracker microVM driver
  utils/        @unsandbox/utils        – shared utilities
examples/
  basic/        private consumer app used to smoke-test the public API
```

`@unsandbox/firecracker` needs a Linux host with KVM to boot anything; its
tests run anywhere. See [its README](packages/firecracker/README.md).

Each library package builds dual ESM + CJS output with type declarations via
[tsup](https://tsup.egoist.dev/), is tested with [Vitest](https://vitest.dev/), and is versioned
and published with [Changesets](https://github.com/changesets/changesets).

## Getting started

```bash
pnpm install
pnpm build
pnpm test
```

## Scripts

| Command           | What it does                                  |
| ----------------- | --------------------------------------------- |
| `pnpm build`      | Builds every package in dependency order      |
| `pnpm dev`        | Watch-mode builds across packages             |
| `pnpm test`       | Runs all unit tests once                      |
| `pnpm test:watch` | Runs tests in watch mode                      |
| `pnpm typecheck`  | Type-checks every package                     |
| `pnpm lint`       | ESLint across every package                   |
| `pnpm format`     | Formats the repo with Prettier                |
| `pnpm changeset`  | Records a version bump for the next release   |
| `pnpm release`    | Builds packages and publishes with Changesets |

Target a single package with Turborepo filters:

```bash
pnpm build --filter @unsandbox/firecracker
pnpm test --filter @unsandbox/utils...
```

Run the example against the local build:

```bash
pnpm --filter @unsandbox/example-basic start
```

## Adding a package

1. `mkdir -p packages/<name>/src`
2. Copy `package.json`, `tsconfig.json`, `tsup.config.ts`, and `vitest.config.ts` from
   `packages/utils`, then change the package `name`.
3. Add a `{ "path": "./packages/<name>" }` reference to the root `tsconfig.json`.
4. `pnpm install`

## Releasing

1. `pnpm changeset` — pick the affected packages and a semver bump, and describe the change.
2. Merge to `main`. The release workflow opens a "version packages" PR.
3. Merge that PR; the workflow publishes to npm using the `NPM_TOKEN` secret.
