import type { z } from "zod";
import { Bm25CapabilityIndex, type CapabilityIndex } from "./search.js";
import { NamespaceConflictError, UnknownRefError } from "./errors.js";
import { renderSignature } from "./typegen.js";
import type { App, CapabilityDefinition } from "./ports.js";
import type { CapabilitySummary, SideEffects } from "./schemas.js";

/** Namespaces the runtime owns; an app claiming one is a construction-time error. */
export const RESERVED_NAMESPACES = new Set([
  "bash",
  "code",
  "fs",
  "memory",
  "browser",
  "search",
  "run",
]);

export interface RegistryEntry {
  readonly ref: string;
  readonly namespace: string;
  readonly member: string;
  readonly app: App;
  readonly capability: CapabilityDefinition;
}

/**
 * Every capability the workspace can reach, indexed once at construction.
 *
 * Building this synchronously and without network matters: a Worker builds a
 * registry per request, so `App.capabilities()` is required to be static.
 */
export class CapabilityRegistry {
  readonly #entries = new Map<string, RegistryEntry>();
  readonly #index: CapabilityIndex;

  constructor(apps: readonly App[], index: CapabilityIndex = new Bm25CapabilityIndex()) {
    this.#index = index;
    const seen = new Set<string>();

    for (const app of apps) {
      if (RESERVED_NAMESPACES.has(app.id)) throw new NamespaceConflictError(app.id);
      if (seen.has(app.id)) throw new NamespaceConflictError(app.id);
      seen.add(app.id);

      const indexed = app.capabilities().map((capability) => {
        const ref = `${app.id}.${capability.name}`;
        this.#entries.set(ref, {
          ref,
          namespace: app.id,
          member: capability.name,
          app,
          capability,
        });
        return { ref, definition: capability, appId: app.id };
      });
      this.#index.add(indexed);
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  has(ref: string): boolean {
    return this.#entries.has(ref);
  }

  entries(): readonly RegistryEntry[] {
    return [...this.#entries.values()];
  }

  get(ref: string): RegistryEntry {
    const entry = this.#entries.get(ref);
    if (!entry) throw new UnknownRefError(ref, this.#nearest(ref));
    return entry;
  }

  search(query: string, limit = 8): Array<{ entry: RegistryEntry; score: number }> {
    return this.#index
      .search(query, limit)
      .map((hit) => ({ entry: this.#entries.get(hit.ref)!, score: hit.score }))
      .filter((hit) => hit.entry !== undefined);
  }

  /** Cheap edit-distance-free suggestions: shared prefix or shared member name. */
  #nearest(ref: string): string[] {
    const [namespace = "", member = ""] = ref.split(".");
    return [...this.#entries.keys()]
      .filter(
        (candidate) => candidate.startsWith(`${namespace}.`) || candidate.endsWith(`.${member}`),
      )
      .slice(0, 5);
  }
}

export function summarize(
  entry: RegistryEntry,
  score: number,
  authenticated: boolean,
): CapabilitySummary {
  return {
    ref: entry.ref,
    app: { id: entry.app.id, name: entry.app.name },
    summary: entry.capability.summary,
    signature: renderSignature(entry.capability),
    example: entry.capability.example,
    sideEffects: entry.capability.sideEffects as SideEffects,
    auth: authenticated ? "authenticated" : "needs_auth",
    score: Number(score.toFixed(4)),
  };
}

/** Validates against the capability's own Zod schema. Host-side only, always. */
export function parseInput<T>(
  schema: z.ZodType<T>,
  args: unknown,
): { ok: true; value: T } | { ok: false; issues: string[] } {
  const parsed = schema.safeParse(args);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    ),
  };
}
