import { initSync, Bash } from "../vendor/rust_bash.js";
import { Rbash, type RbashOptions, type RustBashConstructor } from "./shell.js";

export * from "./shell.js";

let started = false;

/**
 * The shell, with the wasm handed in.
 *
 * Workers refuses `WebAssembly.compile` on bytes, so the module has to be a
 * static import — and only the caller's bundler can emit one:
 *
 * ```ts
 * import wasmModule from "@cloudfarm/rbash-sandbox/wasm";
 * const provider = rbashForWorkers(wasmModule);
 * ```
 *
 * The same constraint `@cloudfarm/qjs-engine` has, for the same reason.
 */
export function rbashForWorkers(wasmModule: WebAssembly.Module, options: RbashOptions = {}): Rbash {
  if (!started) {
    initSync({ module: wasmModule });
    started = true;
  }
  return new Rbash(Bash as unknown as RustBashConstructor, options);
}
