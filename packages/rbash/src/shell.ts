/**
 * The shell, and the types describing it.
 *
 * Nothing here knows about a Computer: this is a bash interpreter with an
 * in-memory filesystem and nothing else, so it can be used on its own.
 * `@cloudfarm/rbash-sandbox` is the adapter that makes it a `SandboxProvider`.
 *
 * The wasm has to be instantiated before any of this works, which is why the
 * entry points are `./node` and `./workers` rather than a single default.
 */

/** What a command produced. */
export interface ExecOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** What the shell asks the host to fetch, and what it expects back. */
export interface ShellRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface ShellResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
}

/** One interpreter, with its own filesystem. */
export interface Shell {
  /**
   * Run a script.
   *
   * `curl` and `wget` are unavailable here even with `setFetch`: the
   * interpreter is synchronous, so there is nowhere to await. Use
   * {@link Shell.execAsync} for those.
   */
  exec(script: string): ExecOutput;
  /**
   * Run a script that may wait on the host.
   *
   * A run that needs a response it does not have unwinds and is restarted
   * once the host has fetched it, which is what lets a synchronous
   * interpreter reach the network without blocking an isolate.
   */
  execAsync(script: string): Promise<ExecOutput>;
  /**
   * Gives the shell `curl` and `wget`, over a fetch you supply.
   *
   * Which hosts are reachable is entirely yours to decide: this asks, it does
   * not route. Without it, neither command exists.
   */
  setFetch(fetch?: ((request: ShellRequest) => Promise<ShellResponse>) | null): void;
  writeFile(path: string, content: string): void;
  readFile(path: string): string | undefined;
  /**
   * The byte-exact pair.
   *
   * The string versions lose anything that is not valid UTF-8, which is every
   * gzip stream and every tarball.
   */
  writeFileBytes(path: string, content: Uint8Array): void;
  readFileBytes(path: string): Uint8Array | undefined;
  cwd(): string;
  /** Releases the wasm instance. A shell is cheap; make one per run. */
  free(): void;
}

/** The class the wasm module exports, once instantiated. */
export interface ShellConstructor {
  new (): Shell;
  /** Every built-in command this build carries. */
  commands(): string[];
}
