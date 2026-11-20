# @unsandbox/runtimes

Four sandbox engines behind one interface, plus the code samples the studio
shows for each.

| Runtime    | id        | Isolation        | What it is                                                                       |
| ---------- | --------- | ---------------- | -------------------------------------------------------------------------------- |
| QuickJS    | `quickjs` | `wasm`           | QuickJS compiled to WebAssembly. Hard memory cap, interruptible, no host access. |
| V8 isolate | `v8`      | `v8-isolate`     | Node's own V8 in a worker thread: full speed, killable, weaker boundary.         |
| CPython    | `cpython` | `wasm`           | Real CPython 3.14 via Pyodide. Full stdlib and genuine tracebacks.               |
| bash       | `bash`    | `js-interpreter` | `just-bash`: bash reimplemented in TypeScript over a virtual filesystem.         |

The `isolation` field is the honest part of this table. Only `wasm` and
`v8-isolate` are boundaries; `js-interpreter` is a simulation on the host
heap. The UI shows this per runtime so a comparison never implies safety it
does not have. The contract still models `host-process` for engines that
shell out, but nothing here uses it.

## Adding a runtime

Implement `SandboxRuntime` from `@unsandbox/sandbox-core` and add it to
`ALL_RUNTIMES`. Nothing else changes - the server lists it, the UI renders it,
and the sample picker reads `SAMPLES[id]`.

```ts
export const myRuntime: SandboxRuntime = {
  id: "my-engine",
  label: "My engine",
  language: "javascript",
  isolation: "wasm",
  description: "…",
  defaultEntry: "/work/main.js",
  editorLanguage: "javascript",
  available: async () => ({ ok: true }),
  run: async (request, emit) => {
    emit({ type: "stdout", data: "hi\n" });
    emit({ type: "exit", code: 0, durationMs: 1 });
    return { files: request.files };
  },
};
```

## Execution model

QuickJS, V8 and CPython run inside a **warm worker per engine**
(`worker-pool.ts`). That is deliberate:

- **Warm**: Pyodide loads once (~1s) and is reused, so runs after the first
  are milliseconds.
- **Killable**: all three execute synchronously. On the main thread a
  `while (true)` would block the HTTP server and no timeout could ever fire.
  In a worker the host stays responsive and terminates the thread, which is
  the only dependable way to stop synchronous wasm. The engine is respawned
  on the next run, so a runaway guest costs one cold start.

`bash` runs in-process with iteration caps, since `just-bash` has no wall
clock of its own.

## Workspace

Every runtime mounts the same text-only workspace at `/work` and returns it
afterwards, so the server can diff what changed. The shell runtime gets
`/work` as its working directory, which is why the shell samples use paths
relative to it.
