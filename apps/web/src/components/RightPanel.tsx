import { useState } from "react";
import { getToolName, isToolUIPart } from "ai";
import type { UIMessage } from "ai";
import type { ToolSpecInfo } from "../types.ts";

interface HistoryRow {
  key: string;
  name: string;
  state: string;
  failed: boolean;
  detail: string;
  turn: number;
}

/**
 * What the agent can do, and what it has actually done.
 *
 * The history is derived from the message list rather than tracked
 * separately: the transcript is already the record, and a second copy would
 * be a second thing to keep correct.
 */
export function RightPanel({
  tools,
  messages,
  onSelect,
}: {
  tools: ToolSpecInfo[];
  messages: UIMessage[];
  onSelect: (key: string) => void;
}) {
  const [tab, setTab] = useState<"tools" | "history">("history");
  const history = toHistory(messages);

  return (
    <aside className="panel panel--right">
      <div className="panel__tabs">
        <button
          className={`panel__tab ${tab === "tools" ? "is-active" : ""}`}
          onClick={() => setTab("tools")}
        >
          Tools
          <span className="panel__count">{tools.length}</span>
        </button>
        <button
          className={`panel__tab ${tab === "history" ? "is-active" : ""}`}
          onClick={() => setTab("history")}
        >
          History
          <span className="panel__count">{history.length}</span>
        </button>
      </div>

      <div className="panel__body">
        {tab === "tools" ? (
          <ToolList tools={tools} />
        ) : (
          <History rows={history} onSelect={onSelect} />
        )}
      </div>
    </aside>
  );
}

function ToolList({ tools }: { tools: ToolSpecInfo[] }) {
  return (
    <ul className="toollist">
      {tools.map((tool) => (
        <li key={tool.name} className="toollist__item">
          <div className="toollist__head">
            <code className="toollist__name">{tool.name}</code>
            {tool.ref !== tool.name && <span className="toollist__ref">{tool.ref}</span>}
          </div>
          <p className="toollist__desc">{tool.description}</p>
          <div className="toollist__args">
            {Object.keys(tool.inputSchema?.properties ?? {}).map((arg) => (
              <code key={arg} className="toollist__arg">
                {arg}
                {tool.inputSchema?.required?.includes(arg) ? "" : "?"}
              </code>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

function History({ rows, onSelect }: { rows: HistoryRow[]; onSelect: (key: string) => void }) {
  if (rows.length === 0) {
    return <p className="panel__empty">No tool calls yet.</p>;
  }

  return (
    <ol className="history">
      {rows.map((row) => (
        <li key={row.key}>
          <button className="history__row" onClick={() => onSelect(row.key)}>
            <span className={`history__dot history__dot--${row.failed ? "error" : row.state}`} />
            <span className="history__turn">{row.turn}</span>
            <code className="history__name">{row.name}</code>
            <span className="history__detail">{row.detail}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function toHistory(messages: UIMessage[]): HistoryRow[] {
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

function describe(name: string, input: unknown): string {
  const record =
    typeof input === "object" && input ? (input as Record<string, unknown>) : undefined;
  if (!record) return "";
  if (name === "code" && typeof record["source"] === "string") {
    return `${(record["source"] as string).trim().split("\n").length} lines`;
  }
  for (const key of ["ref", "cmd", "path", "useCase", "query", "op"]) {
    const value = record[key];
    if (typeof value === "string") return value.length > 44 ? `${value.slice(0, 44)}…` : value;
  }
  return "";
}

function isErrorEnvelope(output: unknown): boolean {
  return (
    typeof output === "object" &&
    output !== null &&
    (output as { status?: string }).status === "error"
  );
}
