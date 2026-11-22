import { describe, expect, it } from "vitest";
import { Computer, MemoryStorage } from "@cloudfarm/core";
import { fakeSandbox } from "@cloudfarm/core/testing";
import { bashCode } from "./index.js";

const workspace = () =>
  new Computer({
    storage: new MemoryStorage(),
    provider: fakeSandbox(),
    codeEngine: bashCode(),
  }).createWorkspace("u");

describe("bashCode", () => {
  it("reports itself available on Node", async () => {
    expect(await bashCode().available()).toMatchObject({ ok: true });
  });

  it("returns a value through run()", async () => {
    const code = await (
      await workspace()
    ).code(`
      run("fs.write", { path: "/a.txt", content: "hello" });
      return run("fs.read", { path: "/a.txt" }).value;
    `);

    expect(code).toMatchObject({ outcome: "ok", value: "hello" });
  });

  it("runs the same script the isolate engine would", async () => {
    // The point of sharing core's prelude: `run` and `console` are defined
    // once, over `__host` and `__log`, so a script is not written for an
    // engine. If this diverges, the two engines have become two dialects.
    const code = await (
      await workspace()
    ).code(`
      const names = [];
      for (const n of ["a", "b"]) {
        run("fs.write", { path: "/" + n, content: n });
        names.push(run("fs.read", { path: "/" + n }).value);
      }
      return names.join(",");
    `);

    expect(code).toMatchObject({ outcome: "ok", value: "a,b" });
  });

  it("lets a script await a host call, which the isolate cannot", async () => {
    const code = await (
      await workspace()
    ).code(`
      const written = await run("fs.write", { path: "/b.txt", content: "awaited" });
      return written.status + ":" + (await run("fs.read", { path: "/b.txt" })).value;
    `);

    expect(code).toMatchObject({ outcome: "ok", value: "ok:awaited" });
  });

  it("hands a failed call back as an envelope rather than throwing", async () => {
    // A ref that exists but fails at run time: an unknown ref never reaches
    // the engine, because core validates the source first.
    const code = await (
      await workspace()
    ).code(`
      const result = run("fs.read", { path: "/does-not-exist" });
      return result.status;
    `);

    expect(code).toMatchObject({ outcome: "ok", value: "error" });
  });

  it("still refuses an unknown ref before anything executes", async () => {
    const code = await (await workspace()).code(`run("nope.missing", {});`);

    expect(code.outcome).toBe("invalid");
  });

  it("reports a throw as an error outcome, not a crash", async () => {
    const code = await (await workspace()).code(`throw new Error("boom");`);

    expect(code).toMatchObject({ outcome: "error", error: { message: "boom" } });
  });

  it("captures console.log through the same bridge", async () => {
    const code = await (await workspace()).code(`console.log("from the guest"); return 1;`);

    expect(code.outcome).toBe("ok");
    expect(code.logs).toContain("from the guest");
  });

  it("gives the guest run() and nothing else", async () => {
    // `tools` is the proxy just-bash installs. The bootstrap captures it and
    // deletes it, so the only spelling of a host call is run().
    const code = await (await workspace()).code(`return typeof tools;`);

    expect(code).toMatchObject({ outcome: "ok", value: "undefined" });
  });

  it("keeps fetch and require out of reach", async () => {
    // Both are refused by validation, so neither reaches the sandbox — which
    // matters here more than in the isolate, since this guest really does
    // have a `require` underneath it.
    const fetched = await (await workspace()).code(`fetch("https://example.test");`);
    const required = await (await workspace()).code(`require("fs");`);

    expect(fetched.outcome).toBe("invalid");
    expect(required.outcome).toBe("invalid");
  });

  it("stops a runaway script at the timeout", async () => {
    const code = await (
      await workspace()
    ).code(`while (true) {}`, {
      limits: { timeoutMs: 1200 },
    });

    expect(code.outcome).toBe("timeout");
    expect(code.limitsHit).toContain("timeoutMs");
  });

  it("reports a syntax error against the script's own lines", async () => {
    // This engine has no separate compile step, so a syntax error surfaces at
    // evaluation — which the CodeEngine contract allows. What it must not do
    // is quote the wrapper's coordinates: the prelude and the async wrapper
    // sit above the source, so the raw message said line 16 of a one-line
    // script.
    const code = await (await workspace()).code(`const = ;`);

    expect(code.outcome).toBe("error");
    expect(code.error?.message).toContain("line 1:");
    expect(code.error?.message).not.toContain(".cloudfarm");
  });
});
