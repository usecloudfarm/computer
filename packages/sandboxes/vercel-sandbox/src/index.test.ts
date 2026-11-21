import { describe, expect, it, vi } from "vitest";
import { Computer } from "@cloudfarm/core";

const runCommand = vi.fn(async () => ({
  exitCode: 0,
  stdout: async () => "hi\n",
  stderr: async () => "",
}));
const stop = vi.fn(async () => {});
const create = vi.fn(async () => ({ name: "sbx-1", runCommand, stop }));

vi.mock("@vercel/sandbox", () => ({ Sandbox: { create } }));

const { vercelSandbox } = await import("./index.js");

describe("vercel sandbox", () => {
  it("boots a sandbox and runs a command through it", async () => {
    const ws = await new Computer({ provider: vercelSandbox({ token: "t" }) }).createWorkspace("u");

    expect(await ws.exec("echo hi")).toMatchObject({
      status: "completed",
      exitCode: 0,
      stdout: "hi\n",
    });
  });

  it("hands the command to bash rather than splitting it here", async () => {
    const ws = await new Computer({ provider: vercelSandbox({}) }).createWorkspace("u");

    await ws.exec("echo a && echo b", { cwd: "/srv" });

    // runCommand takes a program and arguments, so quoting a shell line is
    // the shell's job — splitting it ourselves would break on every operator.
    expect(runCommand).toHaveBeenLastCalledWith("bash", ["-lc", "echo a && echo b"], {
      cwd: "/srv",
    });
  });

  it("reports a non-zero exit as failed rather than throwing", async () => {
    runCommand.mockResolvedValueOnce({
      exitCode: 3,
      stdout: async () => "",
      stderr: async () => "bad",
    });
    const ws = await new Computer({ provider: vercelSandbox({}) }).createWorkspace("u");

    expect(await ws.exec("false")).toMatchObject({ status: "failed", exitCode: 3, stderr: "bad" });
  });
});
