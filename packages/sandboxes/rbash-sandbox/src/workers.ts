import { loadShellForWorkers } from "@cloudfarm/rbash/workers";
import { Rbash, type RbashOptions } from "./shell.js";

export * from "./shell.js";

/**
 * The shell as a sandbox provider, with the wasm handed in.
 *
 * Workers refuses `WebAssembly.compile` on bytes, so the module has to be a
 * static import that only the caller's bundler can emit:
 *
 * ```ts
 * import wasmModule from "@cloudfarm/rbash/wasm";
 * const provider = rbashForWorkers(wasmModule);
 * ```
 *
 * The same constraint `@cloudfarm/qjs-engine` has, for the same reason.
 */
export function rbashForWorkers(wasmModule: WebAssembly.Module, options: RbashOptions = {}): Rbash {
  return new Rbash(loadShellForWorkers(wasmModule), options);
}
