# @unsandbox/server

A Hono server that exposes the sandbox runtimes over HTTP, and serves the
studio UI.

```sh
pnpm build                              # build packages + studio
pnpm --filter @unsandbox/server start   # http://localhost:8787
```

In development, run the API and the UI separately so both hot-reload:

```sh
pnpm --filter @unsandbox/server dev     # API on :8787
pnpm --filter @unsandbox/studio dev     # UI on :5273, proxying /api
```

## API

Every request carries an optional `x-session-id` header. A session owns one
in-memory workspace shared by all five runtimes, so a file written by bash is
readable by Python.

| Method   | Path                                  | Does                                                         |
| -------- | ------------------------------------- | ------------------------------------------------------------ |
| `GET`    | `/api/runtimes`                       | Lists runtimes with availability, isolation kind and samples |
| `GET`    | `/api/runtimes/:id/samples/:sampleId` | One sample's source                                          |
| `GET`    | `/api/files`                          | The workspace as a tree plus a flat path→contents map        |
| `GET`    | `/api/file?path=`                     | One file's contents                                          |
| `PUT`    | `/api/file`                           | `{ path, contents }`                                         |
| `DELETE` | `/api/file?path=`                     | Removes a file or directory                                  |
| `POST`   | `/api/workspace/reset`                | Back to the starter files                                    |
| `POST`   | `/api/run`                            | Runs code, streaming SSE                                     |
| `GET`    | `/api/health`                         | Liveness and session count                                   |

### Running code

```sh
curl -N -X POST localhost:8787/api/run \
  -H 'content-type: application/json' \
  -d '{"runtime":"cpython","code":"print(1+1)","timeoutMs":5000}'
```

The response is a server-sent event stream:

```
event: start      {"runtime":"cpython","isolation":"wasm","entryPath":"/work/main.py"}
event: stdout     {"type":"stdout","data":"2\n"}
event: exit       {"type":"exit","code":0,"durationMs":12}
event: workspace  {"changed":["/work/main.py"],"tree":{...}}
event: done       {"changed":1}
```

`result` (the value of the last expression), `error` and `files` events appear
when the runtime produces them.
