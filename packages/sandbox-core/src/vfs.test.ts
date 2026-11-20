import { describe, expect, it } from "vitest";
import { MemoryFileSystem, basename, dirname, normalizePath } from "./vfs.js";

describe("normalizePath", () => {
  it.each([
    ["work/main.py", "/work/main.py"],
    ["/work//main.py", "/work/main.py"],
    ["/work/./main.py", "/work/main.py"],
    ["/work/sub/../main.py", "/work/main.py"],
    ["/../etc/passwd", "/etc/passwd"],
    ["/", "/"],
  ])("normalises %s to %s", (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });

  it("splits paths into directory and base name", () => {
    expect(dirname("/work/sub/main.py")).toBe("/work/sub");
    expect(basename("/work/sub/main.py")).toBe("main.py");
    expect(dirname("/main.py")).toBe("/");
  });
});

describe("MemoryFileSystem", () => {
  it("round-trips files and reports missing ones", () => {
    const fs = new MemoryFileSystem({ "work/main.py": "print(1)" });

    expect(fs.read("/work/main.py")).toBe("print(1)");
    expect(fs.has("/work/main.py")).toBe(true);
    expect(() => fs.read("/nope")).toThrow(/No such file/);
  });

  it("removes a directory and everything under it", () => {
    const fs = new MemoryFileSystem({
      "/work/a.txt": "a",
      "/work/sub/b.txt": "b",
      "/other/c.txt": "c",
    });

    const removed = fs.remove("/work");

    expect(removed).toEqual(expect.arrayContaining(["/work/a.txt", "/work/sub/b.txt"]));
    expect(Object.keys(fs.snapshot())).toEqual(["/other/c.txt"]);
  });

  it("reports exactly what a snapshot changed", () => {
    const fs = new MemoryFileSystem({ "/a": "1", "/b": "2" });

    const changed = fs.applySnapshot({ "/a": "1", "/b": "changed", "/c": "new" });

    expect(changed).toEqual(["/b", "/c"]);
  });

  it("counts deletions as changes", () => {
    const fs = new MemoryFileSystem({ "/a": "1", "/gone": "2" });

    expect(fs.applySnapshot({ "/a": "1" })).toEqual(["/gone"]);
  });

  it("builds a tree with directories first", () => {
    const fs = new MemoryFileSystem({
      "/work/z.txt": "z",
      "/work/sub/a.txt": "a",
      "/work/a.txt": "aa",
    });

    const tree = fs.tree("/work");

    expect(tree.children.map((child) => `${child.type}:${child.name}`)).toEqual([
      "directory:sub",
      "file:a.txt",
      "file:z.txt",
    ]);
  });

  it("keeps empty directories visible", () => {
    const fs = new MemoryFileSystem();
    fs.mkdir("/work/empty");

    expect(fs.tree("/work").children).toEqual([
      { type: "directory", name: "empty", path: "/work/empty", children: [] },
    ]);
  });

  it("measures size in bytes, not characters", () => {
    const fs = new MemoryFileSystem({ "/u.txt": "héllo" });
    const [file] = fs.tree("/").children.filter((child) => child.type === "file");

    expect(file).toMatchObject({ name: "u.txt", size: 6 });
  });
});
