---
title: Storage
description: sqlite-storage and s3-storage.
sidebar:
  order: 5
---

Both implement `StorageProvider`: `open(scope) → FileSystem`.
[Choosing storage](/guides/storage/) compares them.

## `@cloudfarm/sqlite-storage`

Four drivers behind one implementation.

```ts
import { sqliteStorage } from "@cloudfarm/sqlite-storage"; // node:sqlite
import { sqliteStorage } from "@cloudfarm/sqlite-storage/workers"; // ctx.storage
import { d1Storage } from "@cloudfarm/sqlite-storage/d1"; // binding or credentials
```

Content is stored in 256 KiB chunks rather than one blob per file: a Durable
Object caps a key and value together at a few megabytes, so a whole-file blob
is a cliff a workspace reaches by saving a CSV.

`SqlDriver` is two methods — `all` and `write` — either of which may return a
promise, so a database reached over the network fits. `write` takes a
statement list rather than a callback, because a Durable Object's
`transactionSync` needs a synchronous body and D1 has no `BEGIN` at all.

## `@cloudfarm/s3-storage`

```ts
import { s3 } from "@cloudfarm/s3-storage";
```

Signed with `aws4fetch` — SigV4 over WebCrypto — so it runs unchanged on Node
and Workers where an AWS SDK would not.
