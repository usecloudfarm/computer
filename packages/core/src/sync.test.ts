import { describe, expect, it } from "vitest";
import { SandboxSync } from "./sync.js";
import { MemoryStorage } from "./vfs.js";
import type { FileSystem, SandboxFiles } from "./ports.js";

/** A sandbox disk in a Map, plus a tally of what crossed the wire. */
function fakeSandboxFiles(seed: Record<string, string> = {}) {
  const disk = new Map<string, string>(Object.entries(seed));
  const calls = { read: 0, write: 0, list: 0, entries: 0, remove: 0 };

  const files: SandboxFiles = {
    read: async (path) => {
      calls.read += 1;
      const content = disk.get(path);
      if (content === undefined) throw new Error(`ENOENT ${path}`);
      return content;
    },
    write: async (path, content) => {
      calls.write += 1;
      disk.set(path, content);
    },
    list: async (prefix) => {
      calls.list += 1;
      return [...disk.keys()].filter((path) => path === prefix || path.startsWith(`${prefix}/`));
    },
    entries: async (path) => {
      calls.entries += 1;
      const depth = path === "/" ? 1 : path.split("/").length;
      return [
        ...new Set(
          [...disk.keys()]
            .filter((key) => key.startsWith(path === "/" ? "/" : `${path}/`))
            .map((key) => key.split("/")[depth])
            .filter(Boolean),
        ),
      ] as string[];
    },
    remove: async (path) => {
      calls.remove += 1;
      disk.delete(path);
    },
  };
  return { files, disk, calls };
}

const workspace = async (seed: Record<string, string> = {}): Promise<FileSystem> => {
  const fs = await new MemoryStorage().open({ userId: "u", workspaceId: "w" });
  for (const [path, content] of Object.entries(seed)) await fs.write(path, content);
  return fs;
};

describe("SandboxSync", () => {
  it("puts the workspace into the sandbox", async () => {
    const { files, disk } = fakeSandboxFiles();
    const fs = await workspace({ "/data/a.csv": "x,1" });

    await new SandboxSync(files, fs).push();

    expect(disk.get("/data/a.csv")).toBe("x,1");
  });

  it("brings back what the sandbox wrote", async () => {
    const { files, disk } = fakeSandboxFiles();
    const fs = await workspace({ "/data/a.csv": "x,1" });
    const sync = new SandboxSync(files, fs);

    await sync.push();
    disk.set("/data/out.txt", "written in the sandbox");
    await sync.pull();

    expect(await fs.readText("/data/out.txt")).toBe("written in the sandbox");
  });

  it("finds a file written somewhere the workspace had never been", async () => {
    // The hard case: `/out` does not exist on either side at connect, so it
    // is neither a pushed root nor in the sandbox's baseline. It is found by
    // being a top-level entry that was not there when we started.
    const { files, disk } = fakeSandboxFiles({ "/usr/lib/base.so": "image" });
    const fs = await workspace({ "/data/a.csv": "x,1" });
    const sync = new SandboxSync(files, fs);

    await sync.push();
    disk.set("/out/report.md", "fresh");
    await sync.pull();

    expect(await fs.readText("/out/report.md")).toBe("fresh");
  });

  it("leaves the image alone", async () => {
    // Walking `/` would read the whole root filesystem on every command.
    const { files } = fakeSandboxFiles({ "/usr/lib/base.so": "image" });
    const fs = await workspace({ "/data/a.csv": "x,1" });
    const sync = new SandboxSync(files, fs);

    await sync.push();
    await sync.pull();

    expect(await fs.stat("/usr/lib/base.so")).toBeNull();
  });

  it("costs nothing when nothing changed", async () => {
    const { files, calls } = fakeSandboxFiles();
    const fs = await workspace({ "/data/a.csv": "x,1" });
    const sync = new SandboxSync(files, fs);

    await sync.push();
    const after = calls.write;
    await sync.push();

    expect(calls.write).toBe(after);
  });

  it("removes a file from the sandbox once the host drops it", async () => {
    // Otherwise the next pull would hand it straight back.
    const { files, disk } = fakeSandboxFiles();
    const fs = await workspace({ "/data/a.csv": "x,1" });
    const sync = new SandboxSync(files, fs);

    await sync.push();
    await fs.remove("/data/a.csv");
    await sync.push();

    expect(disk.has("/data/a.csv")).toBe(false);
  });
});
