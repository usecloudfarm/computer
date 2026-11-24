---
title: The filesystem
description: One store, two paths, and why the agent sees /data.
---

The workspace filesystem is the agent's memory. It is also the clearest
evidence a tool call did what it claimed.

## Two views of one store

| Seen from                     | `notes.md` is                         |
| ----------------------------- | ------------------------------------- |
| your program (`workspace.fs`) | `/notes.md`                           |
| the shell and code mode       | `/data/notes.md`                      |
| storage (S3 key, SQLite row)  | `…/<userId>/workspaces/<id>/notes.md` |

They are the same bytes. The agent works under `/data` because a sandbox needs
somewhere that is _the workspace_ as distinct from the machine around it:
`/tmp`, `/bin` and the rest belong to the shell and do not survive the command.

```ts
await workspace.fs.write("/sales.csv", "region,amount\nemea,1200\n");
await workspace.exec("awk -F, 'NR>1{s+=$2} END{print s}' /data/sales.csv");
// → 1200
```

:::caution
Anything the shell writes outside `/data` is scratch. `> /tmp/out` works and
then vanishes, because only `/data` is backed by storage.
:::

## The API

```ts
interface FileSystem {
  read(path): Promise<Uint8Array>;
  readText(path): Promise<string>;
  write(path, data: Uint8Array | string): Promise<FileStat>;
  list(prefix?): AsyncIterable<FileStat>;
  stat(path): Promise<FileStat | null>;
  remove(path, { recursive }): Promise<void>;
  move(from, to): Promise<void>;
}
```

Directories are not stored. They are implied by separators in a path and
synthesised in `list` and `stat`, which is why `write("/a/b/c.txt")` needs no
`mkdir`.

## Large values

An action that would return a wall of text parks it in the workspace and hands
back a pointer instead, so a 200 KB page does not land in the context window:

```json
{ "$ref": "/.cloudfarm/output/run-12.txt", "bytes": 204_800, "preview": "…" }
```

Shell output is clamped the same way, with the full text spilled to a file the
agent can read in pieces.
