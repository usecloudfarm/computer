import { z } from "zod";
import { BashInput, CodeInput } from "./tools.js";
import { CodeResult, ExecResult, FileStat } from "./schemas.js";
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
  readonly needs?: "sandbox" | "code";
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
      ref: "code",
      needs: "code",
      definition: define({
        name: "code",
        summary: "Run JavaScript that calls several actions in one pass.",
        useCases: [
          "chain several actions together",
          "do several steps in one call",
          "transform a result before using it",
          "loop over results",
        ],
        keywords: ["javascript", "script", "batch"],
        input: CodeInput,
        output: CodeResult,
        example:
          'run("code", { source: "return run(\\"fs.read\\", { path: \\"/a.txt\\" }).value;" })',
        sideEffects: "write",
      }),
    },
    {
      ref: "fs.read",
      definition: define({
        name: "read",
        summary: "Read a text file from the workspace.",
        useCases: ["read a file", "open a document", "see what is in a file"],
        input: z.object({ path: z.string() }),
        output: z.string(),
        example: 'run("fs.read", { path: "/data/sales.csv" })',
        sideEffects: "read",
      }),
    },
    {
      ref: "fs.write",
      definition: define({
        name: "write",
        summary: "Write a text file to the workspace.",
        useCases: ["write a file", "save a document", "store the result somewhere"],
        input: z.object({ path: z.string(), content: z.string() }),
        output: FileStat,
        example: 'run("fs.write", { path: "/out/summary.md", content: "# Summary" })',
        sideEffects: "write",
      }),
    },
    {
      ref: "fs.list",
      definition: define({
        name: "list",
        summary: "List files in the workspace.",
        useCases: ["list files", "what files are there", "browse a directory"],
        input: z.object({ prefix: z.string().optional() }),
        output: z.array(FileStat),
        example: 'run("fs.list", { prefix: "/data" })',
        sideEffects: "read",
      }),
    },
    {
      ref: "fs.remove",
      definition: define({
        name: "remove",
        summary: "Delete a file or directory from the workspace.",
        useCases: ["delete a file", "remove a directory", "clean up"],
        input: z.object({ path: z.string() }),
        output: z.null(),
        example: 'run("fs.remove", { path: "/tmp/scratch.txt" })',
        sideEffects: "destructive",
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
