import { initSync, Bash } from "../vendor/rust_bash.js";
import type { Shell, ShellConstructor } from "./shell.js";

export * from "./shell.js";

let started = false;

/**
 * The interpreter class, with the wasm handed in.
 *
 * Workers refuses `WebAssembly.compile` on bytes, so the module has to be a
 * static import — and only the caller's bundler can emit one:
 *
 * ```ts
 * import wasmModule from "@cloudfarm/rbash/wasm";
 * const Shell = loadShellForWorkers(wasmModule);
 * ```
 */
export function loadShellForWorkers(wasmModule: WebAssembly.Module): ShellConstructor {
  if (!started) {
    initSync({ module: wasmModule });
    started = true;
  }
  return Bash as unknown as ShellConstructor;
}

/** One ready-to-use shell, from a statically imported wasm module. */
export function createShellForWorkers(wasmModule: WebAssembly.Module): Shell {
  return new (loadShellForWorkers(wasmModule))();
}
