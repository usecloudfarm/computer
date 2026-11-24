# `@cloudfarm/sqlite-storage`

Workspace files in SQLite: a local file on Node, the Durable Object's own
storage on Workers.

```ts
import { Computer } from "@cloudfarm/core";
import { sqliteStorage } from "@cloudfarm/sqlite-storage";

const computer = new Computer({
  storage: sqliteStorage({ path: ".cloudfarm/workspaces.db" }),
});
```

`path` takes any of:

```ts
sqliteStorage({ path: ".cloudfarm/workspaces.db" }); // relative
sqliteStorage({ path: "/var/lib/cloudfarm/workspaces.db" }); // absolute
sqliteStorage({ path: "file:///var/lib/cloudfarm/db.sqlite" }); // file: URL
sqliteStorage({ path: new URL("file:///var/lib/cf/db.sqlite") }); // URL object
sqliteStorage({ path: ":memory:" }); // dies with the process
sqliteStorage({ path: "./db.sqlite", readOnly: true }); // writes fail
```

A missing parent directory is created. SQLite will not, and what it says
instead — "unable to open database file" — names nothing about the directory.

URI query parameters (`file:db.sqlite?mode=ro&cache=shared`) are **not**
supported: SQLite needs an open flag for those which `node:sqlite` does not
expose. `readOnly` covers the common reason to want one.

There is no remote URL. `libsql://`, `d1://` and friends would be a different
driver, and an asynchronous one — see below.

With a D1 binding, inside a Worker:

```ts
import { d1Storage } from "@cloudfarm/sqlite-storage/d1";

const computer = new Computer({ storage: d1Storage({ database: env.DB }) });
```

Or the same D1 database from anywhere else — a local script, a CI job,
another host — with credentials instead of a binding:

```ts
const computer = new Computer({
  storage: d1Storage({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    databaseId: process.env.D1_DATABASE_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN, // needs D1 Read and D1 Write
  }),
});
```

Both reach the same tables, so one can write what the other reads.

Or inside a SQLite-backed Durable Object:

```ts
import { sqliteStorage } from "@cloudfarm/sqlite-storage/workers";

export class WorkspaceDO extends DurableObject {
  computer = new Computer({ storage: sqliteStorage({ storage: this.ctx.storage }) });
}
```

## Why

There is no bucket, no endpoint and no credentials — so nothing to scope,
rotate or keep away from model-written code, which is the part
`@cloudfarm/s3-storage` has to be careful about.

It also matches the traffic a workspace actually has. The shell reads the
workspace before every command; over S3 that is one HTTPS request per file,
and here it is one statement against a local file or a database in the same
isolate.

What S3 still has: files beyond a Durable Object's 10 GB, and sharing one
workspace between processes that do not share a database.

## It attaches to both the shell and code mode, without doing anything

`StorageProvider` is the only seam involved. `just-bash` runs over
`host.fs`, and code mode's `fs` calls the host, which calls the same
filesystem — so both see one store and each other's writes:

```ts
await ws.code(`require("fs").writeFileSync("/data/report.md", "hi");`);
await ws.run("bash", { cmd: "cat /data/report.md" }); // "hi"
```

Remember that `/data` is the workspace root inside the sandbox: `/data/report.md`
to the agent is `/report.md` to `workspace.fs` and to the database.

## Layout

Two tables, scoped by `<userId>/workspaces/<workspaceId>` to match
`s3-storage`:

| table              | columns                          |
| ------------------ | -------------------------------- |
| `cloudfarm_files`  | `scope`, `path`, `size`, `mtime` |
| `cloudfarm_chunks` | `scope`, `path`, `seq`, `bytes`  |

Content goes in fixed 256 KiB chunks rather than one blob per file, because a
Durable Object caps a key and value together at a few megabytes — the figure
has been raised twice and the docs trail the runtime, so the chunk size sits
under the lowest of them. Chunking moves the ceiling to the 10 GB the object
itself has.

Directories are not stored. They are implied by separators in a path and
synthesised in `list` and `stat`, the same as in `MemoryStorage` and in S3.

### What this is not

`@cloudflare/computer` solves the same problem with content-addressed chunks,
dedup, an LRU and incremental garbage collection with pinning. This has none
of that: a chunk belongs to one path and is deleted with it. That is a real
difference in two cases — a workspace holding many copies of the same bytes,
and one churning large files — and the honest answer there is to port the
content addressing rather than pretend a `DELETE` is equivalent.

## Which one

|             | reached by      | transaction       | notes                             |
| ----------- | --------------- | ----------------- | --------------------------------- |
| `./node`    | function call   | `BEGIN`           | a local file; fastest             |
| `./workers` | function call   | `transactionSync` | the object's own 10 GB; no config |
| `./d1`      | **the network** | `batch()`         | shared between Workers            |

D1 is the only one that is not local, so every read and write is a round trip
where the other two are a function call — and the shell reads the workspace
before every command. Reach for it when a database has to be shared between
Workers, outside any one Durable Object, which is the thing neither of the
others can do.

A chunked write goes to D1 as a single `batch()`: one round trip rather than
one per chunk, and `batch` is also D1's only transaction — there is no `BEGIN`
over the binding.

## Another SQLite

`SqlDriver` is the whole seam — `all` and `write`:

```ts
import { SqliteStorage, type SqlDriver } from "@cloudfarm/sqlite-storage";

new SqliteStorage({ driver: myDriver });
```

`nodeDriver(database)` also takes an already-open `node:sqlite` database, for
sharing one with the rest of an application.

Either method may return a promise, so a database reached over the network
fits — that is how `./d1` works, and libsql/Turso would be the same shape.

`write` takes a statement list rather than a callback, which is what it was
first. A callback cannot be served by either platform with an opinion: a
Durable Object's `transactionSync` needs a synchronous body, impossible once a
driver call may be awaited, and D1 has no `BEGIN` at all. A list is the one
shape all three accept, and it is what makes the write atomic on each.

## Node specifics

`node:sqlite`, so there is no native module to build and nothing to install.
Node still flags it experimental and prints a warning on first use.

`journal_mode = WAL` and `synchronous = NORMAL` are set on open: a chunked
write is several statements, and the default journal makes a file sync of each
one. Both are skipped for a read-only database.
