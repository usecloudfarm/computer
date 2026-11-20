import { MemoryFileSystem } from "@unsandbox/sandbox-core";
import { STARTER_FILES } from "@unsandbox/runtimes";

/**
 * One in-memory workspace per session id.
 *
 * Sessions are a thin convenience for the playground: the browser sends an
 * id, and every runtime in that session shares one filesystem, so you can
 * write a file with bash and read it with Python.
 */
export class WorkspaceStore {
  readonly #sessions = new Map<string, MemoryFileSystem>();

  get(sessionId: string): MemoryFileSystem {
    let workspace = this.#sessions.get(sessionId);
    if (!workspace) {
      workspace = new MemoryFileSystem(STARTER_FILES);
      this.#sessions.set(sessionId, workspace);
    }
    return workspace;
  }

  reset(sessionId: string): MemoryFileSystem {
    const workspace = new MemoryFileSystem(STARTER_FILES);
    this.#sessions.set(sessionId, workspace);
    return workspace;
  }

  get size(): number {
    return this.#sessions.size;
  }
}
