import type { CapabilityDefinition } from "./ports.js";

/**
 * Capability search, BM25 over four fields.
 *
 * Deliberately lexical rather than embedding-based: a library whose pitch is
 * "bring your own agent" should not force a model dependency on its consumers,
 * and at the scale that matters here — tens to a few hundred capabilities —
 * BM25 over author-written `useCases` beats a generic embedding anyway. It is
 * also deterministic, which makes ranking testable.
 */

export interface IndexedCapability {
  readonly ref: string;
  readonly definition: CapabilityDefinition;
  readonly appId: string;
}

export interface SearchHit {
  readonly ref: string;
  readonly score: number;
}

export interface CapabilityIndex {
  add(entries: readonly IndexedCapability[]): void;
  search(query: string, limit?: number): SearchHit[];
}

/** Field weights: what an author wrote the capability *for* matters most. */
const FIELD_WEIGHTS = { useCases: 3.0, name: 2.5, summary: 1.5, keywords: 1.0 } as const;
const K1 = 1.2;
const B = 0.75;

const STOPWORDS = new Set([
  "a",
  "about",
  "after",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "before",
  "by",
  "can",
  "do",
  "for",
  "from",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "over",
  "please",
  "something",
  "that",
  "the",
  "then",
  "this",
  "to",
  "use",
  "want",
  "what",
  "when",
  "where",
  "which",
  "with",
  "you",
  "your",
]);

/** Query-side only: expanding the index would blur it. */
const SYNONYMS: Record<string, readonly string[]> = {
  email: ["mail", "message", "send"],
  mail: ["email", "message"],
  msg: ["message"],
  dm: ["message", "direct"],
  channel: ["room", "conversation"],
  chat: ["message", "conversation"],
  notify: ["message", "alert", "send"],
  doc: ["document", "file"],
  dir: ["directory", "folder"],
  ls: ["list"],
  run: ["execute", "exec"],
  cmd: ["command", "shell"],
  shell: ["bash", "command"],
};

export function tokenize(text: string): string[] {
  return (
    text
      // Split camelCase first, so a query of "createIssue" matches an indexed
      // "create" + "issue" exactly as the identifier splitter produces them.
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map(stem)
      .filter((token) => token.length > 1 && !STOPWORDS.has(token))
  );
}

/** Light suffix stripping. Not linguistics — just enough to match plurals. */
function stem(token: string): string {
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (token.length > suffix.length + 2 && token.endsWith(suffix)) {
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

/** `sendMessage` also yields `send` and `message`. */
function splitIdentifier(name: string): string[] {
  return tokenize(name);
}

interface Document {
  readonly ref: string;
  readonly fields: Record<keyof typeof FIELD_WEIGHTS, string[]>;
  readonly length: number;
}

export class Bm25CapabilityIndex implements CapabilityIndex {
  #documents: Document[] = [];
  #averageLength = 0;
  readonly #documentFrequency = new Map<string, number>();

  add(entries: readonly IndexedCapability[]): void {
    for (const entry of entries) {
      const fields = {
        useCases: entry.definition.useCases.flatMap(tokenize),
        name: [...splitIdentifier(entry.definition.name), ...tokenize(entry.appId)],
        summary: tokenize(entry.definition.summary),
        keywords: (entry.definition.keywords ?? []).flatMap(tokenize),
      };
      const length = Object.values(fields).reduce((total, tokens) => total + tokens.length, 0);
      this.#documents.push({ ref: entry.ref, fields, length });

      for (const token of new Set(Object.values(fields).flat())) {
        this.#documentFrequency.set(token, (this.#documentFrequency.get(token) ?? 0) + 1);
      }
    }
    this.#averageLength =
      this.#documents.reduce((total, document) => total + document.length, 0) /
      Math.max(this.#documents.length, 1);
  }

  search(query: string, limit = 8): SearchHit[] {
    const exact = query.trim();
    const terms = expand(tokenize(query));
    if (terms.length === 0 && !exact) return [];

    const ranked = this.#documents
      .map((document) => ({ ref: document.ref, score: this.#score(document, terms) }))
      .filter((hit) => hit.score > 0)
      // Sort by score, then ref: iteration order must never decide ranking.
      .toSorted((a, b) => b.score - a.score || a.ref.localeCompare(b.ref));

    // Typing a ref verbatim always wins, whatever BM25 thinks of the rest.
    const exactIndex = ranked.findIndex((hit) => hit.ref === exact);
    if (exactIndex >= 0) ranked.splice(exactIndex, 1);
    if (this.#documents.some((document) => document.ref === exact)) {
      ranked.unshift({ ref: exact, score: 1 });
    }

    return ranked.slice(0, limit);
  }

  #score(document: Document, terms: readonly { token: string; weight: number }[]): number {
    const total = this.#documents.length;
    let score = 0;

    for (const { token, weight } of terms) {
      const frequency = this.#documentFrequency.get(token) ?? 0;
      if (frequency === 0) continue;
      const idf = Math.log(1 + (total - frequency + 0.5) / (frequency + 0.5));

      for (const [field, tokens] of Object.entries(document.fields)) {
        const occurrences = tokens.filter((candidate) => candidate === token).length;
        if (occurrences === 0) continue;
        const fieldWeight = FIELD_WEIGHTS[field as keyof typeof FIELD_WEIGHTS];
        const normalized =
          (occurrences * (K1 + 1)) /
          (occurrences + K1 * (1 - B + (B * document.length) / Math.max(this.#averageLength, 1)));
        score += idf * normalized * fieldWeight * weight;
      }
    }
    return score;
  }
}

/** Query terms plus synonyms at a discount, so expansion never outranks a direct hit. */
function expand(tokens: readonly string[]): { token: string; weight: number }[] {
  const terms = new Map<string, number>();
  for (const token of tokens) {
    terms.set(token, Math.max(terms.get(token) ?? 0, 1));
    for (const synonym of SYNONYMS[token] ?? []) {
      const stemmed = stem(synonym);
      terms.set(stemmed, Math.max(terms.get(stemmed) ?? 0, 0.5));
    }
  }
  return [...terms].map(([token, weight]) => ({ token, weight }));
}
