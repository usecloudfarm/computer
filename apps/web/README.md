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

| file                            | what it does                                               |
| ------------------------------- | ---------------------------------------------------------- |
| `server/index.ts`               | Hono, one workspace, `streamText` with `workspace.tools()` |
| `server/reports.ts`             | a real app plugin, so there is a write-shaped action       |
| `src/App.tsx`                   | `useChat`, composer, suggested prompts                     |
| `src/components/Message.tsx`    | parts in order: markdown and tool calls interleaved        |
| `src/components/ToolGroup.tsx`  | a run of calls behind one summary row                      |
| `src/components/ToolCall.tsx`   | one call, opened from inside a group                       |
| `src/components/Sidebar.tsx`    | the icon rail and the panel beside it                      |
| `src/components/sections/*`     | one file per section: files, apps, tools, history          |
| `src/components/ui/*`           | shadcn/ui primitives, generated and then owned here        |
| `src/components/FileViewer.tsx` | a file's contents, in a dialog over the thread             |
| `src/lib/history.ts`            | tool calls derived from the transcript                     |

## The sidebar

An icon rail picks a section; one panel beside it shows that section. This
replaced two panels of tabs, one either side of the thread — tabs put every
label on screen at all times and still showed one section, and two columns of
them left the transcript about 500px wide. A rail costs 48px, names its
sections on hover, and keeps the chat the widest thing in the window.

- **Files.** Refetched after each turn, so a file appearing there is the
  clearest evidence a tool call did what it said. Click one to read it.
- **Apps.** What is installed, the computer included, with each action's
  **full ref** — the string you would pass to `run`.
- **Tools.** What the model is actually handed, with its arguments and the
  descriptions it was given. Those descriptions are built from what this
  computer has, so this is also where you check that.
- **History.** Derived from the transcript rather than tracked separately: the
  messages already are the record, and a second copy would be a second thing
  to keep correct. Clicking a row scrolls the thread to that call.

Clicking the open section collapses the panel, the way an activity bar does.
Below 1024px it starts collapsed. There is no title bar: the panel says what
the workspace holds and the transcript says what happened, so a strip
repeating the product name was only taking vertical space — the workspace
square at the top of the rail carries the identity, and its tooltip the model
name.

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
- **A run of calls collapses to one row** — "Worked for 12 seconds · 4 tool
  calls · 2 failed". Four calls as four rows made a turn taller than the
  answer it produced. The group opens itself while the model is working, so
  you can watch, and closes when it settles, so you can read; clicking it
  either way pins your choice. Prose breaks a run, so order is still exactly
  what occurred.
- **No card behind it.** A run of calls is an aside to the answer, and a
  filled, bordered box gave it more weight than the prose it interrupts. The
  summary reads as a line of text; opened, the calls hang off a rule.
- **Duration is measured in the browser.** Message parts carry no timestamps,
  so a group that was already finished on its first render reports no
  duration rather than a made-up one.
- **A history row opens the group it points at.** Scrolling to a call inside
  a collapsed group would find nothing, so the row sets a target and the
  group reveals it — open first, scroll after.
- A failed `run` is a _successful_ tool call carrying `{ status: "error" }`.
  The accordion marks those failed too — otherwise the row reads green while
  the model is looking at an error.
- **shadcn/ui on Tailwind v4.** Components are generated into
  `src/components/ui` and then owned here, so a variant that does not suit a
  dense panel is edited rather than overridden. `components.json` keeps
  `shadcn add` working for the next one.
- Swap `reports` for `slack({ apiKey })` in `server/index.ts` and the UI is
  unchanged; that is the plugin boundary doing its job.
