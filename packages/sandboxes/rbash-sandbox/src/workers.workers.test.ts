import { describe, expect, it } from "vitest";
import { Computer, MemoryStorage, resetDefaults, setTestDefaults } from "@cloudfarm/computer";
// Statically imported, which is the whole point: Workers refuses
// `WebAssembly.compile` on bytes, so only the bundler can produce the module.
import wasmModule from "../../../rbash/vendor/rust_bash_bg.wasm";
import { rbashForWorkers } from "./workers.js";

const workspace = async (seed: Record<string, string> = {}) => {
  setTestDefaults({ provider: rbashForWorkers(wasmModule as WebAssembly.Module) });
  return new Computer({ storage: new MemoryStorage({ seed }) }).createWorkspace("tester");
};

describe("rbash on workerd", () => {
  it("runs a command", async () => {
    const ws = await workspace();

    expect(await ws.exec("echo hello")).toMatchObject({
      status: "completed",
      exitCode: 0,
      stdout: "hello\n",
    });

    resetDefaults();
  });

  it("reads and writes the workspace", async () => {
    const ws = await workspace({ "/sales.csv": "region,amount\nemea,1200\napac,150\n" });

    const summed = await ws.exec(
      "cut -d, -f2 /data/sales.csv | tail -n +2 | paste -sd+ | bc 2>/dev/null || tail -n +2 /data/sales.csv | cut -d, -f2 | sort -n | tail -1",
    );
    expect(summed.exitCode).toBe(0);

    await ws.exec("mkdir -p /data/out && printf '# done' > /data/out/r.md");
    expect(await ws.fs.readText("/out/r.md")).toBe("# done");

    resetDefaults();
  });

  it("bounds a runaway loop instead of hanging the isolate", async () => {
    const ws = await workspace();

    // On Workers you cannot terminate a thread, so a shell that spins forever
    // is unrecoverable. This one stops itself.
    const result = await ws.exec("i=0; while true; do i=$((i+1)); done");

    expect(result.status).toBe("failed");
    expect(result.stderr).toMatch(/limit/i);

    resetDefaults();
    // The same step-count bound as the Node suite, and workerd is slower to
    // get through it than a laptop is.
  }, 30_000);

  it("has jq, which the TypeScript shell does not ship", async () => {
    const ws = await workspace({ "/d.json": '[{"n":1},{"n":5}]' });

    const result = await ws.exec("jq '[.[].n] | add' /data/d.json");

    expect(result.stdout.trim()).toBe("6");
    resetDefaults();
  });
});
