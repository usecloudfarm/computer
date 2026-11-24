import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Computer, resetDefaults, setTestDefaults } from "@cloudfarm/computer";
import { JustBash } from "@cloudfarm/bash-sandbox";
import { quickjs } from "@cloudfarm/qjs-engine";
import { sqliteStorage, nodeDriver, resolveLocation } from "./node.js";
import { workersDriver, type SqlStorageLike } from "./workers.js";
import { d1Storage, type D1DatabaseLike, type D1PreparedStatementLike } from "./d1.js";
import { CHUNK_BYTES, SqliteStorage } from "./index.js";

afterEach(resetDefaults);

const storage = () => sqliteStorage({ path: ":memory:" });
const open = () => storage().open({ userId: "ada", workspaceId: "default" });

/** Both halves of the product, so a test asserts the real surface. */
function computer(options: { storage: SqliteStorage }) {
  setTestDefaults({ provider: new JustBash(), codeEngine: quickjs() });
  return new Computer({ storage: options.storage }).createWorkspace("ada");
}

describe("sqlite storage", () => {
  it("round-trips text", async () => {
    const fs = await open();

    const stat = await fs.write("/notes/plan.md", "# plan");

    expect(stat).toMatchObject({ path: "/notes/plan.md", size: 6, type: "file" });
    expect(await fs.readText("/notes/plan.md")).toBe("# plan");
  });

  it("round-trips bytes that are not text", async () => {
    const fs = await open();
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);

    await fs.write("/blob.bin", bytes);

    // The shell could not represent these and the copy sync used to skip
    // them. A BLOB column has no such opinion.
    expect(await fs.read("/blob.bin")).toEqual(bytes);
  });

  it("stores a file larger than one chunk, and reads it back whole", async () => {
    const fs = await open();
    const bytes = new Uint8Array(CHUNK_BYTES * 2 + 7);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;

    await fs.write("/big.bin", bytes);

    const back = await fs.read("/big.bin");
    expect(back.byteLength).toBe(bytes.byteLength);
    expect(back).toEqual(bytes);
  });

  it("truncates rather than leaving the tail of what it overwrote", async () => {
    const fs = await open();
    await fs.write("/a.txt", "x".repeat(CHUNK_BYTES + 100));

    await fs.write("/a.txt", "short");

    expect(await fs.readText("/a.txt")).toBe("short");
    expect((await fs.stat("/a.txt"))?.size).toBe(5);
  });

  it("synthesises the directories a path implies", async () => {
    const fs = await open();
    await fs.write("/reports/q3/summary.md", "s");

    const entries = [];
    for await (const entry of fs.list("/")) entries.push([entry.type, entry.path]);

    expect(entries).toEqual([
      ["directory", "/reports"],
      ["directory", "/reports/q3"],
      ["file", "/reports/q3/summary.md"],
    ]);
    expect(await fs.stat("/reports")).toMatchObject({ type: "directory" });
    expect(await fs.stat("/nope")).toBeNull();
  });

  it("does not mistake a sibling whose name starts the same", async () => {
    const fs = await open();
    await fs.write("/report.md", "a");
    await fs.write("/reports/q3.md", "b");

    const listed = [];
    for await (const entry of fs.list("/reports")) listed.push(entry.path);

    // `substr(path, 1, n) = '/reports/'` and not a `LIKE` on `/reports%`,
    // which would have swept up `/report.md`.
    expect(listed).toEqual(["/reports/q3.md"]);
  });

  it("refuses to remove a directory unless asked recursively", async () => {
    const fs = await open();
    await fs.write("/out/a.txt", "a");

    await expect(fs.remove("/out")).rejects.toThrow(/recursive/);

    await fs.remove("/out", { recursive: true });
    expect(await fs.stat("/out/a.txt")).toBeNull();
  });

  it("clears the workspace when the root is removed", async () => {
    const fs = await open();
    await fs.write("/a.txt", "a");
    await fs.write("/b/c.txt", "c");

    await fs.remove("/", { recursive: true });

    const left = [];
    for await (const entry of fs.list("/")) left.push(entry.path);
    expect(left).toEqual([]);
  });

  it("leaves no chunks behind when a file goes", async () => {
    const database = new DatabaseSync(":memory:");
    const fs = await new SqliteStorage({ driver: nodeDriver(database) }).open({
      userId: "ada",
      workspaceId: "default",
    });
    await fs.write("/big.bin", new Uint8Array(CHUNK_BYTES * 3));

    await fs.remove("/big.bin");

    // No content addressing here, so no reference counting is needed — and
    // equally, nothing else will ever collect these.
    const rows = database.prepare("SELECT count(*) AS n FROM cloudfarm_chunks").get() as {
      n: number;
    };
    expect(rows.n).toBe(0);
  });

  it("moves a file, and a whole subtree", async () => {
    const fs = await open();
    await fs.write("/a.txt", "a");
    await fs.write("/src/one.txt", "1");
    await fs.write("/src/deep/two.txt", "2");

    await fs.move("/a.txt", "/b.txt");
    await fs.move("/src", "/dest");

    expect(await fs.readText("/b.txt")).toBe("a");
    expect(await fs.stat("/a.txt")).toBeNull();
    expect(await fs.readText("/dest/one.txt")).toBe("1");
    expect(await fs.readText("/dest/deep/two.txt")).toBe("2");
    expect(await fs.stat("/src/one.txt")).toBeNull();
  });

  it("moves a file over one that already exists", async () => {
    const fs = await open();
    await fs.write("/a.txt", "new");
    await fs.write("/b.txt", "old");

    await fs.move("/a.txt", "/b.txt");

    expect(await fs.readText("/b.txt")).toBe("new");
  });

  it("reports a missing file rather than an empty one", async () => {
    const fs = await open();

    await expect(fs.read("/nope.txt")).rejects.toThrow(/No such file/);
    await expect(fs.remove("/nope.txt")).rejects.toThrow(/No such file/);
  });

  it("keeps two workspaces of one user apart in the same database", async () => {
    const shared = storage();
    const monday = await shared.open({ userId: "ada", workspaceId: "monday" });
    const tuesday = await shared.open({ userId: "ada", workspaceId: "tuesday" });

    await monday.write("/a.txt", "monday");
    await tuesday.write("/a.txt", "tuesday");

    expect(await monday.readText("/a.txt")).toBe("monday");
    expect(await tuesday.readText("/a.txt")).toBe("tuesday");
  });

  it("survives being reopened, which is the whole point", async () => {
    const database = new DatabaseSync(":memory:");
    const scope = { userId: "ada", workspaceId: "default" };

    const first = await new SqliteStorage({ driver: nodeDriver(database) }).open(scope);
    await first.write("/kept.txt", "still here");

    // A second provider over the same database, as a restarted process gets.
    const second = await new SqliteStorage({ driver: nodeDriver(database) }).open(scope);
    expect(await second.readText("/kept.txt")).toBe("still here");
  });
});

describe("where the database goes", () => {
  it("takes a path, a file: URL or a URL object", () => {
    expect(resolveLocation("/var/lib/cf/db.sqlite").open).toBe("/var/lib/cf/db.sqlite");
    expect(resolveLocation("file:///var/lib/cf/db.sqlite").open).toBe("/var/lib/cf/db.sqlite");
    expect(resolveLocation(new URL("file:///var/lib/cf/db.sqlite")).open).toBe(
      "/var/lib/cf/db.sqlite",
    );
    // All three name the same parent, so all three get it created.
    expect(resolveLocation("file:///var/lib/cf/db.sqlite").directory).toBe("/var/lib/cf");
  });

  it("has no directory to create for an in-memory database", () => {
    expect(resolveLocation(":memory:")).toEqual({ open: ":memory:", directory: undefined });
  });

  it("creates a missing parent directory", async () => {
    // SQLite will not, and the failure it gives instead is "unable to open
    // database file" — which says nothing about the directory.
    const directory = mkdtempSync(join(tmpdir(), "cloudfarm-"));
    const path = join(directory, "nested", "deeper", "db.sqlite");

    const fs = await sqliteStorage({ path }).open({ userId: "ada", workspaceId: "default" });
    await fs.write("/a.txt", "a");

    expect(await fs.readText("/a.txt")).toBe("a");
    rmSync(directory, { recursive: true, force: true });
  });

  it("survives a reopen of the same file, which is the whole point", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cloudfarm-"));
    const path = join(directory, "db.sqlite");
    const scope = { userId: "ada", workspaceId: "default" };

    const first = await sqliteStorage({ path }).open(scope);
    await first.write("/kept.txt", "still here");

    // A second provider over the same file, as a restarted process gets. The
    // `:memory:` tests cannot show this.
    const second = await sqliteStorage({ path: `file://${path}` }).open(scope);
    expect(await second.readText("/kept.txt")).toBe("still here");
    rmSync(directory, { recursive: true, force: true });
  });

  it("refuses to write to a read-only database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cloudfarm-"));
    const path = join(directory, "db.sqlite");
    await (
      await sqliteStorage({ path }).open({ userId: "ada", workspaceId: "default" })
    ).write("/a.txt", "a");

    const locked = await sqliteStorage({ path, readOnly: true }).open({
      userId: "ada",
      workspaceId: "default",
    });

    expect(await locked.readText("/a.txt")).toBe("a");
    await expect(locked.write("/b.txt", "b")).rejects.toThrow();
    rmSync(directory, { recursive: true, force: true });
  });
});

describe("attached to the shell", () => {
  it("is the filesystem bash reads and writes", async () => {
    const ws = await computer({ storage: storage() });
    await ws.fs.write("/sales.csv", "region,amount\nemea,1200\napac,150\n");

    const summed = await ws.run("bash", {
      cmd: "awk -F, 'NR>1{s+=$2} END{print s}' /data/sales.csv",
    });

    expect(summed).toMatchObject({ status: "ok", value: { stdout: "1350\n" } });

    // And what the shell writes is in the database, not just in its own head.
    await ws.run("bash", { cmd: "mkdir -p /data/out && printf '# done' > /data/out/r.md" });
    expect(await ws.fs.readText("/out/r.md")).toBe("# done");
  });
});

describe("attached to code mode", () => {
  it("is the filesystem a script reads and writes", async () => {
    const ws = await computer({ storage: storage() });
    await ws.fs.write("/in.txt", "alpha");

    // Nothing in the isolate knows about SQLite. `fs` calls the host, the
    // host calls the workspace filesystem, and that is whatever storage was
    // configured — so attaching a database is the whole of it.
    const result = await ws.code(`
      const fs = require("fs");
      fs.writeFileSync("/data/out.txt", fs.readFileSync("/data/in.txt", "utf8").toUpperCase());
      return fs.readdirSync("/data").join(",");
    `);

    expect(result).toMatchObject({ outcome: "ok", value: "in.txt,out.txt" });
    expect(await ws.fs.readText("/out.txt")).toBe("ALPHA");
  });

  it("hands the same file to the shell and to a script", async () => {
    const ws = await computer({ storage: storage() });

    await ws.code(`require("fs").writeFileSync("/data/from-code.txt", "written in code");`);
    const seen = await ws.run("bash", { cmd: "cat /data/from-code.txt" });

    expect(seen).toMatchObject({ status: "ok", value: { stdout: "written in code" } });
  });
});

/** `ctx.storage.sql`, standing on `node:sqlite` so the SQL is really run. */
function fakeDurableObjectStorage() {
  const database = new DatabaseSync(":memory:");
  const sql: SqlStorageLike = {
    exec: (query, ...bindings) => ({
      toArray: () =>
        database.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[],
    }),
  };
  return { sql };
}

/**
 * `env.DB`, standing on `node:sqlite`.
 *
 * Asynchronous and `batch`-only, like the real binding — which is the whole
 * reason the driver interface looks the way it does. The real binding is
 * exercised too, under workerd, in `d1.workers.test.ts`.
 */
function fakeD1() {
  const database = new DatabaseSync(":memory:");
  const batched: number[] = [];
  const make = (query: string, bound: unknown[] = []): D1PreparedStatementLike => ({
    bind: (...values) => make(query, values),
    all: async () => ({
      // Real D1 turns the array spelling back into bytes on the way in;
      // `node:sqlite` will not, so the fake does it here.
      results: database
        .prepare(query)
        .all(
          ...(bound.map((value) =>
            Array.isArray(value) ? new Uint8Array(value as number[]) : value,
          ) as never[]),
        ) as Record<string, unknown>[],
    }),
  });
  return {
    batched,
    database: {
      prepare: (query: string) => make(query),
      batch: async (statements: D1PreparedStatementLike[]) => {
        batched.push(statements.length);
        for (const statement of statements) await statement.all();
      },
    } satisfies D1DatabaseLike,
  };
}

describe("the D1 driver", () => {
  it("runs the same filesystem against an asynchronous, batch-only database", async () => {
    const { database } = fakeD1();
    const fs = await d1Storage({ database }).open({ userId: "ada", workspaceId: "default" });

    await fs.write("/a.txt", "via d1");
    await fs.write("/big.bin", new Uint8Array(CHUNK_BYTES + 1));

    expect(await fs.readText("/a.txt")).toBe("via d1");
    expect((await fs.stat("/big.bin"))?.size).toBe(CHUNK_BYTES + 1);
  });

  it("round-trips bytes, which D1 will only bind as an array", async () => {
    const { database } = fakeD1();
    const fs = await d1Storage({ database }).open({ userId: "ada", workspaceId: "default" });
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);

    await fs.write("/blob.bin", bytes);

    expect(await fs.read("/blob.bin")).toEqual(bytes);
  });

  it("sends a chunked write as one batch, not one request per chunk", async () => {
    const { database, batched } = fakeD1();
    const fs = await d1Storage({ database }).open({ userId: "ada", workspaceId: "default" });
    batched.length = 0;

    await fs.write("/big.bin", new Uint8Array(CHUNK_BYTES * 3));

    // Over the network the difference is one round trip against four, and
    // `batch` is also the only transaction D1 has.
    expect(batched).toEqual([5]);
  });
});

describe("the Durable Object driver", () => {
  it("runs the same filesystem against a Durable Object's SQL shape", async () => {
    const fs = await new SqliteStorage({
      driver: workersDriver(fakeDurableObjectStorage()),
    }).open({ userId: "ada", workspaceId: "default" });

    await fs.write("/a.txt", "via the object");
    await fs.write("/big.bin", new Uint8Array(CHUNK_BYTES + 1));

    expect(await fs.readText("/a.txt")).toBe("via the object");
    expect((await fs.stat("/big.bin"))?.size).toBe(CHUNK_BYTES + 1);
  });

  it("groups a write through transactionSync when the object offers one", async () => {
    const objectStorage = fakeDurableObjectStorage();
    let grouped = 0;
    const driver = workersDriver({
      ...objectStorage,
      transactionSync: (body) => {
        grouped += 1;
        return body();
      },
    });
    const fs = await new SqliteStorage({ driver }).open({ userId: "ada", workspaceId: "default" });

    await fs.write("/a.txt", "a");

    // `transactionSync` needs a synchronous body, which is the reason the
    // driver takes a statement list rather than a callback.
    expect(grouped).toBeGreaterThan(0);
    expect(await fs.readText("/a.txt")).toBe("a");
  });
});
