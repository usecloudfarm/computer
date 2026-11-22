import type { DynamicToolUIPart, ToolUIPart } from "ai";

/**
 * `isToolUIPart` narrows to either kind: a tool declared server-side arrives
 * as `tool-<name>`, one resolved at runtime as `dynamic-tool`. They carry the
 * same state machine, so everything here takes both.
 */
export type AnyToolPart = ToolUIPart | DynamicToolUIPart;

/** States where the call has been made but no result exists yet. */
const PENDING: ReadonlySet<AnyToolPart["state"]> = new Set([
  "input-streaming",
  "input-available",
  // Approval states exist for tools gated behind a human yes. Nothing here
  // uses them yet, but leaving them out would make a call read as finished
  // the day something does.
  "approval-requested",
  "approval-responded",
]);

export const LABEL: Record<AnyToolPart["state"], string> = {
  "input-streaming": "calling",
  "input-available": "running",
  "approval-requested": "needs approval",
  "approval-responded": "approved",
  "output-available": "done",
  "output-error": "failed",
  "output-denied": "denied",
};

export function isPending(part: AnyToolPart): boolean {
  return PENDING.has(part.state);
}

/**
 * A failed `run` is a *successful* tool call carrying an error envelope, so
 * this reads the body and not just the transport. Without it a call reads
 * green while the model is looking at an error.
 */
export function hasFailed(part: AnyToolPart): boolean {
  return part.state === "output-error" || isErrorEnvelope(part.output);
}

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
