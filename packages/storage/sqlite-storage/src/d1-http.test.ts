import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { Computer, resetDefaults, setTestDefaults } from "@cloudfarm/computer";
import { JustBash } from "@cloudfarm/bash-sandbox";
import { quickjs } from "@cloudfarm/qjs-engine";
import { d1Storage } from "./d1.js";
import { encode } from "./d1-http.js";
import { CHUNK_BYTES } from "./index.js";

const TOKEN = "probe-token";

/**
 * Cloudflare's D1 REST contract, served over real HTTP by `node:sqlite`.
 *
 * A function double would not exercise the parts most likely to be wrong: the
 * URL, the bearer header, the request body shape, `success: false` arriving
 * with HTTP 200, and the `X'…'` blob literals the driver writes because the
 * API's `params` is documented as strings only.
 */
function d1RestServer() {
  const database = new DatabaseSync(":memory:");
  const seen: { paths: string[]; auth: string[]; bodies: unknown[] } = {
    paths: [],
    auth: [],
    bodies: [],
  };

  const run = (sql: string, params: string[]) => {
    // `sql` may hold several statements joined by semicolons, as the API
    // documents. Only the parameterless ones can be, so this is enough.
    const statement = database.prepare(sql);
    return { results: statement.all(...(params as never[])), success: true };
  };

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.paths.push(request.url ?? "");
      seen.auth.push(request.headers.authorization ?? "");
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        sql?: string;
        params?: string[];
        batch?: { sql: string; params?: string[] }[];
      };
      seen.bodies.push(body);

      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ success: false, errors: [{ message: "bad token" }] }));
        return;
      }

      try {
        const statements = body.batch ?? [{ sql: body.sql!, params: body.params }];
        // `batch` is a transaction, so a failing statement rolls the lot back.
        const result: unknown[] = [];
        database.exec("BEGIN");
        try {
          for (const { sql, params } of statements) result.push(run(sql, params ?? []));
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ success: true, result }));
      } catch (error) {
        // HTTP 200 with success:false, which is what the API really does.
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ success: false, errors: [{ message: (error as Error).message }] }),
        );
      }
    });
  });

  return { server, seen, database };
}

let harness: ReturnType<typeof d1RestServer>;
let origin: string;

beforeAll(async () => {
  harness = d1RestServer();
  await new Promise<void>((resolve) => harness.server.listen(0, "127.0.0.1", resolve));
  const { port } = harness.server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  harness.server.close();
  resetDefaults();
});

const storage = (token = TOKEN) =>
  d1Storage({
    accountId: "acct",
    databaseId: "db-uuid",
    apiToken: token,
    endpoint: origin,
  });

const open = (workspaceId: string) => storage().open({ userId: "ada", workspaceId });

describe("the statement encoder", () => {
  it("writes bytes as a blob literal and leaves the rest as parameters", () => {
    const encoded = encode({
      sql: "INSERT INTO t (a, b, c) VALUES (?, ?, ?)",
      params: ["x", 7, new Uint8Array([0, 255, 16])],
    });

    // `params` is documented as an array of strings, so the bytes cannot go
    // there. A hex literal keeps the column a real BLOB, which is what makes
    // a database written here readable through the binding.
    expect(encoded.sql).toBe("INSERT INTO t (a, b, c) VALUES (?, ?, X'00ff10')");
    expect(encoded.params).toEqual(["x", "7"]);
  });

  it("leaves a question mark inside a string literal alone", () => {
    const encoded = encode({ sql: "SELECT '?' AS q, ? AS p", params: ["v"] });

    expect(encoded.sql).toBe("SELECT '?' AS q, ? AS p");
    expect(encoded.params).toEqual(["v"]);
  });
});

describe("D1 over the REST API", () => {
  it("talks to the documented URL with a bearer token", async () => {
    await open("url");

    expect(harness.seen.paths[0]).toBe("/accounts/acct/d1/database/db-uuid/query");
    expect(harness.seen.auth[0]).toBe(`Bearer ${TOKEN}`);
  });

  it("round-trips text", async () => {
    const fs = await open("text");

    await fs.write("/notes/plan.md", "# plan");

    expect(await fs.readText("/notes/plan.md")).toBe("# plan");
  });

  it("round-trips bytes through the blob literal", async () => {
    const fs = await open("bytes");
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 253, 254, 255]);

    await fs.write("/blob.bin", bytes);

    expect(await fs.read("/blob.bin")).toEqual(bytes);
  });

  it("stores a file spanning several chunks", async () => {
    const fs = await open("chunks");
    const bytes = new Uint8Array(CHUNK_BYTES * 2 + 9);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;

    await fs.write("/big.bin", bytes);

    expect(await fs.read("/big.bin")).toEqual(bytes);
  });

  it("sends a chunked write as one batch request", async () => {
    const fs = await open("batching");
    const before = harness.seen.bodies.length;

    await fs.write("/big.bin", new Uint8Array(CHUNK_BYTES * 3));

    const sent = harness.seen.bodies.slice(before) as { batch?: unknown[] }[];
    // One HTTPS request rather than five. Over a public API that is the
    // difference that matters, and `batch` is the only transaction on offer.
    expect(sent.filter((body) => body.batch).length).toBe(1);
  });

  it("reports a failed statement, which arrives as HTTP 200", async () => {
    const fs = await open("errors");

    // `success: false` with a 200 status is what the API really returns, so a
    // driver that only checked `response.ok` would silently lose writes.
    await expect(fs.read("/missing.txt")).rejects.toThrow(/No such file/);
  });

  it("reports a bad token at open, rather than behaving as though empty", async () => {
    // `open` applies the schema, so bad credentials surface there and not on
    // the first read — which would otherwise look like an empty workspace.
    await expect(
      storage("wrong-token").open({ userId: "ada", workspaceId: "auth" }),
    ).rejects.toThrow(/bad token/);
  });

  it("is the filesystem the shell and code mode share", async () => {
    setTestDefaults({ provider: new JustBash(), codeEngine: quickjs() });
    const ws = await new Computer({ storage: storage() }).createWorkspace("agent");

    await ws.code(`require("fs").writeFileSync("/data/from-code.txt", "written in code");`);
    const seen = await ws.run("bash", { cmd: "cat /data/from-code.txt" });

    expect(seen).toMatchObject({ status: "ok", value: { stdout: "written in code" } });
  });
});
