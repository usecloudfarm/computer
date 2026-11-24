import { describe, expect, it } from "vitest";
import { Computer } from "@cloudfarm/core";

/**
 * The zero-config path. These assertions only mean something where both
 * default packages are installed, which is why they live here rather than in
 * core — core cannot depend on the packages that depend on it.
 */
describe("Computer defaults", () => {
  it("cannot be handed a different engine", async () => {
    // There is no `codeEngine` option to pass. Code mode is QuickJS, found at
    // runtime, and chaining actions in one pass is why the tool surface stays
    // small — a Computer without it is a different product.
    const workspace = await new Computer().createWorkspace("u");

    expect(workspace.toolSpecs().map((spec) => spec.name)).toContain("code");
    expect(await workspace.code("return 6 * 7;")).toMatchObject({ outcome: "ok", value: 42 });
  });

  it("has a shell and code mode with no options at all", async () => {
    const workspace = await new Computer().createWorkspace("u");

    // The shell is an action of the computer now, not a tool of its own, so
    // "is there a shell?" is asked of search and run rather than the tool list.
    const found = await workspace.search("run a shell command");
    expect(found.actions.map((action) => action.ref)).toContain("bash");
    expect(await workspace.exec("echo hi")).toMatchObject({ stdout: "hi\n", exitCode: 0 });
  });

  it("runs code mode without being handed an engine", async () => {
    const workspace = await new Computer().createWorkspace("u");

    const result = await workspace.code(`
      run("bash", { cmd: "printf 'from the default engine' > /data/note.txt" });
      return run("bash", { cmd: "cat /data/note.txt" }).value.stdout;
    `);

    expect(result).toMatchObject({ outcome: "ok", value: "from the default engine" });
  });

  it("offers the code tool with no apps installed at all", async () => {
    // It used to wait for an app to exist. Code mode is useful with the
    // computer's own actions alone — run("bash") — so gating it on the
    // registry withheld the tool exactly when a bare Computer most needed it.
    const bare = await new Computer().createWorkspace("u");

    expect(bare.toolSpecs().map((spec) => spec.name)).toContain("code");
    expect(
      await bare.code('return run("bash", { cmd: "echo ok" }).value.stdout.trim();'),
    ).toMatchObject({ outcome: "ok", value: "ok" });
  });

  it("refuses a script that tries to re-enter code mode", async () => {
    const workspace = await new Computer().createWorkspace("u");

    // Falls out of `code` no longer being a ref: validation checks the
    // registry, so recursion is refused before anything executes rather than
    // nesting one run's result inside another's.
    const result = await workspace.code(`run("code", { source: "return 1;" });`);

    expect(result.outcome).toBe("invalid");
  });
});
