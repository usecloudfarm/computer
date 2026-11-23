import { describe, expect, it } from "vitest";
import { Computer, MemoryStorage, execHandle, toExecResult } from "@cloudfarm/core";
import type { ComputerHost, ExecHandle, Sandbox, SandboxProvider } from "@cloudfarm/core";
import { nodeEngine } from "./index.js";

/**
 * A sandbox whose "node" is this process.
 *
 * The engine's contract is a filesystem and a command that runs a script
 * against it. Standing that in with a Map and a real `node` subprocess keeps
 * the test honest about the shape without a microVM — the script it runs is
 * byte-for-byte what a sandbox would run.
 */
function fakeSandbox(): { provider: SandboxProvider; disk: Map<string, string> } {
  const disk = new Map<string, string>();

  const files = {
    read: async (path: string) => {
      const content = disk.get(path);
      if (content === undefined) throw new Error(`ENOENT ${path}`);
      return content;
    },
    write: async (path: string, content: string) => void disk.set(path, content),
    list: async (prefix: string) =>
      [...disk.keys()].filter((p) => p === prefix || p.startsWith(`${prefix}/`)),
    entries: async () => [],
    remove: async (path: string) => void disk.delete(path),
  };

  const sandbox: Sandbox = {
    files,
    exec: (command: string): ExecHandle => {
      const startedAt = Date.now();
      return execHandle({
        id: "fake",
        run: (async () => {
          // `node <path>` — pull the script out of the disk, run it for real.
          const path = command.split(" ").pop() ?? "";
          const source = disk.get(path) ?? "";
          const { writeFileSync, mkdtempSync, readFileSync, existsSync } = await import("node:fs");
          const { tmpdir } = await import("node:os");
          const { join } = await import("node:path");
          const { execFileSync } = await import("node:child_process");

          // The script reads and writes real paths, so give it real ones.
          const dir = mkdtempSync(join(tmpdir(), "node-engine-"));
          const rewritten = source.replaceAll("/tmp/.cloudfarm", dir);
          const scriptPath = join(dir, "script.mjs");
          writeFileSync(scriptPath, rewritten);

          let stdout = "";
          let exitCode = 0;
          try {
            stdout = execFileSync(process.execPath, [scriptPath], { encoding: "utf8" });
          } catch (error) {
            exitCode = 1;
            stdout = String((error as { stdout?: string }).stdout ?? "");
          }
          // Hand results back through the fake disk at the engine's paths.
          for (const name of ["result.json", "request.json"]) {
            const real = join(dir, scriptPath.split("/").slice(-2, -1)[0] ?? "", name);
            if (existsSync(real))
              disk.set(real.replace(dir, "/tmp/.cloudfarm"), readFileSync(real, "utf8"));
          }
          const runDir = source.match(/\/tmp\/\.cloudfarm\/([^/"]+)/)?.[1];
          if (runDir && existsSync(join(dir, runDir, "result.json"))) {
            disk.set(
              `/tmp/.cloudfarm/${runDir}/result.json`,
              readFileSync(join(dir, runDir, "result.json"), "utf8"),
            );
          }
          return toExecResult({ exitCode, stdout, stderr: "", startedAt });
        })(),
      });
    },
    serialize: () => ({ kind: "fake" }),
    close: async () => {},
  };

  return {
    disk,
    provider: {
      id: "fake",
      description: "A stand-in sandbox whose node is this process.",
      capabilities: new Set(["bash" as const]),
      connect: async (_host: ComputerHost) => sandbox,
    },
  };
}

const workspace = async () => {
  const { provider } = fakeSandbox();
  return new Computer({
    storage: new MemoryStorage(),
    provider,
    codeEngine: nodeEngine(),
  }).createWorkspace("u");
};

describe("nodeEngine", () => {
  it("declares that it needs a sandbox", () => {
    expect(nodeEngine().capabilities).toMatchObject({ sandboxed: true, guestAwait: true });
  });

  it("refuses to run without one, and says what to do", async () => {
    // The isolate is the fallback, and a model should not be left guessing
    // why nothing ran.
    const ws = await new Computer({
      storage: new MemoryStorage(),
      provider: null,
      codeEngine: nodeEngine(),
    }).createWorkspace("u");

    const result = await ws.code(`return 1;`);

    expect(result.outcome).toBe("error");
    expect(result.error?.message).toContain("qjs-engine");
  });

  it("returns a value from a script", async () => {
    expect(await (await workspace()).code(`return 1 + 1;`)).toMatchObject({
      outcome: "ok",
      value: 2,
    });
  });

  it("reports a throw as an error outcome", async () => {
    expect(await (await workspace()).code(`throw new Error("boom");`)).toMatchObject({
      outcome: "error",
      error: { message: "boom" },
    });
  });

  // The honest difference between the two engines, and the reason to prefer
  // this one: `fs` here is node's, where the isolate installs a shim over the
  // host. `constants` exists on one and not the other.
  const whichFs = `return typeof require("node:fs").constants;`;

  it("is chosen for a provider that declares `code`, without being named", async () => {
    const { provider } = fakeSandbox();
    const ws = await new Computer({
      storage: new MemoryStorage(),
      provider: { ...provider, capabilities: new Set(["bash" as const, "code" as const]) },
    }).createWorkspace("u");

    expect(await ws.code(whichFs)).toMatchObject({ outcome: "ok", value: "object" });
  });

  it("leaves the isolate in place for a provider that does not", async () => {
    const { provider } = fakeSandbox();
    const ws = await new Computer({
      storage: new MemoryStorage(),
      provider, // declares `bash` only — a virtual shell has no node
    }).createWorkspace("u");

    expect(await ws.code(whichFs)).toMatchObject({ outcome: "ok", value: "undefined" });
  });
});
