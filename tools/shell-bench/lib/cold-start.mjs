/**
 * Cold start, measured in a process that has never seen either shell.
 *
 * In-process timings cannot answer this: by the time the first case runs, the
 * module is loaded, the wasm is compiled and the JIT has warmed up. On a
 * Worker or a short-lived Node process that work is paid on the first request,
 * and the two shells pay it very differently — one parses JavaScript, the
 * other compiles a WebAssembly module.
 *
 * Each probe runs in its own child process and reports three phases: loading
 * the module, getting it ready (wasm instantiation, which `just-bash` does not
 * have), and the first command.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { ROOT, WORKDIR } from "./paths.mjs";
import { quantile } from "./stats.mjs";

const PROBES = {
  "just-bash": (entry) => `
    const clock = () => Number(process.hrtime.bigint()) / 1e6;
    const t0 = clock();
    const { Bash } = await import(${JSON.stringify(entry)});
    const t1 = clock();
    const shell = new Bash({ files: {}, cwd: ${JSON.stringify(WORKDIR)} });
    const t2 = clock();
    const result = await shell.exec("echo hello");
    const t3 = clock();
    if (result.stdout.trim() !== "hello") throw new Error("probe did not run");
    console.log(JSON.stringify({ load: t1 - t0, ready: 0, construct: t2 - t1, first: t3 - t2 }));
  `,
  rbash: (entry, wasm) => `
    const { readFileSync } = await import("node:fs");
    const clock = () => Number(process.hrtime.bigint()) / 1e6;
    const t0 = clock();
    const module = await import(${JSON.stringify(entry)});
    const t1 = clock();
    module.initSync({ module: readFileSync(new URL(${JSON.stringify(wasm)})) });
    const t2 = clock();
    const shell = new module.Bash();
    const t3 = clock();
    const result = shell.exec("echo hello");
    const t4 = clock();
    if (result.stdout.trim() !== "hello") throw new Error("probe did not run");
    console.log(JSON.stringify({ load: t1 - t0, ready: t2 - t1, construct: t3 - t2, first: t4 - t3 }));
  `,
};

/** Runs each probe `runs` times in a fresh process and returns the medians. */
export function coldStart({ runs = 5 } = {}) {
  const require = createRequire(new URL("packages/sandboxes/bash-sandbox/package.json", ROOT));
  const vendor = new URL("packages/rbash/vendor/", ROOT);
  const sources = {
    "just-bash": PROBES["just-bash"](pathToFileURL(require.resolve("just-bash")).href),
    rbash: PROBES.rbash(
      new URL("rust_bash.js", vendor).href,
      new URL("rust_bash_bg.wasm", vendor).href,
    ),
  };

  const directory = mkdtempSync(join(tmpdir(), "shell-bench-"));
  const results = {};
  for (const [id, source] of Object.entries(sources)) {
    const file = join(directory, `${id}.mjs`);
    writeFileSync(file, source);
    const phases = [];
    for (let run = 0; run < runs; run += 1) {
      const wall = process.hrtime.bigint();
      const stdout = execFileSync(process.execPath, [file], { encoding: "utf8" });
      const parsed = JSON.parse(stdout);
      parsed.process = Number(process.hrtime.bigint() - wall) / 1e6;
      phases.push(parsed);
    }
    results[id] = median(phases);
  }
  return results;
}

function median(phases) {
  const out = {};
  for (const key of Object.keys(phases[0])) {
    out[key] = quantile(
      phases.map((phase) => phase[key]).toSorted((a, b) => a - b),
      0.5,
    );
  }
  return out;
}
