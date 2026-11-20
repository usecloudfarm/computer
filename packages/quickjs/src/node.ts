import variant from "@jitl/quickjs-wasmfile-release-asyncify";
import type { QuickJSEngine } from "./engine.js";
import { engineFromVariant } from "./engine.js";

export { QuickJSEngine } from "./engine.js";
export type { VariantLoader } from "./engine.js";

/**
 * The code-mode engine for Node. The variant loads its own `.wasm` from disk,
 * so nothing extra is needed at the call site.
 */
export function quickjs(): QuickJSEngine {
  return engineFromVariant(variant);
}

export default quickjs;
