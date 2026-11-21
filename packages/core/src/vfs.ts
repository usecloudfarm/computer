import type { FileStat } from "./schemas.js";
import type { FileSystem, StorageProvider } from "./ports.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Absolute, `.`/`..`-free. Everything in a workspace is rooted at `/`. */
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
 * The default workspace filesystem: bytes in a Map.
 *
 * Deliberately small — no permissions, no symlinks, no file descriptors. Those
 * arrive when a backend needs them, not before. Binary-safe because everything
 * is stored as `Uint8Array`.
 */
export class MemoryFileSystem implements FileSystem {
  readonly #files = new Map<string, { data: Uint8Array; mtime: number }>();
  readonly #now: () => number;

  constructor(seed: Record<string, Uint8Array | string> = {}, now: () => number = Date.now) {
    this.#now = now;
    for (const [path, data] of Object.entries(seed)) {
      this.#files.set(normalizePath(path), {
        data: typeof data === "string" ? encoder.encode(data) : data,
        mtime: now(),
      });
    }
  }

  async read(path: string): Promise<Uint8Array> {
    const entry = this.#files.get(normalizePath(path));
    if (!entry) throw new FileNotFoundError(normalizePath(path));
    return entry.data;
  }

  async readText(path: string): Promise<string> {
    return decoder.decode(await this.read(path));
  }

  async write(path: string, data: Uint8Array | string): Promise<FileStat> {
    const normalized = normalizePath(path);
    if (normalized === "/") throw new Error("Cannot write to /");
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    const mtime = this.#now();
    this.#files.set(normalized, { data: bytes, mtime });
    return { path: normalized, size: bytes.byteLength, mtime, type: "file" };
  }

  async *list(prefix = "/"): AsyncIterable<FileStat> {
    const root = normalizePath(prefix);
    const scope = root === "/" ? "/" : `${root}/`;

    const files: FileStat[] = [];
    const directories = new Map<string, number>();

    for (const [path, entry] of this.#files) {
      if (!path.startsWith(scope)) continue;
      files.push({ path, size: entry.data.byteLength, mtime: entry.mtime, type: "file" });

      // Surface every intermediate directory once, so a caller can build a tree.
      let parent = dirname(path);
      while (parent !== "/" && parent.startsWith(scope)) {
        directories.set(parent, Math.max(directories.get(parent) ?? 0, entry.mtime));
        parent = dirname(parent);
      }
    }

    // Directories first, then files, each alphabetical: a stable order that
    // does not depend on insertion sequence.
    for (const [path, mtime] of [...directories].toSorted(([a], [b]) => a.localeCompare(b))) {
      yield { path, size: 0, mtime, type: "directory" };
    }
    for (const file of files.toSorted((a, b) => a.path.localeCompare(b.path))) {
      yield file;
    }
  }

  async stat(path: string): Promise<FileStat | null> {
    const normalized = normalizePath(path);
    const entry = this.#files.get(normalized);
    if (entry) {
      return { path: normalized, size: entry.data.byteLength, mtime: entry.mtime, type: "file" };
    }
    const scope = normalized === "/" ? "/" : `${normalized}/`;
    for (const candidate of this.#files.keys()) {
      if (candidate.startsWith(scope)) {
        return { path: normalized, size: 0, mtime: this.#now(), type: "directory" };
      }
    }
    return null;
  }

  async remove(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const normalized = normalizePath(path);
    if (this.#files.delete(normalized)) return;

    const scope = `${normalized}/`;
    const children = [...this.#files.keys()].filter((candidate) => candidate.startsWith(scope));
    if (children.length === 0) throw new FileNotFoundError(normalized);
    if (!options.recursive) {
      throw new Error(`${normalized} is a directory; pass { recursive: true } to remove it`);
    }
    for (const child of children) this.#files.delete(child);
  }

  async move(from: string, to: string): Promise<void> {
    const source = normalizePath(from);
    const entry = this.#files.get(source);
    if (entry) {
      this.#files.delete(source);
      this.#files.set(normalizePath(to), entry);
      return;
    }
    const scope = `${source}/`;
    const children = [...this.#files.keys()].filter((candidate) => candidate.startsWith(scope));
    if (children.length === 0) throw new FileNotFoundError(source);
    for (const child of children) {
      const moved = this.#files.get(child)!;
      this.#files.delete(child);
      this.#files.set(normalizePath(to) + child.slice(source.length), moved);
    }
  }
}

export class FileNotFoundError extends Error {
  override name = "FileNotFoundError";
  constructor(readonly path: string) {
    super(`No such file: ${path}`);
  }
}

/**
 * The default storage: everything in process memory, nothing survives a
 * restart. Good for tests and single-shot scripts; swap in S3 or a Durable
 * Object for anything that must persist.
 */
export class MemoryStorage implements StorageProvider {
  readonly id = "memory";
  readonly description =
    "An in-memory workspace filesystem. Fast and free, but everything is lost when the process ends.";

  readonly #workspaces = new Map<string, MemoryFileSystem>();
  readonly #seed: Record<string, Uint8Array | string>;

  constructor(options: { seed?: Record<string, Uint8Array | string> } = {}) {
    this.#seed = options.seed ?? {};
  }

  async open(scope: { userId: string; workspaceId: string }): Promise<FileSystem> {
    const key = `${scope.userId}/${scope.workspaceId}`;
    let filesystem = this.#workspaces.get(key);
    if (!filesystem) {
      filesystem = new MemoryFileSystem(this.#seed);
      this.#workspaces.set(key, filesystem);
    }
    return filesystem;
  }
}
