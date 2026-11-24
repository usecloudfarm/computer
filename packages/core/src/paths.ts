/**
 * Where the workspace filesystem appears inside the sandbox.
 *
 * Workspace `/notes.md` is `/data/notes.md` to the shell, and nothing above
 * `/data` belongs to the workspace — that is the shell's own root, and a file
 * written to `/tmp` is scratch that does not outlive the command.
 *
 * A directory rather than `/` because the agent should be able to tell the
 * workspace from the machine it is running on. It began as a constraint —
 * remote sandboxes mounted storage over FUSE, which cannot take `/` — and
 * outlived them because the distinction turned out to be worth keeping on its
 * own.
 */
export const WORKSPACE_ROOT = "/data";

/** Workspace path → sandbox path. */
export function inSandbox(path: string): string {
  return `${WORKSPACE_ROOT}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Sandbox path → workspace path, or undefined if it is not ours. */
export function inWorkspace(path: string): string | undefined {
  const absolute = path.startsWith("/") ? path : `/${path}`;
  if (absolute === WORKSPACE_ROOT) return "/";
  if (!absolute.startsWith(`${WORKSPACE_ROOT}/`)) return undefined;
  return absolute.slice(WORKSPACE_ROOT.length);
}

/**
 * What a path written inside a sandbox means to the workspace.
 *
 * Code mode speaks sandbox paths, so `/data/sales.csv` in a script is
 * `/sales.csv` in storage. Anything outside the root is left alone rather
 * than rejected: a script writing to `/tmp` wants scratch, and gets a corner
 * of the workspace the shell cannot see.
 */
export function fromGuestPath(path: string): string {
  return inWorkspace(path) ?? (path.startsWith("/") ? path : `/${path}`);
}
