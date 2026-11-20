import { describe, expect, it } from "vitest";
import { MemoryFileSystem, MemoryStorage, basename, dirname, normalizePath } from "./vfs.js";

describe("normalizePath", () => {
  it.each([
    ["work/main.py", "/work/main.py"],
    ["/work//main.py", "/work/main.py"],
    ["/work/./main.py", "/work/main.py"],
    ["/work/sub/../main.py", "/work/main.py"],
    ["/../etc/passwd", "/etc/passwd"],
  ])("normalises %s to %s", (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });

  it("splits paths", () => {
    expect(dirname("/a/b/c.txt")).toBe("/a/b");
    expect(basename("/a/b/c.txt")).toBe("c.txt");
    expect(dirname("/top.txt")).toBe("/");
  });
});

describe("MemoryFileSystem", () => {
  it("round-trips text and bytes", async () => {
    const fs = new MemoryFileSystem();
    await fs.write("/a.txt", "hello");
    await fs.write("/b.bin", new Uint8Array([1, 2, 3]));

    expect(await fs.readText("/a.txt")).toBe("hello");
    expect(await fs.read("/b.bin")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("reports size in bytes, not characters", async () => {
    const fs = new MemoryFileSystem({ "/u.txt": "héllo" });
    expect(await fs.stat("/u.txt")).toMatchObject({ size: 6, type: "file" });
  });

  it("throws a useful error for a missing file", async () => {
    const fs = new MemoryFileSystem();
    await expect(fs.readText("/nope")).rejects.toThrow(/No such file: \/nope/);
  });

  it("lists directories first, then files, each alphabetically", async () => {
    const fs = new MemoryFileSystem({ "/w/data/a.csv": "x", "/w/b.txt": "y" });

    const entries = [];
    for await (const entry of fs.list("/w")) entries.push(`${entry.type}:${entry.path}`);

    // A stable order that never depends on insertion sequence.
    expect(entries).toEqual(["directory:/w/data", "file:/w/b.txt", "file:/w/data/a.csv"]);
  });

  it("refuses to remove a directory without recursive", async () => {
    const fs = new MemoryFileSystem({ "/w/a.txt": "x" });
    await expect(fs.remove("/w")).rejects.toThrow(/pass \{ recursive: true \}/);
    await fs.remove("/w", { recursive: true });
    expect(await fs.stat("/w/a.txt")).toBeNull();
  });

  it("moves a whole subtree", async () => {
    const fs = new MemoryFileSystem({ "/a/one.txt": "1", "/a/sub/two.txt": "2" });
    await fs.move("/a", "/b");

    expect(await fs.readText("/b/one.txt")).toBe("1");
    expect(await fs.readText("/b/sub/two.txt")).toBe("2");
    expect(await fs.stat("/a/one.txt")).toBeNull();
  });

  it("reports a directory via stat even though only files are stored", async () => {
    const fs = new MemoryFileSystem({ "/w/a.txt": "x" });
    expect(await fs.stat("/w")).toMatchObject({ type: "directory" });
  });
});

describe("MemoryStorage", () => {
  it("gives each workspace its own filesystem", async () => {
    const storage = new MemoryStorage();
    const alice = await storage.open({ userId: "alice", workspaceId: "default" });
    const bob = await storage.open({ userId: "bob", workspaceId: "default" });

    await alice.write("/secret.txt", "alice only");

    expect(await bob.stat("/secret.txt")).toBeNull();
  });

  it("returns the same filesystem when a workspace is reopened", async () => {
    const storage = new MemoryStorage();
    const first = await storage.open({ userId: "a", workspaceId: "w" });
    await first.write("/keep.txt", "kept");
    const second = await storage.open({ userId: "a", workspaceId: "w" });

    expect(await second.readText("/keep.txt")).toBe("kept");
  });

  it("seeds every new workspace", async () => {
    const storage = new MemoryStorage({ seed: { "/README.md": "# hi" } });
    const fs = await storage.open({ userId: "a", workspaceId: "w" });

    expect(await fs.readText("/README.md")).toBe("# hi");
  });
});
