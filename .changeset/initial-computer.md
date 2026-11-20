---
"@cloudfarm/core": minor
"@cloudfarm/bash": minor
"@cloudfarm/quickjs": minor
"@cloudfarm/ai": minor
"@cloudfarm/slack": minor
---

Computer: a workspace for an agent, with a filesystem, a shell, app plugins and
code mode. Core is isomorphic across Node and Cloudflare Workers; capability
schemas are Zod, and code mode runs in a QuickJS WebAssembly isolate with
synchronous host calls.
