import { describe, expect, it, vi } from "vitest";
import { Computer } from "@cloudfarm/core";

const run = vi.fn(async () => ({ exitCode: 0, stdout: "hi\n", stderr: "" }));
const kill = vi.fn(async () => true);
const create = vi.fn(async () => ({ sandboxId: "sbx_1", commands: { run }, kill }));
const connect = vi.fn(async () => ({ sandboxId: "sbx_1", commands: { run }, kill }));

// The SDK is an optional peer, so the provider is tested against a stand-in
// rather than a live microVM.
vi.mock("e2b", () => ({ Sandbox: { create, connect } }));

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
});
