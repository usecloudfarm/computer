import type { CodeEngine, SandboxProvider } from "./ports.js";

/**
 * The batteries, found rather than imported.
 *
 * `@cloudfarm/bash-sandbox` and `@cloudfarm/qjs-engine` both depend on core, so core
 * cannot depend on them back without a cycle. Instead it looks for them at
 * runtime: install them and they become the defaults, so `new Computer()`
 * with no options has a shell and code mode. Leave them out and the
 * corresponding tools are simply absent, which is what a consumer who passes
 * their own provider wants anyway.
 *
 * The specifiers are variables on purpose. A literal would invite a bundler to
 * pull the Node build of the QuickJS engine into a Workers bundle, where it
 * cannot work — Workers needs the wasm module passed in explicitly, so a
 * Worker should configure `codeEngine` itself.
 */

const BASH = "@cloudfarm/bash-sandbox";
const QUICKJS = "@cloudfarm/qjs-engine";

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

export function defaultCodeEngine(): Promise<CodeEngine | undefined> {
  engine ??= (async () => {
    try {
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
