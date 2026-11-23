# @cloudfarm/node-engine

Code mode run with `node`, **inside the sandbox**.

```ts
import { Computer } from "@cloudfarm/core";
import { e2b } from "@cloudfarm/e2b-sandbox";
import { nodeEngine } from "@cloudfarm/node-engine";

new Computer({ provider: e2b({ apiKey }), codeEngine: nodeEngine() });
```

Needs a provider whose sandbox implements `files`. Without one it refuses and
says so; `@cloudfarm/qjs-engine` stays the fallback and the zero-config
default.

## Why

`qjs-engine` evaluates a script in a wasm isolate in this process. That runs
anywhere, which is why it is the default — and it is also why it is small:
64 MiB, no real filesystem, and `fs` only as a shim that turns every read
into a host call.

Here the script runs on the runtime already in the image. Measured against a
live E2B microVM:

| | |
| --- | --- |
| `require("node:fs").constants` | `"REAL node fs"` |
| 50 MB file written locally | 2.2s |
| `Buffer.from([0,159,146,150])` round trip | 4 bytes — binary intact |
| `execSync("python3 -c 'print(6*7)'")` | `"42"` |
| 30M loop iterations | 1.6s |
| one `run()` host call | ~3.2s |

The ceiling stops being the engine and becomes the machine.

**It is not Node-only.** The work happens in the sandbox, so the engine is an
HTTP client — it runs wherever the provider does, Cloudflare Workers
included.

## The two things to know

**The prelude steps aside.** Core normally installs `require`, `fs`, `path`,
`os` and `util` shims. Here they would shadow the real ones, and did in the
first version: a 50 MB write became a host call and a `Buffer` came back as a
string of digits. The engine declares `sandboxed`, and core omits them.

**Host calls are slow, for now.** `run()` crosses two files and a poll
interval, because `exec` is one-way today — giving the guest a pipe means
putting stdin on the port and into every provider. Worth doing; worth doing
after the rest is proven. A script that mostly works on files pays this
once or not at all; one that makes twelve `run()` calls should use
`qjs-engine`.

## Notes

- The script is ESM so top-level `await` works, with `createRequire` for
  `require`, because models write both.
- `run()` is synchronous to the script, same as in the isolate, so one
  dialect covers both engines.
- Guest-side waiting is `Atomics.wait`, which Node allows on the main thread.
  Sleeping by spawning `sleep` instead cost twelve seconds per host call.
- No memory cap and no interrupt: the sandbox's own limits apply, and the
  timeout stops the command.
