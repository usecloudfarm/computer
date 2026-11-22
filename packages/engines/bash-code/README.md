# @cloudfarm/bash-code

Code mode run **inside the bash sandbox**, so a script can `await`.

```ts
import { Computer } from "@cloudfarm/core";
import { bashCode } from "@cloudfarm/bash-code";

const computer = new Computer({ codeEngine: bashCode() });
```

**Node and Bun only.** Nothing resolves this as a default; pass it explicitly.

## Why it exists

`@cloudfarm/quickjs` evaluates a script in an isolate of its own. That runs
anywhere — Workers included — which is why it is the default, and the reason
code mode is synchronous: asyncify suspends the whole wasm stack across a host
call, so a call _returns_ rather than resolving, and `await` is a syntax error
in the eval mode it uses.

`just-bash` already ships QuickJS internally, as its `js-exec` command, backed
by the [`run`](https://www.npmjs.com/package/run) package. It runs the guest in
a **worker thread** and parks it on `Atomics.wait` while the host does async
work on the main thread. That is exactly how `await` becomes possible — and
exactly why this cannot run on workerd, where a Worker cannot spawn threads.

|                       | `@cloudfarm/quickjs`        | `@cloudfarm/bash-code`                 |
| --------------------- | --------------------------- | -------------------------------------- |
| Node / Bun            | ✅                          | ✅                                     |
| Cloudflare Workers    | ✅                          | ❌ (needs worker threads)              |
| `await` in the guest  | ❌                          | ✅                                     |
| Separate compile step | ✅ validates before running | ❌ syntax errors surface at evaluation |
| Interruptible         | ✅ own interrupt handler    | ❌ the timeout stops the worker        |

## The dialect does not change

`job.prelude` is core's, verbatim. Both engines build `run` and `console` on
the same two primitives — `__host` and `__log` — so a script is not written
_for_ an engine, and `await` is something a script **may** use rather than
must:

```js
// Runs on both engines.
run("fs.write", { path: "/out.md", content: "# hi" });
return run("fs.read", { path: "/out.md" }).value;

// Runs only here. Same call, same value.
return (await run("fs.read", { path: "/out.md" })).value;
```

Core reads `capabilities.guestAwait` to decide whether to reject `await`
during validation and what the `code` tool's description claims, so a computer
never forbids what its engine would accept.

## The host bridge is `run()`, and only `run()`

`just-bash` offers host functions as a `tools.a.b()` proxy. The bootstrap
captures it, defines `__host` over it, and then **deletes `tools`**, so `run()`
is the only spelling that exists — `typeof tools` is `"undefined"` in the
guest, and the host throws on any function name the prelude does not use.

The ref travels as an _argument_, never as a property path. `tools.a.b()`
would require every ref to be a chain of valid identifiers, and the first ref
that is not one would split the dialect away from what `run` accepts.

## Notes

- **Results come back through a host call, not stdout.** `js-exec` runs a
  `.js` file as a function body — the shape code mode already has — but
  discards the returned value. An async wrapper reports it instead, and gets
  `await` support in the bargain, since `js-exec` drains pending promises
  before exiting.
- **Line numbers are moved back.** The prelude and the wrapper sit above the
  source, so a raw error says line 16 of a one-line script. The offset is
  known exactly and comes off before the message is reported.
- **`finishResult` is core's.** Logs, the per-call audit trail, the limits the
  bridge hit and the redactor all come from there rather than being
  reassembled — the first draft hand-rolled the shape and silently reported no
  calls and no logs.
- **No separate compile step.** The `CodeEngine` contract makes `validate`
  optional for exactly this case.
