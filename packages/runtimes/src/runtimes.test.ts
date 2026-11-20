import { afterAll, describe, expect, it } from "vitest";
import { runWithGuards } from "@unsandbox/sandbox-core";
import type { RunEvent, SandboxRuntime } from "@unsandbox/sandbox-core";
import { ALL_RUNTIMES } from "./index.js";
import { disposeAllPools } from "./worker-pool.js";

afterAll(async () => {
  await disposeAllPools();
});

/** Source that prints a line and writes a file, per language. */
const PROGRAMS: Record<string, string> = {
  javascript: 'console.log("hello"); fs.writeFile("/work/out/made.txt", "made it\\n");',
  python:
    'import pathlib\nprint("hello")\npathlib.Path("/work/out").mkdir(parents=True, exist_ok=True)\npathlib.Path("/work/out/made.txt").write_text("made it\\n")',
  shell: 'echo hello\nmkdir -p out\necho "made it" > out/made.txt',
};

async function execute(runtime: SandboxRuntime, code: string, timeoutMs = 20_000) {
  const events: RunEvent[] = [];
  const outcome = await runWithGuards(
    runtime,
    { code, files: { "/work/seed.txt": "seed\n" }, limits: { timeoutMs } },
    (event) => events.push(event),
  );
  const text = (type: "stdout" | "stderr") =>
    events
      .filter(
        (event): event is Extract<RunEvent, { type: "stdout" | "stderr" }> => event.type === type,
      )
      .map((event) => event.data)
      .join("");
  const exit = events.find((event) => event.type === "exit");
  return { events, outcome, stdout: text("stdout"), stderr: text("stderr"), exit };
}

describe.each(ALL_RUNTIMES.map((runtime) => [runtime.id, runtime] as const))(
  "%s",
  (_id, runtime) => {
    it("reports availability", async () => {
      await expect(runtime.available()).resolves.toMatchObject({ ok: true });
    });

    it("runs a program, prints to stdout and exits 0", async () => {
      const { stdout, exit } = await execute(runtime, PROGRAMS[runtime.language]!);

      expect(stdout).toContain("hello");
      expect(exit).toMatchObject({ type: "exit", code: 0 });
    });

    it("writes files back into the workspace", async () => {
      const { outcome, events } = await execute(runtime, PROGRAMS[runtime.language]!);

      expect(outcome.files["/work/out/made.txt"]).toBe("made it\n");
      // The seed file survives a run that never touched it.
      expect(outcome.files["/work/seed.txt"]).toBe("seed\n");
      expect(events.find((event) => event.type === "files")).toMatchObject({
        changed: expect.arrayContaining(["/work/out/made.txt"]),
      });
    });

    it("stops a runaway program and reports a non-zero exit", async () => {
      const runaway: Record<string, string> = {
        javascript: "while (true) {}",
        python: "while True:\n    pass",
        shell: "while true; do :; done",
      };

      const { exit } = await execute(runtime, runaway[runtime.language]!, 2_000);

      expect(exit?.type).toBe("exit");
      expect((exit as { code: number }).code).not.toBe(0);
    }, 30_000);
  },
);

describe("failure reporting", () => {
  it("surfaces a JavaScript exception", async () => {
    const quickjs = ALL_RUNTIMES.find((runtime) => runtime.id === "quickjs")!;

    const { events, exit } = await execute(quickjs, 'throw new Error("boom");');

    expect(events.find((event) => event.type === "error")).toMatchObject({ message: "boom" });
    expect(exit).toMatchObject({ code: 1 });
  });

  it("surfaces a Python traceback", async () => {
    const python = ALL_RUNTIMES.find((runtime) => runtime.id === "cpython")!;

    const { events } = await execute(python, "1 / 0");

    expect(events.find((event) => event.type === "error")).toMatchObject({
      message: expect.stringContaining("ZeroDivisionError"),
      stack: expect.stringContaining("Traceback"),
    });
  });

  it("passes through a shell exit code", async () => {
    const dash = ALL_RUNTIMES.find((runtime) => runtime.id === "dash")!;

    const { exit } = await execute(dash, "exit 3");

    expect(exit).toMatchObject({ code: 3 });
  });
});

describe("cross-runtime workspace", () => {
  it("lets one engine read what another wrote", async () => {
    const quickjs = ALL_RUNTIMES.find((runtime) => runtime.id === "quickjs")!;
    const python = ALL_RUNTIMES.find((runtime) => runtime.id === "cpython")!;

    const written = await execute(quickjs, 'fs.writeFile("/work/relay.txt", "from quickjs\\n");');
    const events: RunEvent[] = [];
    await runWithGuards(
      python,
      {
        code: 'print(open("/work/relay.txt").read().strip())',
        files: written.outcome.files,
        limits: { timeoutMs: 20_000 },
      },
      (event) => events.push(event),
    );

    const stdout = events
      .filter((event) => event.type === "stdout")
      .map((event) => (event as { data: string }).data)
      .join("");
    expect(stdout).toContain("from quickjs");
  });
});
