import { RuntimeRegistry } from "@unsandbox/sandbox-core";
import { quickjsRuntime } from "./quickjs.js";
import { v8Runtime } from "./v8.js";
import { pythonRuntime } from "./python.js";
import { bashRuntime } from "./bash.js";
import { dashRuntime } from "./dash.js";

export { quickjsRuntime } from "./quickjs.js";
export { v8Runtime } from "./v8.js";
export { pythonRuntime } from "./python.js";
export { bashRuntime } from "./bash.js";
export { dashRuntime } from "./dash.js";
export { SAMPLES, samplesFor, STARTER_FILES } from "./samples.js";

/** Every runtime this package ships, in the order the UI should list them. */
export const ALL_RUNTIMES = [
  quickjsRuntime,
  v8Runtime,
  pythonRuntime,
  bashRuntime,
  dashRuntime,
] as const;

/** A registry preloaded with all five engines. */
export function createDefaultRegistry(): RuntimeRegistry {
  return new RuntimeRegistry([...ALL_RUNTIMES]);
}
