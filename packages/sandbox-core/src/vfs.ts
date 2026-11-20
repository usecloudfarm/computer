import type { FileMap } from "./types.js";

export interface FileNode {
  readonly type: "file";
  readonly name: string;
  readonly path: string;
  readonly size: number;
}

export interface DirectoryNode {
  readonly type: "directory";
  readonly name: string;
  readonly path: string;
  readonly children: TreeNode[];
}

export type TreeNode = FileNode | DirectoryNode;

/** Normalises any user-supplied path to an absolute, `.`/`..`-free form. */
export function normalizePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return "/" + segments.join("/");
}

export function dirname(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

export function basename(path: string): string {
  const normalized = normalizePath(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

/**
 * A flat, in-memory, text-only filesystem shared by every runtime.
 *
 * Runtimes do not touch this directly: the server hands each run a
 * {@link FileMap} snapshot and applies whatever comes back, which keeps the
 * same workspace usable across engines that have wildly different native
 * filesystems (Emscripten FS, QuickJS globals, a real temp directory).
 */
export class MemoryFileSystem {
  readonly #files = new Map<string, string>();
  /** Directories that exist without holding files, so the UI can show them. */
  readonly #directories = new Set<string>(["/"]);

  constructor(initial: FileMap = {}) {
    for (const [path, contents] of Object.entries(initial)) this.write(path, contents);
  }

  has(path: string): boolean {
    return this.#files.has(normalizePath(path));
  }

  read(path: string): string {
    const normalized = normalizePath(path);
    const contents = this.#files.get(normalized);
    if (contents === undefined) throw new Error(`No such file: ${normalized}`);
    return contents;
  }

  write(path: string, contents: string): void {
    const normalized = normalizePath(path);
    if (normalized === "/") throw new Error("Cannot write to /");
    this.#files.set(normalized, contents);
    for (const dir of ancestors(normalized)) this.#directories.add(dir);
  }

  mkdir(path: string): void {
    const normalized = normalizePath(path);
    this.#directories.add(normalized);
    for (const dir of ancestors(normalized)) this.#directories.add(dir);
  }

  /** Removes a file, or a directory and everything under it. Returns removed paths. */
  remove(path: string): string[] {
    const normalized = normalizePath(path);
    const removed: string[] = [];
    if (this.#files.delete(normalized)) removed.push(normalized);

    const prefix = normalized.endsWith("/") ? normalized : `${normalized}/`;
    for (const candidate of [...this.#files.keys()]) {
      if (candidate.startsWith(prefix)) {
        this.#files.delete(candidate);
        removed.push(candidate);
      }
    }
    for (const dir of [...this.#directories]) {
      if (dir === normalized || dir.startsWith(prefix)) this.#directories.delete(dir);
    }
    this.#directories.add("/");
    return removed;
  }

  rename(from: string, to: string): void {
    const contents = this.read(from);
    this.remove(from);
    this.write(to, contents);
  }

  /** Every file as a plain object, for handing to a runtime. */
  snapshot(): FileMap {
    return Object.fromEntries([...this.#files.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }

  /**
   * Replaces the contents with `next`, returning the paths that differ.
   * Used to apply whatever a run left behind and tell the UI what moved.
   */
  applySnapshot(next: FileMap): string[] {
    const normalized = new Map<string, string>();
    for (const [path, contents] of Object.entries(next))
      normalized.set(normalizePath(path), contents);

    const changed: string[] = [];
    for (const [path, contents] of normalized) {
      if (this.#files.get(path) !== contents) changed.push(path);
    }
    for (const path of this.#files.keys()) {
      if (!normalized.has(path)) changed.push(path);
    }

    this.#files.clear();
    for (const [path, contents] of normalized) this.write(path, contents);
    return changed.sort();
  }

  /** The workspace as a tree, directories first then files, each alphabetical. */
  tree(root = "/"): DirectoryNode {
    const rootPath = normalizePath(root);
    const node: DirectoryNode = {
      type: "directory",
      name: rootPath === "/" ? "/" : basename(rootPath),
      path: rootPath,
      children: [],
    };

    const directories = new Map<string, DirectoryNode>([[rootPath, node]]);
    const ensureDirectory = (path: string): DirectoryNode => {
      const existing = directories.get(path);
      if (existing) return existing;
      const created: DirectoryNode = {
        type: "directory",
        name: basename(path),
        path,
        children: [],
      };
      directories.set(path, created);
      ensureDirectory(dirname(path)).children.push(created);
      return created;
    };

    const prefix = rootPath === "/" ? "/" : `${rootPath}/`;
    for (const dir of [...this.#directories].sort()) {
      if (dir !== rootPath && dir.startsWith(prefix)) ensureDirectory(dir);
    }
    for (const [path, contents] of [...this.#files.entries()].sort()) {
      if (!path.startsWith(prefix)) continue;
      ensureDirectory(dirname(path)).children.push({
        type: "file",
        name: basename(path),
        path,
        size: byteLength(contents),
      });
    }

    for (const dir of directories.values()) sortChildren(dir);
    return node;
  }
}

function sortChildren(node: DirectoryNode): void {
  node.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function ancestors(path: string): string[] {
  const parts = normalizePath(path).split("/").filter(Boolean);
  parts.pop();
  const result = ["/"];
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    result.push(current);
  }
  return result;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
