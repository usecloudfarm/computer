---
"@unsandbox/runtimes": minor
---

Remove the `dash` runtime. It was the only engine that forked a host process,
so it was the least isolated option by a wide margin; the remaining four all
run in-process or in a worker. `SandboxRuntime` still models `host-process`
isolation for engines that shell out.
