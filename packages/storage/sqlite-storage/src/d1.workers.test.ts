import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { d1Storage, d1Driver, type D1DatabaseLike } from "./d1.js";
import { CHUNK_BYTES } from "./index.js";

/**
 * Against Cloudflare's own D1 client, inside workerd.
 *
 * The node suite exercises the driver through a hand-written double, which can
 * only ever confirm that the driver matches what I believed D1 does. This
 * confirms what it actually does — in particular what `bind` accepts as a
 * blob, which is the one thing a double cannot settle.
 */
const database = () => (env as unknown as { DB: D1DatabaseLike }).DB;

const open = (workspaceId: string) =>
  d1Storage({ database: database() }).open({ userId: "ada", workspaceId });

describe("D1, for real", () => {
  it("round-trips text", async () => {
    const fs = await open("text");

    await fs.write("/notes/plan.md", "# plan");

    expect(await fs.readText("/notes/plan.md")).toBe("# plan");
  });

  it("round-trips bytes that are not text", async () => {
    const fs = await open("bytes");
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 253, 254, 255]);

    await fs.write("/blob.bin", bytes);

    // What `bind` will take as a blob is the detail the node double cannot
    // answer, and getting it wrong silently corrupts every binary file.
    expect(await fs.read("/blob.bin")).toEqual(bytes);
  });

  it("stores a file spanning several chunks and reads it back whole", async () => {
    const fs = await open("chunks");
    const bytes = new Uint8Array(CHUNK_BYTES * 2 + 7);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;

    await fs.write("/big.bin", bytes);

    expect(await fs.read("/big.bin")).toEqual(bytes);
  });

  it("applies a write as one transaction, so a bad statement lands nothing", async () => {
    const driver = d1Driver(database());

    await expect(
      driver.write([
        {
          sql: `INSERT INTO cloudfarm_files (scope, path, size, mtime) VALUES (?, ?, ?, ?)`,
          params: ["t", "/ok.txt", 1, 0],
        },
        { sql: `INSERT INTO nonexistent_table (x) VALUES (?)`, params: [1] },
      ]),
    ).rejects.toThrow();

    // `batch` is D1's only transaction — there is no `BEGIN` over the
    // binding — so this is the assertion that a half-written file is
    // impossible.
    const rows = await driver.all(
      `SELECT path FROM cloudfarm_files WHERE scope = ? AND path = ?`,
      "t",
      "/ok.txt",
    );
    expect(rows).toEqual([]);
  });

  it("keeps two workspaces apart in one database", async () => {
    const monday = await open("monday");
    const tuesday = await open("tuesday");

    await monday.write("/a.txt", "monday");
    await tuesday.write("/a.txt", "tuesday");

    expect(await monday.readText("/a.txt")).toBe("monday");
    expect(await tuesday.readText("/a.txt")).toBe("tuesday");
  });

  it("synthesises directories and lists a subtree", async () => {
    const fs = await open("listing");
    await fs.write("/reports/q3/summary.md", "s");
    await fs.write("/report.md", "r");

    const entries = [];
    for await (const entry of fs.list("/reports")) entries.push([entry.type, entry.path]);

    expect(entries).toEqual([
      ["directory", "/reports/q3"],
      ["file", "/reports/q3/summary.md"],
    ]);
  });
});
