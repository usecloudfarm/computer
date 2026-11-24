/**
 * The four things under test: two shells, at two layers each.
 *
 * - `shell` is the interpreter on its own — `just-bash`'s `Bash` and the
 *   `rust_bash` wasm class — with the fixture files handed to it and a script
 *   run. Nothing else is in the timed region.
 * - `provider` is the same shell through `@cloudfarm/computer`: a real
 *   `Workspace`, `ws.exec(...)`, the snapshot of the workspace filesystem
 *   pushed in before the command and whatever changed pulled back out after.
 *
 * The gap between the two layers is the sync tax, and it is most of what a
 * caller actually pays on small commands. Measuring only one of them would
 * answer a question nobody asked.
 *
 * A fresh interpreter per iteration in both layers, because that is what both
 * providers do per command: the workspace is the only state meant to outlive
 * a command, and a reused instance would quietly benefit from a warm
 * filesystem the real thing never has.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { ROOT, WORKDIR } from "./paths.mjs";

/** `ws.exec`, narrowed to the three fields every layer reports. */
async function execInWorkspace(ws, script) {
  const result = await ws.exec(script);
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}

/** Fixture paths are relative; both layers put them under the workspace root. */
function absolute(files) {
  const mapped = {};
  for (const [path, contents] of Object.entries(files)) {
    mapped[`${WORKDIR}/${path}`] = contents;
  }
  return mapped;
}

/** Fixture paths as the host sees them: the workspace root is `/`. */
function hostPaths(files) {
  const mapped = {};
  for (const [path, contents] of Object.entries(files)) mapped[`/${path}`] = contents;
  return mapped;
}

/** `just-bash`, loaded the way `@cloudfarm/bash-sandbox` loads it. */
async function loadJustBash() {
  const require = createRequire(new URL("packages/sandboxes/bash-sandbox/package.json", ROOT));
  return import(pathToFileURL(require.resolve("just-bash")).href);
}

/** The wasm module, compiled once per process. */
let rustBash;
async function loadRustBash() {
  if (rustBash) return rustBash;
  const vendor = new URL("packages/sandboxes/rbash-sandbox/vendor/", ROOT);
  const module = await import(new URL("rust_bash.js", vendor).href);
  module.initSync({ module: readFileSync(new URL("rust_bash_bg.wasm", vendor)) });
  rustBash = module;
  return module;
}

/** The interpreters, with no Computer around them. */
export async function shellLayer() {
  const just = await loadJustBash();
  const rust = await loadRustBash();
  const encoder = new TextEncoder();

  return [
    {
      id: "just-bash",
      label: "just-bash",
      layer: "shell",
      commands: new Set(just.getCommandNames()),
      async prepare(files) {
        return absolute(files);
      },
      async exec(files, script) {
        // The constructor takes the files, so loading the fixtures and
        // building the shell are one step here. On the rbash side they are
        // two. Both are inside the timed region on both sides.
        const shell = new just.Bash({
          files,
          cwd: WORKDIR,
          env: { HOME: WORKDIR, PWD: WORKDIR },
          executionLimits: { maxLoopIterations: 200_000, maxCommandCount: 200_000 },
        });
        const result = await shell.exec(script);
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
      },
    },
    {
      id: "rbash",
      label: "rbash (wasm)",
      layer: "shell",
      commands: new Set(rust.Bash.commands()),
      async prepare(files) {
        // Encoded once: the provider hands the shell bytes, and charging this
        // benchmark for UTF-8 encoding the same fixture fifteen times would
        // measure `TextEncoder`, not bash.
        return Object.entries(absolute(files)).map(([path, contents]) => [
          path,
          encoder.encode(contents),
        ]);
      },
      async exec(entries, script) {
        const shell = new rust.Bash();
        for (const [path, bytes] of entries) shell.writeFileBytes(path, bytes);
        // The same preamble `Rbash` writes, so the comparison includes it:
        // the workspace root only exists once something is in it.
        const result = shell.exec(`mkdir -p ${WORKDIR}\ncd ${WORKDIR}\n${script}`);
        const output = {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        };
        shell.free();
        return output;
      },
    },
  ];
}

/**
 * The same shells behind `Computer`, which is how anything real reaches them.
 *
 * Needs `dist`: Node ignores the `@cloudfarm/source` export condition that
 * typecheck and vitest use, so this imports built output. `pnpm bench` builds
 * first; a bare `node tools/shell-bench/bench.mjs` after a `clean` will say
 * what is missing rather than fail obscurely.
 */
export async function providerLayer() {
  const core = await import(new URL("packages/computer/dist/index.js", ROOT).href).catch(() => {
    throw new Error("No dist/ — run `pnpm build` (or `pnpm bench`) before the provider layer.");
  });
  const { JustBash } = await import(
    new URL("packages/sandboxes/bash-sandbox/dist/index.js", ROOT).href
  );
  const { rbash } = await import(
    new URL("packages/sandboxes/rbash-sandbox/dist/node.js", ROOT).href
  );

  const workspace = async (provider, files) => {
    // The seam core's own lookup uses, so the build under test is the one
    // measured rather than whatever is installed in node_modules.
    core.setTestDefaults({ provider });
    const computer = new core.Computer({ storage: new core.MemoryStorage({ seed: files }) });
    return computer.createWorkspace("bench");
  };

  return [
    {
      id: "just-bash",
      label: "just-bash via Computer",
      layer: "provider",
      commands: null,
      prepare: (files) => workspace(new JustBash(), hostPaths(files)),
      exec: execInWorkspace,
      dispose: core.resetDefaults,
    },
    {
      id: "rbash",
      label: "rbash via Computer",
      layer: "provider",
      commands: null,
      prepare: (files) => workspace(rbash(), hostPaths(files)),
      exec: execInWorkspace,
      dispose: core.resetDefaults,
    },
  ];
}
