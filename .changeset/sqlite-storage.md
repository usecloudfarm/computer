---
"@cloudfarm/sqlite-storage": minor
"@cloudfarm/core": patch
---

Add `@cloudfarm/sqlite-storage`: workspace files in SQLite, through
`node:sqlite` on Node, a Durable Object's own storage on Workers, or D1.

No bucket, no endpoint and no credentials, so there is nothing to scope or
keep away from model-written code. It also suits the traffic a workspace has:
the shell reads the workspace before every command, which over S3 is one
HTTPS request per file and here is one statement.

Content is stored in 256 KiB chunks rather than one blob per file. A Durable
Object caps a key and value together at a few megabytes — raised twice, with
the docs trailing the runtime — so a whole-file blob is a cliff a workspace
reaches by saving a CSV.

`SqlDriver` is two methods, `all` and `write`, and either may return a
promise — so a database reached over the network fits, which is what `./d1`
is. `write` takes a statement list rather than a callback because neither
platform with an opinion can serve a callback: a Durable Object's
`transactionSync` needs a synchronous body, impossible once a driver call may
be awaited, and D1 has no `BEGIN`, only `batch()`. A chunked write therefore
reaches D1 as one `batch` — one round trip instead of one per chunk, and
atomic.

`d1Storage` takes either shape:

```ts
d1Storage({ database: env.DB }); // the binding, in a Worker
d1Storage({ accountId, databaseId, apiToken }); // the REST API, anywhere
```

Both reach the same tables. The REST form is for running outside Cloudflare,
and it is the slowest of the four: a public HTTPS round trip per statement,
where the binding is an internal hop and the other two are a function call.

It also has to work around JSON. The REST `params` is documented as an array
of strings, and a `Uint8Array` is an object with numeric keys to
`JSON.stringify` rather than an array — so bytes survive neither direction.
That driver writes a chunk as an `X'…'` blob literal in the SQL and reads it
back with `hex()`, which keeps the column a real `BLOB` so the binding can
read what it wrote. `SqlDriver.blobAsHex` is the flag; the local drivers leave
it off and read the blob directly.

The binding driver is covered by a suite that runs under workerd against a
real D1 binding, because what `bind` accepts as a blob is not something a
hand-written double can settle. The REST driver is covered against a real HTTP
server implementing the documented contract, which exercises the URL, the
bearer header, the body shape and `success: false` arriving with HTTP 200.

It attaches to the shell and to code mode without either knowing: `just-bash`
runs over `host.fs` and code mode's `fs` calls the host, so both see one store
and each other's writes.

`path` accepts a filesystem path, a `file:` URL string, a `URL` object or
`":memory:"`, and a missing parent directory is created — SQLite will not, and
reports only "unable to open database file". `readOnly` opens without write
access. URI query parameters are not supported; SQLite needs an open flag for
those that `node:sqlite` does not expose.

`@cloudfarm/core` now exports `FileNotFoundError`, which a storage provider
needs to report a missing file the way the rest of the system expects — code
mode maps it to `ENOENT`.

`MemoryFileSystem.remove("/", { recursive: true })` reported a missing file
instead of clearing the workspace. The scope of `/` was spelled `${path}/`,
giving `//`, which no path starts with; `list` already special-cased it and
`remove` and `move` did not.
