import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initSync, Bash } from "../vendor/rust_bash.js";
import { Rbash, type RbashOptions, type RustBashConstructor } from "./shell.js";

export * from "./shell.js";

let started = false;

/**
 * The shell, with the wasm loaded from disk.
 *
 * Node can compile a module from bytes, so nothing has to be passed in. On
 * Workers it does — see `./workers`.
 */
export function rbash(options: RbashOptions = {}): Rbash {
  if (!started) {
    const wasm = new URL("../vendor/rust_bash_bg.wasm", import.meta.url);
    initSync({ module: readFileSync(fileURLToPath(wasm)) });
    started = true;
  }
  return new Rbash(Bash as unknown as RustBashConstructor, options);
}
