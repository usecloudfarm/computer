---
title: Choosing storage
description: Memory, SQLite, D1 or S3 — what each costs and when to use it.
---

Storage is the one seam that is genuinely open: `StorageProvider` is
`open(scope) → FileSystem`, seven async methods.

|                          | Reached by    | Durable | Use when                                   |
| ------------------------ | ------------- | ------- | ------------------------------------------ |
| memory (default)         | —             | no      | tests, demos                               |
| `sqlite-storage` (node)  | function call | yes     | a server or CLI                            |
| `sqlite-storage/workers` | function call | yes     | a Durable Object                           |
| `sqlite-storage/d1`      | network       | yes     | several Workers share one database         |
| `s3-storage`             | network       | yes     | a bucket you already own; very large files |

## Memory

The default. Everything dies with the process, which is right for tests and
wrong for anything you will look at twice.

## SQLite

No bucket, no endpoint, no credentials — so nothing to scope, rotate or keep
away from model-written code.

```ts
import { sqliteStorage } from "@cloudfarm/sqlite-storage";

sqliteStorage({ path: ".cloudfarm/workspaces.db" });
sqliteStorage({ path: "file:///var/lib/cf/db.sqlite" });
sqliteStorage({ path: ":memory:" });
sqliteStorage({ path: "./db.sqlite", readOnly: true });
```

A missing parent directory is created — SQLite will not, and says only
"unable to open database file" when it matters.

Inside a Durable Object:

```ts
import { sqliteStorage } from "@cloudfarm/sqlite-storage/workers";

export class WorkspaceDO extends DurableObject {
  computer = new Computer({ storage: sqliteStorage({ storage: this.ctx.storage }) });
}
```

## D1

The same package, either through a binding or with credentials from anywhere:

```ts
import { d1Storage } from "@cloudfarm/sqlite-storage/d1";

d1Storage({ database: env.DB }); // inside a Worker
d1Storage({ accountId, databaseId, apiToken }); // anywhere else
```

Both reach the same tables. The credential form is the slowest of the four —
a public HTTPS round trip per statement — and exists so a local script or a CI
job can read what a Worker wrote.

## S3

Any S3-compatible bucket: AWS, R2, MinIO, B2. Signed with `aws4fetch`, so it
runs unchanged on Workers where an AWS SDK would not.

```ts
import { s3 } from "@cloudfarm/s3-storage";

s3({
  bucket: "cloudfarm",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  accessKeyId,
  secretAccessKey,
  prefix: "",
});
```

:::caution
The shell reads the workspace before every command. Over S3 that is one HTTPS
request per file; over SQLite it is one statement. For a workspace of many
small files, that difference is the whole latency budget.
:::

## Layout

Every provider uses the same keys:

```text
<prefix>/<userId>/workspaces/<workspaceId>/<path>
```

The user owns the root folder, so anything of theirs that outlives a single
workspace has somewhere to sit beside `workspaces/`, and a credential scoped
to one user cannot reach another's.
