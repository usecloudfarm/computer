import { describe, expect, it } from "vitest";
import { Computer, MemoryStorage } from "./index.js";

/**
 * The one thing this package exists to guarantee.
 *
 * `@cloudfarm/computer` finds the shell and the engine at runtime, so whether
 * `run` and `code` exist is decided by what is installed. A consumer who
 * installs only this package installs all three — and if that ever stops
 * being true, the tool list is where it shows up.
 */
describe("cloudfarm", () => {
  it("gives a workspace all three tools with nothing configured", async () => {
    const computer = new Computer({ storage: new MemoryStorage() });

    const workspace = await computer.createWorkspace("u1");
    const specs = workspace.toolSpecs();

    expect(specs.map((spec) => spec.name).toSorted()).toEqual(["code", "run", "search"]);
  });

  it("runs a command through the shell it installed", async () => {
    const computer = new Computer({ storage: new MemoryStorage() });
    const workspace = await computer.createWorkspace("u1");

    const result = await workspace.run("bash", { cmd: "echo hello" });

    expect(result).toMatchObject({ status: "ok", value: { stdout: "hello\n", exitCode: 0 } });
  });
});
