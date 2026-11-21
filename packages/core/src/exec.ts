import type { ExecEvent, ExecResult } from "./schemas.js";
import type { ExecHandle } from "./ports.js";

/**
 * An `ExecHandle` over a command that resolves all at once.
 *
 * Every remote provider has the same shape underneath: POST a command, wait,
 * get back `{ exitCode, stdout, stderr }`. The handle is a stream because a
 * provider *may* stream, but most answer in one piece — and six copies of
 * this adapter across six provider packages is six places for the event
 * order to drift.
 *
 * `kill` is passed in rather than assumed: a local shell has nothing to kill,
 * a remote one has an endpoint for it.
 */
export function execHandle(options: {
  id: string;
  run: Promise<ExecResult>;
  kill?: () => Promise<void>;
}): ExecHandle {
  const settled = options.run;

  const stream = new ReadableStream<ExecEvent>({
    async start(controller) {
      const result = await settled;
      if (result.stdout) controller.enqueue({ type: "stdout", data: result.stdout });
      if (result.stderr) controller.enqueue({ type: "stderr", data: result.stderr });
      controller.enqueue({ type: "exit", exitCode: result.exitCode, status: result.status });
      controller.close();
    },
  }) as ExecHandle;

  Object.defineProperties(stream, {
    id: { value: options.id },
    result: { value: () => settled },
    kill: { value: options.kill ?? (async () => {}) },
  });
  return stream;
}

/** The common mapping from a remote result to the envelope core expects. */
export function toExecResult(input: {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  startedAt: number;
  /** A timeout has no exit code, which is why `exitCode` is nullable. */
  status?: ExecResult["status"];
}): ExecResult {
  return {
    status: input.status ?? (input.exitCode === 0 ? "completed" : "failed"),
    exitCode: input.exitCode,
    stdout: input.stdout ?? "",
    stderr: input.stderr ?? "",
    durationMs: Date.now() - input.startedAt,
  };
}
