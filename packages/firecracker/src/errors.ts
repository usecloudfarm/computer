/** Base class for every error this package throws, so callers can catch one type. */
export class FirecrackerError extends Error {
  override name = "FirecrackerError";
}

/** A non-2xx response from the Firecracker API, carrying its `fault_message`. */
export class FirecrackerApiError extends FirecrackerError {
  override name = "FirecrackerApiError";
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly faultMessage: string | undefined;

  constructor(args: { status: number; method: string; path: string; faultMessage?: string }) {
    super(
      `${args.method} ${args.path} failed with ${args.status}` +
        (args.faultMessage ? `: ${args.faultMessage}` : ""),
    );
    this.status = args.status;
    this.method = args.method;
    this.path = args.path;
    this.faultMessage = args.faultMessage;
  }
}

/** An operation did not complete inside its deadline. */
export class FirecrackerTimeoutError extends FirecrackerError {
  override name = "FirecrackerTimeoutError";
  constructor(what: string, timeoutMs: number) {
    super(`${what} did not complete within ${timeoutMs}ms`);
  }
}

/** The host cannot run Firecracker (wrong OS, no KVM, missing binary). */
export class HostUnsupportedError extends FirecrackerError {
  override name = "HostUnsupportedError";
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`Host cannot run Firecracker:\n  - ${problems.join("\n  - ")}`);
    this.problems = problems;
  }
}

/** The Firecracker process exited unexpectedly. */
export class VmmExitedError extends FirecrackerError {
  override name = "VmmExitedError";
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;

  constructor(code: number | null, signal: NodeJS.Signals | null, stderr: string) {
    super(
      `Firecracker exited (code ${code ?? "null"}, signal ${signal ?? "null"})` +
        (stderr.trim() ? `:\n${stderr.trim()}` : ""),
    );
    this.code = code;
    this.signal = signal;
    this.stderr = stderr;
  }
}
