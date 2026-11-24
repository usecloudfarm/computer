#!/usr/bin/env node
/**
 * Generates `packages/integrations/<id>` from `tools/integration-codegen/specs/<id>.mjs`.
 *
 *   node tools/integration-codegen/generate.mjs               # every spec
 *   node tools/integration-codegen/generate.mjs linear stripe # named specs
 *   node tools/integration-codegen/generate.mjs --check       # fail on drift
 *   node tools/integration-codegen/generate.mjs --list        # what exists
 *
 * Every emitted file goes through prettier before it is written or compared,
 * which is what makes `--check` exact: the committed package either matches the
 * spec byte-for-byte or it does not. `pnpm check` runs it, so an integration
 * cannot be hand-edited in `src/` and quietly diverge from the thing that is
 * meant to generate it.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import prettier from "prettier";

import { listSpecIds, loadSpec } from "./lib/spec.mjs";
import { emitSource } from "./lib/emit-src.mjs";
import { emitTest } from "./lib/emit-test.mjs";
import {
  emitChangeset,
  emitPackageJson,
  emitReadme,
  emitTsconfig,
  emitTsup,
  emitVitest,
} from "./lib/emit-files.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function main(argv) {
  const check = argv.includes("--check");
  const names = argv.filter((arg) => !arg.startsWith("--"));
  const ids = names.length > 0 ? names : await listSpecIds();

  if (argv.includes("--list")) {
    for (const id of await listSpecIds()) console.log(id);
    return 0;
  }

  const drifted = [];
  const written = [];
  for (const id of ids) {
    const spec = await loadSpec(id);
    const dir = path.join("packages", "integrations", spec.dirName);
    const files = {
      [path.join(dir, "package.json")]: emitPackageJson(spec),
      [path.join(dir, "tsconfig.json")]: emitTsconfig(spec),
      [path.join(dir, "tsup.config.ts")]: emitTsup(spec),
      [path.join(dir, "vitest.config.ts")]: emitVitest(spec),
      [path.join(dir, "README.md")]: emitReadme(spec),
      [path.join(dir, "src", "index.ts")]: emitSource(spec),
      [path.join(dir, "src", "index.test.ts")]: emitTest(spec),
    };

    for (const [relative, raw] of Object.entries(files)) {
      const contents = await format(raw, relative);
      const absolute = path.join(ROOT, relative);
      const current = await readFile(absolute, "utf8").catch(() => null);
      if (current === contents) continue;
      if (check) {
        drifted.push(relative);
        continue;
      }
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, contents);
      written.push(`${current === null ? "created" : "updated"} ${relative}`);
    }

    // A changeset is a claim about a release, not a generated artefact: write
    // one when it is missing and never touch it again.
    const changeset = path.join(".changeset", `${spec.id}-integration.md`);
    const absolute = path.join(ROOT, changeset);
    const exists = await readFile(absolute, "utf8").then(
      () => true,
      () => false,
    );
    if (!exists && !check) {
      await writeFile(absolute, await format(emitChangeset(spec), changeset));
      written.push(`created ${changeset}`);
    }
  }

  if (check) {
    if (drifted.length === 0) {
      console.log(`${ids.length} integration spec(s) match the committed packages.`);
      return 0;
    }
    console.error("These files no longer match their spec:\n");
    for (const file of drifted) console.error(`  ${file}`);
    console.error(
      "\nEdit tools/integration-codegen/specs/<id>.mjs and run `pnpm gen:integrations`.",
    );
    return 1;
  }

  if (written.length === 0) {
    console.log(`${ids.length} integration(s) already up to date.`);
  } else {
    for (const line of written) console.log(line);
    console.log(
      `\n${ids.length} integration(s) generated. Next:\n` +
        `  pnpm install   # link the new workspace package(s)\n` +
        `  pnpm check     # format, lint, typecheck, build, test`,
    );
  }
  return 0;
}

/** Repo prettier settings, resolved per file so each gets its own parser. */
async function format(contents, relative) {
  const filepath = path.join(ROOT, relative);
  const config = await prettier.resolveConfig(filepath);
  return prettier.format(contents, { ...config, filepath });
}

process.exitCode = await main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  return 1;
});
