import { useState } from "react";
import type { DynamicToolUIPart, ToolUIPart } from "ai";

/**
 * `isToolUIPart` narrows to either kind: a tool declared server-side arrives
 * as `tool-<name>`, one resolved at runtime as `dynamic-tool`. They carry the
 * same state machine, so the row renders both.
 */
type AnyToolPart = ToolUIPart | DynamicToolUIPart;

/**
 * One tool call, as a collapsible row.
 *
 * This is the reason the playground exists: you can see *which* tool the model
 * reached for and what it passed. The `code` tool especially — a single call
 * whose input is a whole script — is impossible to judge from a transcript
 * that only shows prose.
 */

const LABEL: Record<AnyToolPart["state"], string> = {
  "input-streaming": "calling",
  "input-available": "running",
  // Approval states exist for tools gated behind a human yes. Nothing here
  // uses them yet, but leaving them out would make the row render blank the
  // day something does.
  "approval-requested": "needs approval",
  "approval-responded": "approved",
  "output-available": "done",
  "output-error": "failed",
  "output-denied": "denied",
};

/** States where the call has been made but no result exists yet. */
const PENDING = new Set<AnyToolPart["state"]>([
  "input-streaming",
  "input-available",
  "approval-requested",
  "approval-responded",
]);

export function ToolCall({ part, name }: { part: AnyToolPart; name: string }) {
  // `code` is the interesting one, so it opens itself; the rest stay out of
  // the way until asked for.
  const [open, setOpen] = useState(name === "code");
  const failed = part.state === "output-error" || isErrorEnvelope(part.output);

  return (
    <div className={`tool tool--${failed ? "failed" : part.state}`}>
      <button className="tool__head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`tool__chevron ${open ? "is-open" : ""}`} aria-hidden="true">
          ▸
        </span>
        <span className="tool__name">{name}</span>
        <span className="tool__summary">{summarize(name, part)}</span>
        <span className={`tool__state tool__state--${failed ? "error" : part.state}`}>
          {failed ? "failed" : LABEL[part.state]}
        </span>
      </button>

      {open && (
        <div className="tool__body">
          <Field label="input">
            {name === "code" && typeof codeOf(part.input) === "string" ? (
              <pre className="tool__code">{codeOf(part.input) as string}</pre>
            ) : (
              <pre className="tool__json">{pretty(part.input)}</pre>
            )}
          </Field>

          {part.state === "output-available" && (
            <Field label="output">
              <pre className="tool__json">{pretty(part.output)}</pre>
            </Field>
          )}
          {part.state === "output-error" && (
            <Field label="error">
              <pre className="tool__json tool__json--error">{part.errorText}</pre>
            </Field>
          )}
          {PENDING.has(part.state) && <p className="tool__waiting">waiting for the result…</p>}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="tool__field">
      <span className="tool__label">{label}</span>
      {children}
    </div>
  );
}

/**
 * A one-line gist for the collapsed row, chosen per tool: the point is to tell
 * calls apart at a glance without opening them.
 */
function summarize(name: string, part: AnyToolPart): string {
  const input = asRecord(part.input);
  if (!input) return "";
  if (name === "code") {
    const source = codeOf(part.input);
    return typeof source === "string" ? `${source.trim().split("\n").length} lines` : "";
  }
  for (const key of ["ref", "cmd", "command", "path", "useCase", "query"]) {
    const value = input[key];
    if (typeof value === "string") return truncate(value, 80);
  }
  return truncate(JSON.stringify(input), 80);
}

function codeOf(input: unknown): unknown {
  return asRecord(input)?.["source"] ?? asRecord(input)?.["code"];
}

/** A failed `run` is a successful tool call carrying an error envelope. */
function isErrorEnvelope(output: unknown): boolean {
  return asRecord(output)?.["status"] === "error";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function pretty(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncate(text: string, length: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
}
