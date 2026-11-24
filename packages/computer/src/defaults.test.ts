import { beforeEach, describe, expect, it, vi } from "vitest";

// Every optional package resolves in this workspace, so "not installed" has
// to be arranged. Replacing them with empty modules exercises the real path:
// `defaultProvider` calls `module.rbash`, then `module.JustBash`, both
// undefined here, and the catch turns that into "no default".
vi.mock("@cloudfarm/rbash-sandbox", () => ({}));
vi.mock("@cloudfarm/bash-sandbox", () => ({}));
vi.mock("@cloudfarm/qjs-engine", () => ({}));

import { Computer } from "./computer.js";
import { MemoryStorage } from "./vfs.js";
import { resetDefaults } from "./defaults.js";

const bare = () => new Computer({ storage: new MemoryStorage() }).createWorkspace("u");

describe("a computer whose optional packages are not installed", () => {
  beforeEach(() => resetDefaults());

  it("says how to get a shell rather than failing blankly", async () => {
    expect(await (await bare()).run("bash", { cmd: "ls" })).toMatchObject({
      status: "error",
      error: {
        code: "unknown_ref",
        message: expect.stringContaining("@cloudfarm/bash-sandbox"),
      },
    });
  });

  it("hides a built-in whose package is missing", async () => {
    // Offering `bash` with no sandbox would send the model at a ref that
    // cannot work; the registry indexes it, availability filters it.
    const found = await (await bare()).search("run a shell command");

    expect(found.actions.map((action) => action.ref)).not.toContain("bash");
  });

  it("leaves the shell out of run's description", async () => {
    const description =
      (await bare()).toolSpecs().find((spec) => spec.name === "run")?.description ?? "";

    expect(description).not.toContain("'bash'");
  });

  it("does not offer the computer a bash action it cannot run", async () => {
    const result = (await (await bare()).run("apps.list", {})) as {
      value: { apps: { id: string; actions: string[] }[] };
    };

    expect(result.value.apps.map((app) => app.id)).toEqual(["computer"]);
    expect(result.value.apps[0]?.actions).not.toContain("bash");
  });
});
