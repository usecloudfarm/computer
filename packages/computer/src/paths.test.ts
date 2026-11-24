import { describe, expect, it } from "vitest";
import { fromGuestPath, inSandbox, inWorkspace, WORKSPACE_ROOT } from "./paths.js";

describe("workspace paths", () => {
  it("puts the workspace under a root of its own, not at /", () => {
    expect(WORKSPACE_ROOT).toBe("/data");
    expect(inSandbox("/a.csv")).toBe("/data/a.csv");
    expect(inSandbox("a.csv")).toBe("/data/a.csv");
  });

  it("maps a sandbox path back, and only inside the root", () => {
    expect(inWorkspace("/data/a.csv")).toBe("/a.csv");
    expect(inWorkspace("/data")).toBe("/");
    // `/database` starts with the same letters and is not the root.
    expect(inWorkspace("/database/a.csv")).toBeUndefined();
    expect(inWorkspace("/tmp/a.csv")).toBeUndefined();
  });

  it("gives a script writing outside the root somewhere to put it", () => {
    // Not an error: a script reaching for `/tmp` wants scratch, and failing
    // the call would be a worse answer than a corner of the workspace.
    expect(fromGuestPath("/data/a.csv")).toBe("/a.csv");
    expect(fromGuestPath("/tmp/a.csv")).toBe("/tmp/a.csv");
  });
});
