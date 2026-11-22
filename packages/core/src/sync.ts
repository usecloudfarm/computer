import type { FileSystem, Sandbox, SandboxFiles } from "./ports.js";

/**
 * Keeping a sandbox's filesystem and the workspace in step.
 *
 * `@cloudfarm/bash-sandbox` shares the workspace because it is a virtual
 * shell in this process: it reads the files in and writes them back itself.
 * A real sandbox cannot — E2B hands you a Firecracker microVM with its own
 * disk — so without this a file written with `>` was invisible to
 * `fs.readFileSync`, and a file written by the host was invisible to `cat`.
 * One computer, two filesystems, no way to tell which one you were looking
 * at.
 *
 * Copying rather than mounting, deliberately. A mount needs an S3-compatible
 * bucket, scoped credentials and a FUSE client in the image — `Attachment`
 * exists for exactly that and is the better answer when all three are true.
 * Copying needs none of them, so it is what every provider and every storage
 * can do, which is the difference between a feature and a configuration.
 */
export class SandboxSync {
  readonly #files: SandboxFiles;
  readonly #fs: FileSystem;
  /** What both sides last agreed on, so a quiet turn costs nothing. */
  readonly #mirror = new Map<string, string>();
  /** Top-level entries the image shipped with: everything else is ours. */
  #baseline: ReadonlySet<string> | undefined;

  constructor(files: SandboxFiles, fs: FileSystem) {
    this.#files = files;
    this.#fs = fs;
  }

  /** Workspace → sandbox. Only what changed since the last agreement. */
  async push(): Promise<void> {
    this.#baseline ??= await this.#topLevel();

    const seen = new Set<string>();
    for await (const entry of this.#fs.list("/")) {
      if (entry.type !== "file" || entry.path.startsWith("/.cloudfarm/")) continue;
      seen.add(entry.path);
      let content: string;
      try {
        content = await this.#fs.readText(entry.path);
      } catch {
        continue; // not UTF-8; the shell could not represent it either
      }
      if (this.#mirror.get(entry.path) === content) continue;
      await this.#files.write(entry.path, content);
      this.#mirror.set(entry.path, content);
    }

    // A file deleted on the host should not come back from the sandbox on
    // the next pull, so remove it there too. Gathered before deleting rather
    // than mutating the map mid-iteration.
    const gone = [...this.#mirror.keys()].filter((path) => !seen.has(path));
    for (const path of gone) {
      await this.#files.remove(path).catch(() => {});
      this.#mirror.delete(path);
    }
  }

  /** Sandbox → workspace, over the directories that are ours to read. */
  async pull(): Promise<void> {
    for (const root of await this.#roots()) {
      let paths: string[];
      try {
        paths = await this.#files.list(root);
      } catch {
        continue;
      }
      for (const path of paths) {
        let content: string;
        try {
          content = await this.#files.read(path);
        } catch {
          continue;
        }
        if (this.#mirror.get(path) === content) continue;
        await this.#fs.write(path, content);
        this.#mirror.set(path, content);
      }
    }
  }

  /**
   * Where to look on the way back.
   *
   * Not `/`: that is a Linux root, and walking it would read the whole image
   * every command. Only the directories the workspace put there, plus any
   * top-level directory that was not in the image — which is how a file the
   * agent writes somewhere new still comes home.
   */
  async #roots(): Promise<string[]> {
    const roots = new Set<string>();
    for (const path of this.#mirror.keys()) {
      const slash = path.indexOf("/", 1);
      roots.add(slash === -1 ? path : path.slice(0, slash));
    }
    for (const entry of await this.#topLevel()) {
      if (!this.#baseline?.has(entry)) roots.add(entry.startsWith("/") ? entry : `/${entry}`);
    }
    return [...roots];
  }

  async #topLevel(): Promise<ReadonlySet<string>> {
    try {
      return new Set(await this.#files.entries("/"));
    } catch {
      return new Set();
    }
  }
}

/** A sandbox that can move files, or `undefined` when it cannot. */
export function syncFor(sandbox: Sandbox, fs: FileSystem): SandboxSync | undefined {
  return sandbox.files ? new SandboxSync(sandbox.files, fs) : undefined;
}
