import { getToolName, isToolUIPart } from "ai";
import type { UIMessage } from "ai";
import { asRecord, hasFailed, truncate } from "./calls.ts";

export interface HistoryRow {
  /** Matches the DOM id `ToolCall` renders, so a row can reveal its call. */
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
        failed: hasFailed(part),
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

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
