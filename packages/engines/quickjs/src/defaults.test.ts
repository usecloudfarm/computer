import { describe, expect, it } from "vitest";
import { Computer } from "@cloudfarm/core";
import { JustBash } from "@cloudfarm/bash";

/**
 * The zero-config path. These assertions only mean something where both
 * default packages are installed, which is why they live here rather than in
 * core — core cannot depend on the packages that depend on it.
 */
describe("Computer defaults", () => {
  it("cannot be talked out of code mode", async () => {
    // `codeEngine: null` used to turn it off. It now resolves the default,
    // because chaining actions in one pass is why the tool surface stays
    // small — a Computer without it is a different product.
    const workspace = await new Computer({ codeEngine: null }).createWorkspace("u");

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
      run("fs.write", { path: "/note.txt", content: "from the default engine" });
      return run("fs.read", { path: "/note.txt" }).value;
    `);

    expect(result).toMatchObject({ outcome: "ok", value: "from the default engine" });
  });

  it("offers the code tool with no apps installed at all", async () => {
    // It used to wait for an app to exist. Code mode is useful with the
    // computer's own actions alone — run("fs.read"), run("bash") — so gating
    // it on the registry withheld the tool exactly when a bare Computer most
    // needed it.
    const bare = await new Computer().createWorkspace("u");

    expect(bare.toolSpecs().map((spec) => spec.name)).toContain("code");
    expect(
      await bare.code('return run("fs.write", { path: "/a.txt", content: "x" }).status;'),
    ).toMatchObject({ outcome: "ok", value: "ok" });
  });

  it("lets an explicit provider win over the default", async () => {
    const explicit = new JustBash({ cwd: "/work" });
    const workspace = await new Computer({ provider: explicit }).createWorkspace("u");

    await workspace.exec("pwd > /where.txt");

    expect((await workspace.fs.readText("/where.txt")).trim()).toBe("/work");
  });

  it("ignores a null provider rather than turning the shell off", async () => {
    const workspace = await new Computer({ provider: null }).createWorkspace("u");

    expect(await workspace.run("bash", { cmd: "echo hi" })).toMatchObject({
      status: "ok",
      value: { stdout: "hi\n" },
    });
  });

  it("ignores a null codeEngine rather than turning code mode off", async () => {
    const workspace = await new Computer({ codeEngine: null }).createWorkspace("u");

    expect(await workspace.code("return 1;")).toMatchObject({ outcome: "ok", value: 1 });
  });
});
