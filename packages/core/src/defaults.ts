import type { CodeEngine, SandboxProvider } from "./ports.js";

/**
 * The shell and the engine, found rather than imported.
 *
 * There is one of each and no way to substitute either: the shell is
 * `just-bash` and code mode is QuickJS. `new Computer()` takes no provider and
 * no engine, so this is lookup rather than selection.
 *
 * Found rather than imported because both packages depend on core, so core
 * cannot depend on them back without a cycle. Install them and the `run` and
 * `code` tools exist; leave one out and that tool is absent rather than
 * broken.
 *
 * The specifiers are variables on purpose. A literal would invite a bundler to
 * pull the Node build of the QuickJS engine into a Workers bundle, where it
 * cannot work — hence `wasmModule` below.
 */

const BASH = "@cloudfarm/bash-sandbox";
const QUICKJS = "@cloudfarm/qjs-engine";
const QUICKJS_WORKERS = "@cloudfarm/qjs-engine/workers";

let provider: Promise<SandboxProvider | undefined> | undefined;
let engine: Promise<CodeEngine | undefined> | undefined;

export function defaultProvider(): Promise<SandboxProvider | undefined> {
  provider ??= (async () => {
    try {
      const module = (await import(/* @vite-ignore */ BASH)) as {
        JustBash: new () => SandboxProvider;
      };
      return new module.JustBash();
    } catch {
      return undefined;
    }
  })();
  return provider;
}

/**
 * QuickJS, from whichever entry point this runtime can use.
 *
 * With a `wasmModule` the Workers entry takes it, because Workers refuses
 * `WebAssembly.compile` on bytes and the module has to come from the caller's
 * own static import. Without one, the Node entry loads the `.wasm` from disk.
 * That is the whole of the difference — same engine either way.
 */
export function defaultCodeEngine(
  wasmModule?: WebAssembly.Module,
): Promise<CodeEngine | undefined> {
  engine ??= (async () => {
    try {
      if (wasmModule) {
        const module = (await import(/* @vite-ignore */ QUICKJS_WORKERS)) as {
          quickjsForWorkers: (wasm: WebAssembly.Module) => CodeEngine;
        };
        return module.quickjsForWorkers(wasmModule);
      }
      const module = (await import(/* @vite-ignore */ QUICKJS)) as {
        quickjs: () => CodeEngine;
      };
      return module.quickjs();
    } catch {
      return undefined;
    }
  })();
  return engine;
}

/** Forgets what was found. Tests use this; nothing else should need it. */
export function resetDefaults(): void {
  provider = undefined;
  engine = undefined;
}

/**
 * Puts a scripted shell or engine in place of the real one. Tests only.
 *
 * This is the seam `ComputerOptions.provider` used to be, kept deliberately
 * out of the public options: a test needs to assert what reached the shell
 * and what came back, which is not a reason to let a consumer swap it. Call
 * `resetDefaults()` afterwards, or the next Computer in the process inherits
 * the double.
 */
export function setTestDefaults(doubles: {
  provider?: SandboxProvider;
  codeEngine?: CodeEngine;
}): void {
  if (doubles.provider) provider = Promise.resolve(doubles.provider);
  if (doubles.codeEngine) engine = Promise.resolve(doubles.codeEngine);
}
