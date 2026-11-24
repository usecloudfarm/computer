# @cloudfarm/rbash

A sandboxed bash interpreter with an in-memory filesystem, written in Rust and
compiled to WebAssembly. No container, no subprocess, no host filesystem — it
starts in about a millisecond and runs wherever wasm does, including Cloudflare
Workers.

```sh
pnpm add @cloudfarm/rbash
```

```ts
import { createShell } from "@cloudfarm/rbash";

const sh = createShell();
sh.writeFile("data.json", '[{"n":1},{"n":5}]');

sh.exec("jq '[.[].n] | add' data.json");
// → { stdout: "6\n", stderr: "", exitCode: 0 }
```

Nothing it does touches your disk. The only filesystem is the one inside the
instance, and it goes away when the instance does.

## What it supports

Pipelines, redirection, loops, functions, heredocs, variables and subshells,
with `awk`, `grep`, `rg`, `sed`, `cut`, `sort`, `uniq`, `tr`, `find`, `tee`,
`xargs`, `diff`, `comm`, `join`, `base64`, `md5sum`, `gzip`, `tar`, `jq`, `yq`,
`xan` (CSV), `sqlite3` and `html-to-markdown`.

It cannot run `npm`, `node` or `python`: there is no process to spawn. If you
need those, you need a container.

```ts
import { loadShell } from "@cloudfarm/rbash";

loadShell().commands(); // every built-in in this build
```

## Files

`writeFile` and `readFile` are UTF-8. Use the byte pair for anything else —
a gzip stream or a tarball does not survive a round trip through a string.

```ts
sh.writeFileBytes("archive.tar.gz", bytes);
const out = sh.readFileBytes("extracted/report.csv");
```

## Network

`curl` and `wget` do not exist until you supply a fetch, and which hosts are
reachable is entirely yours to decide — this asks, it does not route.

```ts
sh.setFetch(async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body === null ? {} : { body: request.body }),
  });
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
  };
});

await sh.execAsync("curl -s https://example.com | html-to-markdown");
```

Note `execAsync`. The interpreter is synchronous, so `exec` has nowhere to
await and a script reaching `curl` there gets "command not found". A run that
needs a response it does not have unwinds and is restarted once the host has
fetched it — which is what lets a synchronous interpreter reach the network
without blocking an isolate.

## Cloudflare Workers

Workers refuses `WebAssembly.compile` on bytes, so the module has to be a
static import that only your bundler can emit:

```ts
import wasmModule from "@cloudfarm/rbash/wasm";
import { createShellForWorkers } from "@cloudfarm/rbash/workers";

const sh = createShellForWorkers(wasmModule);
```

## One shell per run

A shell is cheap. Make one per command and free it: the instance is the only
state, so a fresh one cannot leak a variable or a stray file from the last.

```ts
const Shell = loadShell();
const sh = new Shell();
try {
  sh.exec(script);
} finally {
  sh.free();
}
```

## Using it with an agent

[`@cloudfarm/rbash-sandbox`](../sandboxes/rbash-sandbox#readme) wraps this as a
`SandboxProvider` for [`cloudfarm`](../cloudfarm#readme), which maps the
instance onto a workspace filesystem and routes `curl` through the host's
allowlisted fetch.

## License

MIT.
