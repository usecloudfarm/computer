import { z } from "zod";
import type {
  App,
  ActionDefinition,
  ComputerHost,
  ExecHandle,
  Sandbox,
  SandboxProvider,
} from "./ports.js";
import type { ExecEvent, ExecOptions, ExecResult, Json } from "./schemas.js";

/** Test doubles, so a consumer can exercise a Computer without real services. */

export interface FakeAppOptions {
  id?: string;
  name?: string;
  description?: string;
  actions?: readonly ActionDefinition[];
}

export function fakeApp(
  options: FakeAppOptions = {},
): App & { calls: Array<{ name: string; input: unknown }> } {
  const calls: Array<{ name: string; input: unknown }> = [];
  const defaults: ActionDefinition[] = [
    {
      name: "echo",
      summary: "Echo a message back.",
      useCases: ["echo a message", "test an action"],
      input: z.object({ text: z.string().describe("Anything at all.") }),
      output: z.object({ text: z.string() }),
      example: 'fake.echo({ text: "hi" })',
      sideEffects: "read",
      handler: async (input) => {
        calls.push({ name: "echo", input });
        return input as { text: string };
      },
    },
  ];

  return {
    id: options.id ?? "fake",
    name: options.name ?? "Fake",
    description: options.description ?? "A test double app.",
    allowedHosts: ["example.test"],
    actions: () => options.actions ?? defaults,
    authorize: (request) => request,
    calls,
  };
}

export interface FakeSandboxOptions {
  /** Maps a command to its canned result. Anything unmatched exits 127. */
  responses?: Record<string, { stdout?: string; stderr?: string; exitCode?: number }>;
}

/** A SandboxProvider that answers from a lookup table. */
export function fakeSandbox(
  options: FakeSandboxOptions = {},
): SandboxProvider & { commands: string[] } {
  const commands: string[] = [];

  const provider: SandboxProvider & { commands: string[] } = {
    id: "fake-sandbox",
    description: "A scripted sandbox for tests.",
    capabilities: new Set(["bash" as const]),
    commands,
    async connect(_host: ComputerHost): Promise<Sandbox> {
      return {
        exec(command: string, _options?: ExecOptions): ExecHandle {
          commands.push(command);
          const canned = options.responses?.[command] ?? {
            stderr: `command not found: ${command}\n`,
            exitCode: 127,
          };
          const result: ExecResult = {
            status: (canned.exitCode ?? 0) === 0 ? "completed" : "failed",
            exitCode: canned.exitCode ?? 0,
            stdout: canned.stdout ?? "",
            stderr: canned.stderr ?? "",
            durationMs: 1,
          };
          return makeHandle(result);
        },
        serialize: (): Json => ({ kind: "fake" }),
        close: async () => {},
      };
    },
  };
  return provider;
}

function makeHandle(result: ExecResult): ExecHandle {
  const events: ExecEvent[] = [];
  if (result.stdout) events.push({ type: "stdout", data: result.stdout });
  if (result.stderr) events.push({ type: "stderr", data: result.stderr });
  events.push({ type: "exit", exitCode: result.exitCode, status: result.status });

  const stream = new ReadableStream<ExecEvent>({
    start(controller) {
      for (const event of events) controller.enqueue(event);
      controller.close();
    },
  }) as ExecHandle;

  Object.defineProperties(stream, {
    id: { value: "fake-exec" },
    result: { value: async () => result },
    kill: { value: async () => {} },
  });
  return stream;
}
