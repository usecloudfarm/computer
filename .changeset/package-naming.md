---
"@cloudfarm/qjs-engine": major
"@cloudfarm/bash-sandbox": major
"@cloudfarm/s3-storage": major
"@cloudfarm/ai-sdk-toolset": major
---

Renamed so a package name says what it is.

| was               | is                          |
| ----------------- | --------------------------- |
| `@cloudfarm/qjs`  | `@cloudfarm/qjs-engine`     |
| `@cloudfarm/bash` | `@cloudfarm/bash-sandbox`   |
| `@cloudfarm/s3`   | `@cloudfarm/s3-storage`     |
| `@cloudfarm/ai`   | `@cloudfarm/ai-sdk-toolset` |

The convention: a package is `<what>-<role>`, where the role says what it
implements — `-sandbox` for the shell, `-engine` for code mode, `-storage` for
the filesystem, `-toolset` for the tool surface. Apps the
agent calls keep their bare service name: `@cloudfarm/slack`,
`@cloudfarm/firecrawl`, `@cloudfarm/hackernews`,
`@cloudfarm/cloudflare-browser`. The absence of a role is itself the signal.

`@cloudfarm/computer` is unchanged.

Only names move. No exports, options or behaviour change.
