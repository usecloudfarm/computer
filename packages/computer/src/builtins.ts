import { z } from "zod";
import { BashInput } from "./tools.js";
import { ExecResult } from "./schemas.js";
import type { ActionDefinition, App } from "./ports.js";

/**
 * The computer's own actions, described the same way an app's are.
 *
 * `run` means "run something in this computer", and the shell is part of the
 * computer — so `bash` is an action you find with `search` and call with
 * `run`, exactly like `slack.sendMessage`. Before this, built-ins were
 * reachable by ref but invisible to search: asking "how do I run a shell
 * command?" returned nothing, and the only way to learn the ref was to
 * already know it.
 *
 * `fs.*` is deliberately absent too, and for the same reason one level down:
 * the shell already reads, writes and lists, so a second filesystem surface
 * was a second thing for the model to choose between on every file it
 * touched. `cat`, `ls` and a heredoc are the spelling now. The host keeps its
 * own `workspace.fs` — that is an API for the program embedding a Computer,
 * not a surface the model sees.
 *
 * `code` is deliberately absent. It is a tool, and a tool is in context on
 * every request — it never needed `search` to be found, and indexing it put a
 * second way to reach code mode in front of the model: `run("code", { source
 * })` answers `{ status: "ok", value: { outcome, value, … } }`, two nested
 * result shapes with the real value at `value.value`. The tool answers with
 * the `CodeResult` directly.
 *
 * These definitions carry metadata only. Dispatch intercepts every ref here
 * before it reaches an app handler, so the handlers below are unreachable and
 * say so if that ever stops being true.
 */

export const BUILTIN_APP: Omit<App, "actions"> = {
  id: "computer",
  name: "Computer",
  description:
    "The workspace itself: a shell, a filesystem, and a code runner that can call several actions in one pass.",
  allowedHosts: [],
  authorize: (request) => request,
};

export interface BuiltinAction {
  readonly ref: string;
  readonly definition: ActionDefinition;
  /** Which optional package has to be installed for this to work. */
  readonly needs?: "sandbox";
}

export function builtinActions(): BuiltinAction[] {
  return [
    {
      ref: "bash",
      needs: "sandbox",
      definition: define({
        name: "bash",
        summary: "Run a shell command in the workspace.",
        useCases: [
          "run a shell command",
          "use the terminal",
          "list files on disk",
          "process text with grep sed or awk",
          "count lines in a file",
          "run a script",
        ],
        keywords: ["shell", "terminal", "command", "sh", "cli"],
        input: BashInput,
        output: ExecResult,
        example: 'run("bash", { cmd: "ls -la /data" })',
        sideEffects: "write",
      }),
    },
    {
      ref: "apps.list",
      definition: define({
        name: "list",
        summary: "List the apps installed in this workspace and what each can do.",
        useCases: ["what apps are installed", "what can you do", "what is available"],
        input: z.object({}),
        output: z.object({ apps: z.array(z.unknown()) }),
        example: 'run("apps.list", {})',
        sideEffects: "read",
      }),
    },
  ];
}

function define(
  spec: Omit<ActionDefinition, "handler"> & { input: z.ZodType; output: z.ZodType },
): ActionDefinition {
  return {
    ...spec,
    handler: () => {
      // Reaching this means #dispatch stopped intercepting a built-in
      // namespace and sent it down the app path instead.
      throw new Error(
        `"${spec.name}" is a built-in: it is dispatched by the workspace, not by an app handler.`,
      );
    },
  };
}
