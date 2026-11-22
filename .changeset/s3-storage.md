---
"@cloudfarm/s3": minor
"@cloudfarm/core": minor
---

Add `@cloudfarm/s3`: workspace files in any S3-compatible bucket you own —
AWS, R2, MinIO, B2. Signed with `aws4fetch` (SigV4 over WebCrypto), so it runs
unchanged on Node and Workers where an AWS SDK would not.

Each `{ userId, workspaceId }` gets its own key prefix, which is both the
tenant boundary and the thing a scoped credential should be pinned to.

Core gains `Attachment` and an optional `StorageProvider.attachment()`.
`open()` returns an API view — read, write, list — which is what code mode and
the `fs.*` refs use and what you cannot mount: FUSE needs a bucket and
credentials, not a JavaScript object. `ComputerHost` carries both, and
`SandboxCapability` gains `"mount"` so a provider can declare which it can do.

`attachment()` returns `null` unless separate `attachCredentials` are
configured. The credentials reach a machine running model-written code, so
handing over the same keys the host signs with would give a prompt-injected
script the run of the whole bucket.
