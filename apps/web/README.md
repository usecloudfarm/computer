# @cloudfarm/web

A chat UI for watching an agent drive a Computer.

The point is not the chat — it is the **tool calls**. Every one the model makes
appears inline, in the order it happened, as a row you can open to see the
exact input it sent and the exact output it got back. A `code` call opens by
default, because a single call carrying a whole script is the one you most
need to read.

```sh
echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" > apps/web/.env
pnpm --filter @cloudfarm/web dev
# web  http://localhost:5173
# api  http://localhost:8787
```

## How it is put together

```
browser ──POST /api/chat──▶ Hono ──▶ streamText ──▶ Claude
                              │                      │
                              └── workspace.tools() ◀┘
```

The Computer lives **only on the server**: the API key, the workspace
filesystem, the bash sandbox and the QuickJS isolate. The browser gets a chat
endpoint and nothing else — handing a Computer to the client would be handing
the client a Computer to drive.

| file                          | what it does                                               |
| ----------------------------- | ---------------------------------------------------------- |
| `server/index.ts`             | Hono, one workspace, `streamText` with `workspace.tools()` |
| `server/reports.ts`           | a real app plugin, so there is a write-shaped action       |
| `src/App.tsx`                 | `useChat`, composer, suggested prompts                     |
| `src/components/Message.tsx`  | parts in order: markdown and tool calls interleaved        |
| `src/components/ToolCall.tsx` | the accordion                                              |

## Notes

- **Markdown is `@pierre/words`** in `streaming` mode, which copes with
  half-written markdown: an unclosed code fence mid-token renders as a code
  block instead of literal backticks that reflow when the next chunk lands.
- **One workspace per process.** A real deployment keys it by user —
  `computer.createWorkspace(userId)` — so two people never share a filesystem.
  Single-user here is deliberate: seeing your own file survive between turns is
  half the demo.
- `/data/sales.csv` is seeded at boot, so the suggested prompts have something
  to work on.
- A failed `run` is a _successful_ tool call carrying `{ status: "error" }`.
  The accordion marks those failed too — otherwise the row reads green while
  the model is looking at an error.
- Swap `reports` for `slack({ apiKey })` in `server/index.ts` and the UI is
  unchanged; that is the plugin boundary doing its job.
