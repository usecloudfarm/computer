import { getToolName, isToolUIPart } from "ai";
import type { UIMessage } from "ai";

export interface HistoryRow {
  /** Matches the DOM id `ToolCall` renders, so a row can scroll to its call. */
  key: string;
  name: string;
  state: string;
  failed: boolean;
  detail: string;
  turn: number;
}

/**
 * Every tool call in the transcript, flattened.
 *
 * Derived from the message list rather than tracked alongside it: the
 * transcript is already the record, and a second copy would be a second thing
 * to keep correct.
 */
export function toHistory(messages: UIMessage[]): HistoryRow[] {
  const rows: HistoryRow[] = [];
  let turn = 0;

  for (const message of messages) {
    if (message.role === "user") turn += 1;
    for (const [index, part] of message.parts.entries()) {
      if (!isToolUIPart(part)) continue;
      const name = getToolName(part);
      rows.push({
        key: `${message.id}-${index}`,
        name,
        state: part.state,
        // A failed `run` is a successful tool call carrying an error
        // envelope, so the dot has to read the body, not just the transport.
        failed: part.state === "output-error" || isErrorEnvelope(part.output),
        detail: describe(name, part.input),
        turn,
      });
    }
  }
  return rows;
}

/** A one-line gist, chosen per tool: enough to tell two calls apart. */
export function describe(name: string, input: unknown): string {
  const record = asRecord(input);
  if (!record) return "";
  if (name === "code" && typeof record["source"] === "string") {
    return `${record["source"].trim().split("\n").length} lines`;
  }
  for (const key of ["ref", "cmd", "command", "path", "useCase", "query", "op"]) {
    const value = record[key];
    if (typeof value === "string") return truncate(value, 56);
  }
  return truncate(JSON.stringify(record), 56);
}

/** A failed `run` is a successful tool call carrying an error envelope. */
export function isErrorEnvelope(output: unknown): boolean {
  return asRecord(output)?.["status"] === "error";
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function truncate(text: string, length: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
