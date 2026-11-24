/* tslint:disable */
/* eslint-disable */
export class Bash {
  free(): void;
  /**
   * Execution that can wait on the host.
   *
   * The interpreter is synchronous and nothing here may block an
   * isolate, so a run that needs a response it does not have unwinds,
   * and is restarted once the host has fetched it. See `crate::net`
   * for why that is the shape, and what it costs.
   */
  execAsync(script: string): Promise<ExecOutput>;
  constructor();
  /**
   * Synchronous execution. `curl` is unavailable on this path — there
   * is nowhere to await — so a script that reaches it gets
   * "command not found" unless `execAsync` is used instead.
   */
  exec(script: string): ExecOutput;
  /**
   * Gives the shell a way to reach the network, and with it `curl` and
   * `wget`.
   *
   * The function is called with a request object and must return a
   * promise resolving to `{ status, headers, body }` or
   * `{ error }`. Everything about which hosts are reachable is the
   * caller's to decide: this asks, it does not route.
   */
  setFetch(fetch?: Function | null): void;
  writeFile(path: string, content: string): void;
  readFileBytes(path: string): Uint8Array | undefined;
  /**
   * The byte-exact pair of `writeFile`/`readFile`.
   *
   * The string versions lose anything that is not valid UTF-8, which
   * is every gzip stream and every tarball. A caller moving files in
   * and out of the sandbox has to use these or a `.tar.gz` written
   * inside will not survive the trip.
   */
  writeFileBytes(path: string, content: Uint8Array): void;
  cwd(): string;
  /**
   * Names of all built-in commands.
   */
  static commands(): string[];
  readFile(path: string): string | undefined;
}
export class ExecOutput {
  private constructor();
  free(): void;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_bash_free: (a: number, b: number) => void;
  readonly __wbg_execoutput_free: (a: number, b: number) => void;
  readonly __wbg_get_execoutput_exitCode: (a: number) => number;
  readonly __wbg_get_execoutput_stderr: (a: number, b: number) => void;
  readonly __wbg_get_execoutput_stdout: (a: number, b: number) => void;
  readonly __wbg_set_execoutput_exitCode: (a: number, b: number) => void;
  readonly __wbg_set_execoutput_stderr: (a: number, b: number, c: number) => void;
  readonly __wbg_set_execoutput_stdout: (a: number, b: number, c: number) => void;
  readonly bash_commands: (a: number) => void;
  readonly bash_cwd: (a: number, b: number) => void;
  readonly bash_exec: (a: number, b: number, c: number) => number;
  readonly bash_execAsync: (a: number, b: number, c: number) => number;
  readonly bash_new: () => number;
  readonly bash_readFile: (a: number, b: number, c: number, d: number) => void;
  readonly bash_readFileBytes: (a: number, b: number, c: number, d: number) => void;
  readonly bash_setFetch: (a: number, b: number) => void;
  readonly bash_writeFile: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  readonly bash_writeFileBytes: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  readonly __wbindgen_export_0: (a: number) => void;
  readonly __wbindgen_export_1: WebAssembly.Table;
  readonly __wbindgen_export_2: (a: number, b: number) => number;
  readonly __wbindgen_export_3: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
  readonly __wbindgen_export_4: (a: number, b: number, c: number) => void;
  readonly __wbindgen_export_5: (a: number, b: number, c: number) => void;
  readonly __wbindgen_export_6: (a: number, b: number, c: number, d: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
