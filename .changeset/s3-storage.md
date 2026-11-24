---
"@cloudfarm/s3-storage": minor
"@cloudfarm/core": minor
---

Add `@cloudfarm/s3-storage`: workspace files in any S3-compatible bucket you own —
AWS, R2, MinIO, B2. Signed with `aws4fetch` (SigV4 over WebCrypto), so it runs
unchanged on Node and Workers where an AWS SDK would not.

Each `{ userId, workspaceId }` gets its own key prefix, which is both the
tenant boundary and the thing a scoped credential should be pinned to.

Keys are laid out as `<prefix>/<userId>/workspaces/<workspaceId>/`. The user
owns the root folder, so anything of theirs that outlives a single workspace
has somewhere to sit beside `workspaces/`.
