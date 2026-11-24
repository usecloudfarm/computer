/** Emits everything around `src/`: package manifest, configs, README. */

const REPO = "https://github.com/usecloudfarm/computer";

/**
 * `version` comes from the committed manifest, not from here.
 *
 * It is changesets' field: a release bumps it in the package, and a generator
 * that insisted on its own value would drag every integration back to 0.0.1
 * on the next run — or, worse, fail `gen:integrations:check` immediately
 * after `changeset version` and block the release that just bumped it.
 */
export function emitPackageJson(spec, version = "0.0.1") {
  const dir = `packages/integrations/${spec.dirName}`;
  return (
    JSON.stringify(
      {
        name: spec.packageName,
        version,
        description: spec.npmDescription,
        license: "MIT",
        type: "module",
        sideEffects: false,
        files: ["dist"],
        main: "./dist/index.js",
        types: "./dist/index.d.ts",
        exports: {
          ".": {
            "@cloudfarm/source": "./src/index.ts",
            types: "./dist/index.d.ts",
            import: "./dist/index.js",
          },
        },
        scripts: {
          build: "tsup",
          dev: "tsup --watch",
          test: "vitest run",
          "test:watch": "vitest",
          lint: "oxlint src",
          typecheck: "tsc --noEmit -p tsconfig.json",
          clean: "rm -rf dist .turbo *.tsbuildinfo",
        },
        dependencies: {
          "@cloudfarm/computer": "workspace:^",
          zod: "^4.6.7",
        },
        devDependencies: {
          tsup: "^9.0.0",
          typescript: "^5.9.3",
          vitest: "^5.1.1",
        },
        publishConfig: { access: "public" },
        repository: { type: "git", url: `git+${REPO}.git`, directory: dir },
        homepage: `${REPO}/tree/main/${dir}#readme`,
        bugs: { url: `${REPO}/issues` },
      },
      null,
      2,
    ) + "\n"
  );
}

export function emitTsconfig() {
  return (
    JSON.stringify(
      {
        extends: "../../../tsconfig.base.json",
        compilerOptions: {
          rootDir: "src",
          outDir: "dist",
          lib: ["ES2023", "DOM"],
          types: [],
          tsBuildInfoFile: "dist/.tsbuildinfo",
        },
        include: ["src/**/*.ts"],
        exclude: ["src/**/*.test.ts"],
      },
      null,
      2,
    ) + "\n"
  );
}

export function emitTsup() {
  return `import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2023",
  external: ["@cloudfarm/computer", "zod"],
});
`;
}

export function emitVitest() {
  return `import baseConfig from "../../../vitest.config.js";

export default baseConfig;
`;
}

export function emitReadme(spec) {
  const rows = spec.actions
    .map(
      (action) => `| \`${spec.id}.${action.name}\` | ${action.summary} | ${action.sideEffects} |`,
    )
    .join("\n");
  const docs = spec.docsUrl ? ` See [the upstream docs](${spec.docsUrl}).` : "";

  return `# ${spec.packageName}

${spec.description}

Generated from \`tools/integration-codegen/specs/${spec.id}.mjs\`. Edit the spec and run
\`pnpm gen:integrations\`; \`src/\` is overwritten, so hand edits there are lost.

## Credentials

${spec.credentials}${docs}

${credentialNote(spec)}

## Usage

\`\`\`ts
import { Computer } from "@cloudfarm/computer";
import { ${spec.constName} } from "${spec.packageName}";

const computer = new Computer({
  apps: [${spec.constName}(${usageArgs(spec)})],
});
\`\`\`

## Actions

| ref | what it does | effects |
| --- | ------------ | ------- |
${rows}

Every action goes through \`context.http\`, so a non-2xx arrives as an \`HttpError\`
carrying its status: a 429 reaches the model as a retryable rate limit rather
than a permanent fault. Runs on Node **and** Workers — it uses nothing but
\`fetch\`.
`;
}

function credentialNote(spec) {
  if (spec.auth.kind === "none") {
    return "This app needs no credential, which `noAuth()` states explicitly rather than by omission.";
  }
  return `The credential is held by the auth scheme and applied per request. No action
handler, result, or code-mode script can read it, and \`allowedHosts\` keeps a
credentialed request from being redirected off ${listHosts(spec)} by a URL that
arrived in a model's arguments.`;
}

function listHosts(spec) {
  return spec.allowedHosts.map((host) => `\`${host}\``).join(", ");
}

function usageArgs(spec) {
  const env = spec.id.replace(/-/g, "_").toUpperCase();
  const entries = [];
  if (spec.auth.kind === "apiKey") entries.push(`apiKey: process.env.${env}_API_KEY!`);
  if (spec.auth.kind === "basic") {
    entries.push(`username: process.env.${env}_EMAIL!`, `password: process.env.${env}_API_TOKEN!`);
  }
  for (const [name, option] of Object.entries(spec.options)) {
    if (!option.optional) entries.push(`${name}: ${JSON.stringify(option.sample ?? "example")}`);
  }
  return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
}

export function emitChangeset(spec) {
  return `---
"${spec.packageName}": minor
---

${spec.name} as an app plugin.

${spec.description}

Generated from \`tools/integration-codegen/specs/${spec.id}.mjs\` — the spec is the
source of truth, and \`pnpm gen:integrations:check\` fails if the committed
package has drifted from it.
`;
}
