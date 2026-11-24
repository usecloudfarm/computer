import { useState } from "react";
import { Check, ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { asRecord, hasFailed, isPending, LABEL, truncate } from "@/lib/calls.ts";
import { formatDuration } from "@/lib/elapsed.ts";
import type { AnyToolPart } from "@/lib/calls.ts";

/**
 * One tool call, as a collapsible row.
 *
 * This is the reason the playground exists: you can see *which* tool the model
 * reached for and what it passed. The `code` tool especially — a single call
 * whose input is a whole script — is impossible to judge from a transcript
 * that only shows prose.
 */
export function ToolCall({
  id,
  part,
  name,
  elapsed,
}: {
  id: string;
  part: AnyToolPart;
  name: string;
  /** Measured by the group, which is mounted even while this row is not. */
  elapsed: number | null;
}) {
  // `code` is the interesting one, so it opens itself; the rest stay out of
  // the way until asked for.
  const [open, setOpen] = useState(name === "code");
  const failed = hasFailed(part);
  const pending = isPending(part);
  const source = name === "code" ? codeOf(part.input) : undefined;

  return (
    <div id={id} className="scroll-mt-20">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="hover:bg-muted/60 -mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded px-1 py-1 text-left transition-colors"
      >
        <ChevronRight
          className={cn(
            "text-muted-foreground size-3.5 shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
        <code className="shrink-0 text-xs font-medium">{name}</code>
        <span className="text-muted-foreground truncate font-mono text-[11px]">
          {summarize(name, part)}
        </span>
        <span
          className={cn(
            "ml-auto flex shrink-0 items-center gap-1 font-mono text-[10px] tracking-wide",
            failed ? "text-failed" : pending ? "text-running" : "text-muted-foreground",
          )}
        >
          {pending && <Loader2 className="size-3 animate-spin" />}
          {failed ? (
            <span className="uppercase">failed</span>
          ) : pending ? (
            <span className="uppercase">{LABEL[part.state]}</span>
          ) : (
            <>
              {/* A tick says "done" in less space than the word did, which
                  leaves room for the number that is actually informative. */}
              <Check className="size-3.5" />
              {elapsed !== null && <span>{formatDuration(elapsed)}</span>}
            </>
          )}
        </span>
      </button>

      {open && (
        <div className="space-y-2 py-1.5">
          <Field label="input">
            {typeof source === "string" ? <Code>{source}</Code> : <Code>{pretty(part.input)}</Code>}
          </Field>

          {part.state === "output-available" && (
            <Field label="output">
              <Code>{pretty(part.output)}</Code>
            </Field>
          )}
          {part.state === "output-error" && (
            <Field label="error">
              <Code className="text-failed">{part.errorText}</Code>
            </Field>
          )}
          {pending && <p className="text-muted-foreground text-xs">waiting for the result…</p>}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="text-muted-foreground mb-1 block font-mono text-[10px] tracking-wide uppercase">
        {label}
      </span>
      {children}
    </div>
  );
}

function Code({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <pre
      className={cn(
        "bg-muted/60 max-h-80 overflow-auto rounded-md p-2.5 font-mono text-[11.5px] leading-relaxed",
        className,
      )}
    >
      {children}
    </pre>
  );
}

/**
 * A one-line gist for the collapsed row: the point is to tell calls apart at a
 * glance without opening them.
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

function pretty(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
