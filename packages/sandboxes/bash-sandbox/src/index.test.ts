import { afterEach, describe, expect, it } from "vitest";
import { Computer, MemoryStorage, resetDefaults, setTestDefaults } from "@cloudfarm/core";
import { JustBash } from "./index.js";

/**
 * `new Computer()` takes no provider, so these tests install this build of the
 * shell through the same seam core's own lookup uses. Without it core would
 * find the published `dist` rather than the source under test.
 */
async function workspace(seed: Record<string, string> = {}) {
  setTestDefaults({ provider: new JustBash() });
  const computer = new Computer({ storage: new MemoryStorage({ seed }) });
  return computer.createWorkspace("tester");
}

afterEach(resetDefaults);

/** A Computer with the shell found rather than injected, as a consumer gets it. */
async function discovered() {
  return new Computer({ storage: new MemoryStorage() }).createWorkspace("u1");
}

describe("JustBash", () => {
  it("runs a command and returns its output", async () => {
    const ws = await workspace();

    const result = await ws.exec("echo hello");

    expect(result).toMatchObject({ status: "completed", exitCode: 0, stdout: "hello\n" });
  });

  it("is the shell a Computer runs with nothing configured", async () => {
    // The integration core cannot assert on its own: core and this package
    // depend on each other, so turbo has no build order between them and
    // core's suite cannot rely on this `dist` existing. Here it can.
    const ws = await discovered();

    await ws.run("bash", { cmd: "printf hello > /data/a.txt" });

    expect(await ws.run("bash", { cmd: "cat /data/a.txt" })).toMatchObject({
      status: "ok",
      value: { stdout: "hello", exitCode: 0 },
    });
    // And the embedding program sees it at the workspace path, without /data.
    expect(await ws.fs.readText("/a.txt")).toBe("hello");
  });

  it("reads files that are already in the workspace", async () => {
    const ws = await workspace({ "/people.csv": "name,role\nada,engineer\n" });

    // Workspace `/people.csv` is `/data/people.csv` to the shell, the same as
    // it would be in a mounted sandbox.
    const result = await ws.exec("cat /data/people.csv | tail -n +2 | cut -d, -f1");

    expect(result.stdout).toBe("ada\n");
  });

  it("writes files back into the workspace", async () => {
    const ws = await workspace();

    await ws.exec("mkdir -p /data/out && echo written > /data/out/note.txt");

    expect(await ws.fs.readText("/out/note.txt")).toBe("written\n");
  });

  it("sees files the host wrote, without a sync step", async () => {
    const ws = await workspace();
    // `workspace.fs` is the embedding program's filesystem; the shell is the
    // agent's. The snapshot the provider takes is what keeps them the same
    // one, and that is what this asserts.
    await ws.fs.write("/from-host.txt", "via the host\n");

    const result = await ws.exec("cat /data/from-host.txt");

    expect(result.stdout).toBe("via the host\n");
  });

  it("reports a non-zero exit without throwing", async () => {
    const ws = await workspace();

    const result = await ws.exec("exit 3");

    expect(result).toMatchObject({ status: "failed", exitCode: 3 });
  });

  it("supports pipelines, redirection and control flow", async () => {
    const ws = await workspace({ "/words.txt": "pear\napple\nbanana\napple\n" });

    // Unqualified, because the shell starts in the workspace root.
    const result = await ws.exec(
      "sort words.txt | uniq -c | sort -rn | head -1 > top.txt; cat top.txt",
    );

    expect(result.stdout.trim()).toMatch(/2\s+apple/);
  });

  it("bounds a runaway loop instead of hanging", async () => {
    const ws = await workspace();

    const result = await ws.exec("i=0; while true; do i=$((i+1)); done");

    expect(result.status).toBe("failed");
  }, 30_000);

  it("keeps the runtime's own bookkeeping out of the shell's view", async () => {
    const ws = await workspace();
    await ws.fs.write("/.cloudfarm/output/old.txt", "internal");

    const result = await ws.exec("ls -a /data");

    expect(result.stdout).not.toContain(".cloudfarm");
  });

  it("removes a file deleted by the command", async () => {
    const ws = await workspace({ "/gone.txt": "bye" });

    await ws.exec("rm /data/gone.txt");

    expect(await ws.fs.stat("/gone.txt")).toBeNull();
  });

  it("describes itself for the model", () => {
    const provider = new JustBash();

    expect(provider.description).toContain("bash");
    expect(provider.description).toContain("Cannot run npm");
  });
});
