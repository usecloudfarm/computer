import { loadShell } from "@cloudfarm/rbash/node";
import { Rbash, type RbashOptions } from "./shell.js";

export * from "./shell.js";

/**
 * The shell as a sandbox provider, with the wasm loaded from disk.
 *
 * The interpreter itself is `@cloudfarm/rbash`, which is usable on its own;
 * this adds the `SandboxProvider` around it.
 */
export function rbash(options: RbashOptions = {}): Rbash {
  return new Rbash(loadShell(), options);
}
