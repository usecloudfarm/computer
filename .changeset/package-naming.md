---
"@cloudfarm/qjs-engine": major
"@cloudfarm/bash-sandbox": major
"@cloudfarm/e2b-sandbox": major
"@cloudfarm/boat-sandbox": major
"@cloudfarm/agent37-sandbox": major
"@cloudfarm/s3-storage": major
"@cloudfarm/ai-sdk-toolset": major
---

Renamed so a package name says what it is.

| was                  | is                           |
| -------------------- | ---------------------------- |
| `@cloudfarm/qjs`     | `@cloudfarm/qjs-engine`      |
| `@cloudfarm/bash`    | `@cloudfarm/bash-sandbox`    |
| `@cloudfarm/e2b`     | `@cloudfarm/e2b-sandbox`     |
| `@cloudfarm/boat`    | `@cloudfarm/boat-sandbox`    |
| `@cloudfarm/agent37` | `@cloudfarm/agent37-sandbox` |
| `@cloudfarm/s3`      | `@cloudfarm/s3-storage`      |
| `@cloudfarm/ai`      | `@cloudfarm/ai-sdk-toolset`  |

The convention: anything passed to `new Computer()` is `<what>-<role>`, where
the role is the option it fills — `-sandbox` for `provider`, `-engine` for
`codeEngine`, `-storage` for `storage`, `-toolset` for `toolset`. Apps the
agent calls keep their bare service name: `@cloudfarm/slack`,
`@cloudfarm/firecrawl`, `@cloudfarm/hackernews`,
`@cloudfarm/cloudflare-browser`. The absence of a role is itself the signal.

`@cloudfarm/core` and `@cloudfarm/vercel-sandbox` are unchanged; the latter
already followed the convention, which is where it came from.

Only names move. No exports, options or behaviour change.
