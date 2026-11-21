import { describe, expect, it } from "vitest";
import { Computer } from "@cloudfarm/core";
import { JustBash } from "@cloudfarm/bash";

/**
 * The zero-config path. These assertions only mean something where both
 * default packages are installed, which is why they live here rather than in
 * core — core cannot depend on the packages that depend on it.
 */
describe("Computer defaults", () => {
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

  it("offers the code tool only once there is something to call", async () => {
    const bare = await new Computer().createWorkspace("u");
    expect(bare.toolSpecs().map((spec) => spec.name)).not.toContain("code");

    const withApp = await new Computer({
      apps: [
        {
          id: "demo",
          name: "Demo",
          description: "A demo app.",
          allowedHosts: [],
          authorize: (request) => request,
          actions: () => [],
        },
      ],
    }).createWorkspace("u");
    // An app with no actions still leaves the registry empty.
    expect(withApp.toolSpecs().map((spec) => spec.name)).not.toContain("code");
  });

  it("lets an explicit provider win over the default", async () => {
    const explicit = new JustBash({ cwd: "/work" });
    const workspace = await new Computer({ provider: explicit }).createWorkspace("u");

    await workspace.exec("pwd > /where.txt");

    expect((await workspace.fs.readText("/where.txt")).trim()).toBe("/work");
  });

  it("turns the shell off when passed null", async () => {
    const workspace = await new Computer({ provider: null }).createWorkspace("u");

    expect(workspace.toolSpecs().map((spec) => spec.name)).not.toContain("bash");
    expect(await workspace.run("bash", { cmd: "ls" })).toMatchObject({
      status: "error",
      error: { code: "unknown_ref" },
    });
  });

  it("turns code mode off when passed null", async () => {
    const workspace = await new Computer({ codeEngine: null }).createWorkspace("u");

    expect(await workspace.code("return 1;")).toMatchObject({
      outcome: "error",
      error: { name: "NoCodeEngineError" },
    });
  });
});
