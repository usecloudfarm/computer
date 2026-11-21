import type { z } from "zod";
import { Bm25ActionIndex, type ActionIndex } from "./search.js";
import type { AppSummary } from "./schemas.js";
import { BUILTIN_APP, type BuiltinAction } from "./builtins.js";
import { NamespaceConflictError, UnknownRefError } from "./errors.js";
import { renderSignature } from "./typegen.js";
import type { App, ActionDefinition } from "./ports.js";
import type { ActionSummary, SideEffects } from "./schemas.js";

/** Namespaces the runtime owns; an app claiming one is a construction-time error. */
export const RESERVED_NAMESPACES = new Set([
  "bash",
  "code",
  "fs",
  "memory",
  "browser",
  "search",
  "run",
  "apps",
]);

export interface RegistryEntry {
  readonly ref: string;
  readonly namespace: string;
  readonly member: string;
  readonly app: App;
  readonly action: ActionDefinition;
}

/**
 * Every action the workspace can reach, indexed once at construction.
 *
 * Building this synchronously and without network matters: a Worker builds a
 * registry per request, so `App.actions()` is required to be static.
 */
export class ActionRegistry {
  readonly #entries = new Map<string, RegistryEntry>();
  readonly #builtins = new Map<string, RegistryEntry>();
  readonly #needs = new Map<string, "sandbox" | "code">();
  readonly #index: ActionIndex;

  constructor(
    apps: readonly App[],
    index: ActionIndex = new Bm25ActionIndex(),
    builtins: readonly BuiltinAction[] = [],
  ) {
    this.#index = index;

    // The computer's own actions are indexed alongside the apps', so `search`
    // can answer "how do I run a shell command?" — it used to return nothing.
    // They are kept out of #entries: dispatch owns them, and a hit here must
    // never route to an app handler.
    for (const builtin of builtins) {
      this.#builtins.set(builtin.ref, {
        ref: builtin.ref,
        namespace: builtin.ref.split(".")[0] ?? builtin.ref,
        member: builtin.definition.name,
        app: { ...BUILTIN_APP, actions: () => [] },
        action: builtin.definition,
      });
      if (builtin.needs) this.#needs.set(builtin.ref, builtin.needs);
    }
    this.#index.add(
      builtins.map((builtin) => ({
        ref: builtin.ref,
        definition: builtin.definition,
        appId: BUILTIN_APP.id,
      })),
    );

    const seen = new Set<string>();

    for (const app of apps) {
      if (RESERVED_NAMESPACES.has(app.id)) throw new NamespaceConflictError(app.id);
      if (seen.has(app.id)) throw new NamespaceConflictError(app.id);
      seen.add(app.id);

      const indexed = app.actions().map((action) => {
        const ref = `${app.id}.${action.name}`;
        this.#entries.set(ref, {
          ref,
          namespace: app.id,
          member: action.name,
          app,
          action,
        });
        return { ref, definition: action, appId: app.id };
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

  /**
   * The installed apps, each with the names of the actions it contributes.
   *
   * Deliberately not scored or ranked: this answers "what is installed", a
   * question with one correct answer, unlike `search` which answers "what is
   * relevant" and can only guess.
   */
  apps(): AppSummary[] {
    const byApp = new Map<string, AppSummary>();
    for (const entry of this.#entries.values()) {
      const existing = byApp.get(entry.app.id);
      if (existing) {
        existing.actions.push(entry.member);
        continue;
      }
      byApp.set(entry.app.id, {
        id: entry.app.id,
        name: entry.app.name,
        description: entry.app.description,
        actions: [entry.member],
        // createApp validates credentials at construction, so an app that
        // reached the registry is usable. This reports which *kind* of scheme
        // it declared, which is the part a reader cannot infer.
        auth: entry.app.auth?.kind ?? "unknown",
      });
    }
    return [...byApp.values()];
  }

  entries(): readonly RegistryEntry[] {
    return [...this.#entries.values()];
  }

  get(ref: string): RegistryEntry {
    const entry = this.#entries.get(ref);
    if (!entry) throw new UnknownRefError(ref, this.#nearest(ref));
    return entry;
  }

  /**
   * `available` decides which built-ins are real right now. The registry is
   * built once per Computer while the sandbox and engine resolve lazily per
   * workspace, so availability cannot be known here — only asked about.
   */
  search(
    query: string,
    limit = 8,
    available: (needs: "sandbox" | "code") => boolean = () => true,
  ): Array<{ entry: RegistryEntry; score: number }> {
    return this.#index
      .search(query, limit)
      .map((hit) => ({
        entry: this.#entries.get(hit.ref) ?? this.#builtins.get(hit.ref)!,
        score: hit.score,
      }))
      .filter((hit) => hit.entry !== undefined && this.#usable(hit.entry.ref, available));
  }

  /** The computer's own actions, for listing beside the installed apps. */
  builtins(available: (needs: "sandbox" | "code") => boolean = () => true): RegistryEntry[] {
    return [...this.#builtins.values()].filter((entry) => this.#usable(entry.ref, available));
  }

  #usable(ref: string, available: (needs: "sandbox" | "code") => boolean): boolean {
    const needs = this.#needs.get(ref);
    return needs === undefined || available(needs);
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
): ActionSummary {
  return {
    ref: entry.ref,
    app: { id: entry.app.id, name: entry.app.name },
    summary: entry.action.summary,
    signature: renderSignature(entry.action),
    example: entry.action.example,
    sideEffects: entry.action.sideEffects as SideEffects,
    auth: authenticated ? "authenticated" : "needs_auth",
    score: Number(score.toFixed(4)),
  };
}

/** Validates against the action's own Zod schema. Host-side only, always. */
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
