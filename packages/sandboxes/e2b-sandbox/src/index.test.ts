import { describe, expect, it, vi } from "vitest";
import { Computer } from "@cloudfarm/core";

const run = vi.fn(async () => ({ exitCode: 0, stdout: "hi\n", stderr: "" }));
const kill = vi.fn(async () => true);
const create = vi.fn(async () => ({ sandboxId: "sbx_1", commands: { run }, kill }));
const connect = vi.fn(async () => ({ sandboxId: "sbx_1", commands: { run }, kill }));

/** The SDK's own error for a non-zero exit: it carries the whole result. */
class CommandExitError extends Error {
  constructor(
    readonly exitCode: number,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`exit status ${exitCode}`);
  }
}

// The SDK is an optional peer, so the provider is tested against a stand-in
// rather than a live microVM.
vi.mock("e2b", () => ({ Sandbox: { create, connect }, CommandExitError }));

const { e2b } = await import("./index.js");

describe("e2b", () => {
  it("requires an api key", () => {
    expect(() => e2b({ apiKey: "" })).toThrow(/needs an apiKey/);
  });

  it("boots a sandbox and runs a command through it", async () => {
    const ws = await new Computer({ provider: e2b({ apiKey: "k" }) }).createWorkspace("u");

    expect(await ws.exec("echo hi")).toMatchObject({
      status: "completed",
      exitCode: 0,
      stdout: "hi\n",
    });
    expect(create).toHaveBeenCalled();
  });

  it("passes cwd, env and timeout through in the SDK's own spelling", async () => {
    const ws = await new Computer({ provider: e2b({ apiKey: "k" }) }).createWorkspace("u");

    await ws.exec("ls", { cwd: "/srv", env: { A: "1" }, timeoutMs: 5000 });

    // `envs`, not `env` — the SDK's name, and a silent no-op if we got it wrong.
    expect(run).toHaveBeenLastCalledWith("ls", { cwd: "/srv", envs: { A: "1" }, timeoutMs: 5000 });
  });

  it("serializes the sandbox id, so a restart reconnects instead of re-booting", async () => {
    const provider = e2b({ apiKey: "k" });
    const sandbox = await provider.connect({} as never);

    expect(sandbox.serialize()).toEqual({ kind: "e2b", sandboxId: "sbx_1" });

    await provider.connect({} as never, { kind: "e2b", sandboxId: "sbx_1" });
    expect(connect).toHaveBeenCalledWith("sbx_1", { apiKey: "k" });
  });

  it("reports a non-zero exit as a result, not a thrown error", async () => {
    // The SDK throws when a command exits non-zero, and a non-zero exit is a
    // result: `grep` finding nothing exits 1, and so does any `&&` chain
    // whose last link does. Thrown, it reached the model as
    // `{ code: "internal", message: "exit status 1" }` — no stdout, no exit
    // code, nothing to act on. This is the contract bash-sandbox already has.
    const ws = await new Computer({ provider: e2b({ apiKey: "k" }) }).createWorkspace("u");
    // Connect runs a command of its own — `chmod a+w /`, so a script can
    // create a top-level directory — so arm the mock after the sandbox is up.
    await ws.exec("echo warm");
    run.mockImplementationOnce(async () => {
      throw new CommandExitError(1, "partial output\n", "cat: no such file\n");
    });

    expect(await ws.exec("cat /nope")).toMatchObject({
      status: "failed",
      exitCode: 1,
      stdout: "partial output\n",
      stderr: "cat: no such file\n",
    });
  });

  it("still throws for a failure that is not the command's own", async () => {
    // A network error is not a result. Swallowing it would report a healthy
    // command that never ran.
    const ws = await new Computer({ provider: e2b({ apiKey: "k" }) }).createWorkspace("u");
    await ws.exec("echo warm");
    run.mockImplementationOnce(async () => {
      throw new Error("fetch failed");
    });

    await expect(ws.exec("echo hi")).rejects.toThrow(/fetch failed/);
  });
});
