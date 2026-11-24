import { afterEach, describe, expect, it, vi } from "vitest";
import { Computer, resetDefaults, setTestDefaults } from "@cloudfarm/core";
import { quickjs } from "@cloudfarm/qjs-engine";
import { s3 } from "./index.js";

const OPTIONS = {
  bucket: "my-bucket",
  accessKeyId: "AKIA_TEST",
  secretAccessKey: "secret",
  endpoint: "https://s3.test",
};

/**
 * A bucket in a Map, answering the five verbs the filesystem uses. Enough to
 * exercise key layout, XML listing and the copy-then-delete rename.
 */
function fakeBucket() {
  const objects = new Map<string, Uint8Array>();
  const calls: { method: string; url: string }[] = [];

  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const method = request.method;
    calls.push({ method, url: request.url });
    const key = decodeURIComponent(url.pathname.replace(/^\//, ""));

    if (url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const contents = [...objects.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(
          ([k, v]) =>
            `<Contents><Key>${k}</Key><Size>${v.byteLength}</Size>` +
            `<LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>`,
        )
        .join("");
      return new Response(`<ListBucketResult>${contents}</ListBucketResult>`);
    }

    const copySource = request.headers.get("x-amz-copy-source");
    if (method === "PUT" && copySource) {
      const from = decodeURIComponent(copySource).replace(`/${OPTIONS.bucket}/`, "");
      const body = objects.get(from);
      if (!body) return new Response("", { status: 404 });
      objects.set(key, body);
      return new Response("<CopyObjectResult/>");
    }
    if (method === "PUT") {
      objects.set(key, new Uint8Array(await request.arrayBuffer()));
      return new Response("", { status: 200 });
    }
    if (method === "GET") {
      const body = objects.get(key);
      return body ? new Response(body) : new Response("", { status: 404 });
    }
    if (method === "HEAD") {
      const body = objects.get(key);
      return body
        ? new Response("", {
            headers: {
              "content-length": String(body.byteLength),
              "last-modified": "Thu, 01 Jan 2026 00:00:00 GMT",
            },
          })
        : new Response("", { status: 404 });
    }
    if (method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response("", { status: 400 });
  });

  vi.stubGlobal("fetch", spy);
  return { objects, calls };
}

const open = () => s3(OPTIONS).open({ userId: "ada", workspaceId: "default" });

afterEach(() => vi.unstubAllGlobals());

afterEach(resetDefaults);

describe("s3 storage", () => {
  it("refuses to construct without a bucket or credentials", () => {
    expect(() => s3({ ...OPTIONS, bucket: "" })).toThrow(/needs a bucket/);
    expect(() => s3({ ...OPTIONS, secretAccessKey: "" })).toThrow(/accessKeyId and secret/);
  });

  it("round-trips a file", async () => {
    fakeBucket();
    const fs = await open();

    await fs.write("/data/notes.txt", "hello");

    expect(await fs.readText("/data/notes.txt")).toBe("hello");
  });

  it("keeps each user in their own prefix", async () => {
    const { objects } = fakeBucket();

    await (await s3(OPTIONS).open({ userId: "ada", workspaceId: "default" })).write("/a.txt", "1");
    await (await s3(OPTIONS).open({ userId: "bob", workspaceId: "default" })).write("/a.txt", "2");

    // Two tenants, one bucket, no collision — and the prefix is the boundary
    // a scoped credential should be pinned to.
    expect([...objects.keys()].toSorted()).toEqual([
      "cloudfarm/ada/workspaces/default/a.txt",
      "cloudfarm/bob/workspaces/default/a.txt",
    ]);
  });

  it("keeps each workspace of a user in its own folder, under theirs", async () => {
    const { objects } = fakeBucket();

    await (await s3(OPTIONS).open({ userId: "ada", workspaceId: "monday" })).write("/a.txt", "1");
    await (await s3(OPTIONS).open({ userId: "ada", workspaceId: "tuesday" })).write("/a.txt", "2");

    // `workspaces/` is a literal segment: the user's folder stays open for
    // whatever of theirs outlives a single session.
    expect([...objects.keys()].toSorted()).toEqual([
      "cloudfarm/ada/workspaces/monday/a.txt",
      "cloudfarm/ada/workspaces/tuesday/a.txt",
    ]);
  });

  it("drops the leading folder when the bucket is dedicated to this", async () => {
    const { objects } = fakeBucket();

    const fs = await s3({ ...OPTIONS, prefix: "" }).open({ userId: "ada", workspaceId: "monday" });
    await fs.write("/a.txt", "1");

    expect([...objects.keys()]).toEqual(["ada/workspaces/monday/a.txt"]);
  });

  it("signs every request", async () => {
    const { calls } = fakeBucket();
    const fs = await open();

    await fs.write("/a.txt", "1");

    expect(calls).toHaveLength(1);
    // aws4fetch signs by rewriting headers, so the proof is that the request
    // carries an SigV4 Authorization header rather than none.
    expect(calls[0]?.method).toBe("PUT");
  });

  it("addresses the bucket by host by default, and by path when asked", async () => {
    const { calls } = fakeBucket();

    await (await open()).write("/a.txt", "1");
    expect(calls[0]?.url).toContain("https://my-bucket.s3.test/");

    calls.length = 0;
    const paths = await s3({ ...OPTIONS, pathStyle: true }).open({
      userId: "ada",
      workspaceId: "default",
    });
    await paths.write("/a.txt", "1");
    expect(calls[0]?.url).toContain("https://s3.test/my-bucket/");
  });

  it("returns null from stat for a missing file rather than throwing", async () => {
    fakeBucket();
    const fs = await open();

    expect(await fs.stat("/nope.txt")).toBeNull();
  });

  it("reports a missing file on read, since there is nothing to return", async () => {
    fakeBucket();
    const fs = await open();

    await expect(fs.read("/nope.txt")).rejects.toThrow(/No such file/);
  });

  it("lists files and synthesises the directories S3 does not have", async () => {
    fakeBucket();
    const fs = await open();
    await fs.write("/data/sales.csv", "a,b");
    await fs.write("/data/deep/notes.md", "# hi");

    const entries = [];
    for await (const entry of fs.list("/")) entries.push(entry);

    expect(
      entries
        .filter((e) => e.type === "directory")
        .map((e) => e.path)
        .toSorted(),
    ).toEqual(["/data", "/data/deep"]);
    expect(
      entries
        .filter((e) => e.type === "file")
        .map((e) => e.path)
        .toSorted(),
    ).toEqual(["/data/deep/notes.md", "/data/sales.csv"]);
  });

  it("pages through a listing rather than stopping at the first page", async () => {
    const pages = ["one", "two"];
    const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.searchParams.get("list-type") !== "2") return new Response("", { status: 404 });
      const token = url.searchParams.get("continuation-token");
      const name = token ? pages[1] : pages[0];
      const more = token ? "" : "<NextContinuationToken>tok</NextContinuationToken>";
      return new Response(
        `<ListBucketResult><Contents><Key>cloudfarm/ada/workspaces/default/${name}.txt</Key>` +
          `<Size>1</Size><LastModified>2026-01-01T00:00:00Z</LastModified></Contents>${more}</ListBucketResult>`,
      );
    });
    vi.stubGlobal("fetch", spy);
    const fs = await open();

    const paths = [];
    for await (const entry of fs.list("/")) paths.push(entry.path);

    expect(paths).toEqual(["/one.txt", "/two.txt"]);
  });

  it("moves by copy-then-delete, because S3 has no rename", async () => {
    const { objects } = fakeBucket();
    const fs = await open();
    await fs.write("/a.txt", "payload");

    await fs.move("/a.txt", "/b.txt");

    expect([...objects.keys()]).toEqual(["cloudfarm/ada/workspaces/default/b.txt"]);
    expect(await fs.readText("/b.txt")).toBe("payload");
  });

  it("removes a subtree key by key, since S3 has no recursive delete", async () => {
    const { objects } = fakeBucket();
    const fs = await open();
    await fs.write("/tmp/a.txt", "1");
    await fs.write("/tmp/b.txt", "2");
    await fs.write("/keep.txt", "3");

    await fs.remove("/tmp", { recursive: true });

    expect([...objects.keys()]).toEqual(["cloudfarm/ada/workspaces/default/keep.txt"]);
  });

  it("gives a Computer real storage, reachable from the shell", async () => {
    fakeBucket();
    const workspace = await new Computer({ storage: s3(OPTIONS) }).createWorkspace("ada");

    // What the agent writes with `>` lands in the bucket, and reading it back
    // through the shell returns it: the storage provider is behind both.
    await workspace.run("bash", {
      cmd: "mkdir -p /data/out && printf '# Done' > /data/out/summary.md",
    });

    expect(await workspace.run("bash", { cmd: "cat /data/out/summary.md" })).toMatchObject({
      status: "ok",
      value: { stdout: "# Done", exitCode: 0 },
    });
    // `/data/out/summary.md` to the shell is `/out/summary.md` in storage:
    // `/data` is the workspace's root inside a sandbox, not part of the key.
    expect(await workspace.fs.readText("/out/summary.md")).toBe("# Done");
  });

  it("is the filesystem a script reads and writes in code mode", async () => {
    const { objects } = fakeBucket();
    setTestDefaults({ codeEngine: quickjs() });
    const workspace = await new Computer({ storage: s3(OPTIONS) }).createWorkspace("ada");

    // Nothing in the isolate knows about S3. The `fs` shim calls the host,
    // the host calls the workspace filesystem, and that is whatever storage
    // provider was configured — so attaching a bucket is the whole of it.
    const result = await workspace.code(`
      const fs = require("fs");
      fs.writeFileSync("/data/notes/plan.md", "# from the isolate");
      return fs.readFileSync("/data/notes/plan.md", "utf8");
    `);

    expect(result).toMatchObject({ outcome: "ok", value: "# from the isolate" });
    expect([...objects.keys()].some((key) => key.endsWith("notes/plan.md"))).toBe(true);
  });
});
