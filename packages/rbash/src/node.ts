import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initSync, Bash } from "../vendor/rust_bash.js";
import type { Shell, ShellConstructor } from "./shell.js";

export * from "./shell.js";

let started = false;

/**
 * The interpreter class, with the wasm loaded from disk.
 *
 * Node can compile a module from bytes, so nothing has to be passed in. On
 * Workers it does — see `./workers`.
 *
 * Returns the class rather than an instance because a shell is cheap and
 * single-use: one per run means a command cannot leak a variable or a stray
 * file into the next.
 */
export function loadShell(): ShellConstructor {
  if (!started) {
    const wasm = new URL("../vendor/rust_bash_bg.wasm", import.meta.url);
    initSync({ module: readFileSync(fileURLToPath(wasm)) });
    started = true;
  }
  return Bash as unknown as ShellConstructor;
}

/**
 * One ready-to-use shell.
 *
 * ```ts
 * const sh = createShell();
 * sh.writeFile("data.json", '[{"n":1},{"n":5}]');
 * sh.exec("jq '[.[].n] | add' data.json"); // → { stdout: "6\n", exitCode: 0 }
 * ```
 */
export function createShell(): Shell {
  return new (loadShell())();
}
