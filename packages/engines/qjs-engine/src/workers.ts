import { newVariant } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-wasmfile-release-asyncify";
import type { QuickJSEngine } from "./engine.js";
import { engineFromVariant } from "./engine.js";

export { QuickJSEngine } from "./engine.js";
export type { VariantLoader } from "./engine.js";

/**
 * The code-mode engine for Cloudflare Workers.
 *
 * Workers refuses `WebAssembly.compile` on bytes, so the module must be
 * imported statically and handed to the variant — the caller does the import
 * because only their bundler can emit it:
 *
 * ```ts
 * import wasmModule from "@jitl/quickjs-wasmfile-release-asyncify/wasm";
 * const engine = quickjsForWorkers(wasmModule);
 * ```
 */
export function quickjsForWorkers(wasmModule: WebAssembly.Module): QuickJSEngine {
  return engineFromVariant(newVariant(variant, { wasmModule }));
}

export default quickjsForWorkers;
