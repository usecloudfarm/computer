#!/usr/bin/env node
/**
 * rbash (bash compiled to WebAssembly) against just-bash (bash in TypeScript),
 * on the same scripts, over the same bytes.
 *
 *   pnpm bench                            # build, then run everything
 *   node tools/shell-bench/bench.mjs      # run against the current dist
 *   node tools/shell-bench/bench.mjs --quick
 *   node tools/shell-bench/bench.mjs --layer=shell --group=search
 *   node tools/shell-bench/bench.mjs --markdown=tools/shell-bench/RESULTS.md
 *
 * Flags:
 *   --iterations=N   timed runs per case (default 10)
 *   --budget=MS      wall-clock ceiling per case and shell (default 4000)
 *   --warmup=N       untimed runs first (default 2)
 *   --layer=L        shell | provider | both (default both)
 *   --group=S        only groups whose name contains S
 *   --case=S         only cases whose id contains S
 *   --heavy          include the large inputs (50k–100k lines)
 *   --quick          3 iterations, 1 warmup, no cold start
 *   --no-cold        skip the cold-start probes
 *   --list           print the case table and exit, without running anything
 *   --json=PATH      write the whole run as JSON
 *   --markdown=PATH  write the report as markdown
 *
 * Why both layers: the interpreter is only half of what a caller waits for.
 * Both providers copy the workspace into the shell before every command and
 * copy what changed back out after, and on a small command that sync is most
 * of the time. Layer 1 isolates the shell; layer 2 is what an agent pays.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import os from "node:os";
import process from "node:process";
import { format, resolveConfig } from "prettier";

import { coldStart } from "./lib/cold-start.mjs";
import { ROOT } from "./lib/paths.mjs";
import { measure, summarize } from "./lib/stats.mjs";
import { renderCases, renderConsole, renderMarkdown } from "./lib/report.mjs";
import { providerLayer, shellLayer } from "./lib/shells.mjs";
import { workloads } from "./lib/workloads.mjs";

const SHELL_IDS = ["just-bash", "rbash"];

async function main(argv) {
  const options = parse(argv);
  if (options.help) {
    process.stdout.write(
      `${
        readFileSync(new URL(import.meta.url))
          .toString()
          .split("*/")[0]
      }*/\n`,
    );
    return;
  }

  const cases = workloads().filter(
    (entry) =>
      (options.heavy || !entry.heavy) &&
      (!options.group || entry.group.includes(options.group)) &&
      (!options.case || entry.id.includes(options.case)),
  );
  if (cases.length === 0) throw new Error("No cases matched the filters.");

  if (options.list) {
    process.stdout.write(`${renderCases(cases)}\n`);
    return;
  }

  const layers = {};
  let coverage;
  for (const layer of options.layers) {
    const shells = layer === "shell" ? await shellLayer() : await providerLayer();
    if (layer === "shell") coverage = await compareCommands(shells);
    layers[layer] = await runLayer(layer, shells, cases, options);
    for (const shell of shells) shell.dispose?.();
  }
  if (!coverage) coverage = await compareCommands(await shellLayer());

  const run = {
    meta: meta(options),
    cases: cases.map(({ id, group, bytes, script, note, heavy }) => ({
      id,
      group,
      bytes,
      script,
      note,
      heavy,
    })),
    coverage,
    cold: options.cold ? { runs: 5, phases: coldStart({ runs: 5 }) } : undefined,
    layers,
  };

  process.stderr.write("\n");
  process.stdout.write(`${renderConsole(run)}\n`);

  if (options.json) await write(options.json, `${JSON.stringify(run, null, 2)}\n`);
  if (options.markdown) await write(options.markdown, `${renderMarkdown(run)}\n`);
}

/** One layer: every case, both shells, checked before it is timed. */
async function runLayer(layer, shells, cases, options) {
  const measured = [];
  for (const entry of cases) {
    const results = {};
    const outputs = {};

    for (const shell of shells) {
      const check = await verify(shell, entry);
      results[shell.id] = check;
      if (check.status !== "ok") continue;
      outputs[shell.id] = check.stdout;

      progress(`${layer}  ${entry.id}  ${shell.id}`);
      const samples = await measure({
        setup: () => shell.prepare(entry.files),
        run: (context) => shell.exec(context, entry.script),
        iterations: options.iterations,
        warmup: options.warmup,
        budgetMs: options.budget,
      });
      results[shell.id] = { status: "ok", stats: summarize(samples) };
    }

    const [slow, fast] = SHELL_IDS.map((id) => results[id]);
    measured.push({
      id: entry.id,
      group: entry.group,
      bytes: entry.bytes,
      note: entry.note,
      script: entry.script,
      results,
      speedup:
        slow?.status === "ok" && fast?.status === "ok"
          ? slow.stats.median / fast.stats.median
          : undefined,
      parity: parity(outputs),
    });
  }
  return measured;
}

/**
 * One untimed run, checked against the answer computed in JavaScript.
 *
 * A shell that cannot run a case is a gap in the report, not a zero in the
 * table — and a shell that runs it and gets it wrong must never be timed,
 * because wrong is usually fast.
 */
async function verify(shell, entry) {
  try {
    const context = await shell.prepare(entry.files);
    const output = await shell.exec(context, entry.script);
    if (output.exitCode !== 0) {
      const reason = firstLine(output.stderr) || `exit ${output.exitCode}`;
      const missing = /command not found|not found|unknown command|unrecognized/i.test(reason);
      return { status: missing ? "unsupported" : "failed", reason };
    }
    if (!entry.expect(output.stdout)) {
      return { status: "wrong", reason: `unexpected output: ${preview(output.stdout)}` };
    }
    return { status: "ok", stdout: output.stdout };
  } catch (error) {
    return { status: "error", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Did the two shells agree byte for byte, or only once whitespace is collapsed? */
function parity(outputs) {
  const [a, b] = SHELL_IDS.map((id) => outputs[id]);
  if (a === undefined || b === undefined) return undefined;
  if (a === b) return "exact";
  return squash(a) === squash(b) ? "whitespace" : "differs";
}

const squash = (value) => value.replaceAll(/\s+/g, " ").trim();
const sorted = (values) => [...values].toSorted((a, b) => (a < b ? -1 : 1));

/**
 * Which commands each shell actually has.
 *
 * The two packages publish a list of names, but a name-level diff of those
 * lists lies in both directions: `rbash` does not list its builtins, so `pwd`
 * and `xargs` look missing when they are there. So the lists are only the
 * candidates — every name is then probed with `command -v` inside the shell
 * itself, which is the same question a script asks.
 */
async function compareCommands(shells) {
  const declared = {};
  for (const shell of shells) declared[shell.id] = shell.commands ?? new Set();
  const names = sorted(new Set(Object.values(declared).flatMap((set) => Array.from(set))));

  const resolved = {};
  for (const shell of shells) {
    const script =
      `for name in ${names.join(" ")}; do ` +
      'if command -v "$name" >/dev/null 2>&1; then echo "$name"; fi; done';
    const context = await shell.prepare({});
    const output = await shell.exec(context, script);
    resolved[shell.id] = new Set(output.stdout.split("\n").filter(Boolean));
  }

  const [just, rbash] = SHELL_IDS.map((id) => resolved[id] ?? new Set());
  return {
    probed: names.length,
    shared: sorted([...just].filter((name) => rbash.has(name))),
    justOnly: sorted([...just].filter((name) => !rbash.has(name))),
    rbashOnly: sorted([...rbash].filter((name) => !just.has(name))),
  };
}

function meta(options) {
  const require = createRequire(new URL("packages/sandboxes/bash-sandbox/package.json", ROOT));
  const justBash = require.resolve("just-bash").replace(/dist[\s\S]*$/, "package.json");
  return {
    date: new Date().toISOString().slice(0, 10),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model ?? "unknown",
    justBashVersion: json(justBash).version,
    // The interpreter's own package, not the provider wrapped around it:
    // the wasm is what these timings are of.
    rbashVersion: json(new URL("packages/rbash/package.json", ROOT)).version,
    iterations: options.iterations,
    warmup: options.warmup,
    budget: options.budget,
    heavy: options.heavy,
  };
}

function parse(argv) {
  const flag = (name) => argv.includes(`--${name}`);
  const value = (name, fallback) => {
    const found = argv.find((argument) => argument.startsWith(`--${name}=`));
    return found === undefined ? fallback : found.slice(name.length + 3);
  };
  const quick = flag("quick");
  const layer = value("layer", "both");
  return {
    help: flag("help"),
    list: flag("list"),
    quick,
    heavy: flag("heavy"),
    cold: !flag("no-cold") && !quick,
    iterations: Number(value("iterations", quick ? 3 : 10)),
    budget: Number(value("budget", quick ? 1500 : 4000)),
    warmup: Number(value("warmup", quick ? 1 : 2)),
    layers: layer === "both" ? ["shell", "provider"] : [layer],
    group: value("group", ""),
    case: value("case", ""),
    json: value("json", ""),
    markdown: value("markdown", ""),
  };
}

/**
 * Writes a generated file the way the rest of the repository writes them:
 * through prettier, with the repository's own config, so `pnpm check` does not
 * fail on a report this tool just produced.
 */
async function write(path, contents) {
  const config = (await resolveConfig(path)) ?? {};
  const formatted = await format(contents, { ...config, filepath: path });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, formatted);
  process.stdout.write(`wrote ${path}\n`);
}

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function firstLine(value) {
  return (
    (value ?? "")
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ""
  );
}

function preview(value) {
  const flat = value.replaceAll("\n", "\\n");
  return JSON.stringify(flat.length > 60 ? `${flat.slice(0, 60)}…` : flat);
}

function progress(message) {
  if (!process.stderr.isTTY) return;
  process.stderr.write(`\r\u001B[2K${message}`);
}

await main(process.argv.slice(2));
