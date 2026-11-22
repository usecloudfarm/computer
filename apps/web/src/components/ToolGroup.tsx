import { useEffect, useRef, useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import { getToolName } from "ai";
import { ToolCall } from "./ToolCall.tsx";
import { cn } from "@/lib/utils.ts";
import { hasFailed, isPending } from "@/lib/calls.ts";
import type { AnyToolPart } from "@/lib/calls.ts";

export interface GroupedCall {
  part: AnyToolPart;
  index: number;
}

/** What `onSelectCall` sends down. A fresh object each time, so clicking the
 * same history row twice reveals it twice. */
export interface Reveal {
  key: string;
}

/**
 * A run of tool calls behind one summary row.
 *
 * Each call used to be its own row in a shared card, which made a turn that
 * used the shell four times taller than the answer it produced. Collapsed,
 * the transcript reads as prose again; the summary says enough to know
 * whether it is worth opening — how long it took, how many calls, and how
 * many of them failed.
 */
export function ToolGroup({
  messageId,
  calls,
  reveal,
}: {
  messageId: string;
  calls: GroupedCall[];
  reveal: Reveal | null;
}) {
  const pending = calls.some(({ part }) => isPending(part));
  const failed = calls.filter(({ part }) => hasFailed(part)).length;

  const [open, setOpen] = useState(pending);
  // Once you have taken a position on this group, it keeps it. Otherwise the
  // auto-collapse below would shut a group you had deliberately opened.
  const touched = useRef(false);
  const elapsed = useElapsed(pending);

  // Open while the model is working, closed once it is done — the live view
  // is worth seeing and the finished one is worth getting out of the way.
  useEffect(() => {
    if (!touched.current) setOpen(pending);
  }, [pending]);

  // A history row points at one call, which is inside this group and may be
  // hidden. Opening first and scrolling after is the only order that works:
  // a collapsed group has no element to scroll to.
  const wanted = reveal && calls.some(({ index }) => `${messageId}-${index}` === reveal.key);
  useEffect(() => {
    if (!wanted || !reveal) return;
    touched.current = true;
    setOpen(true);
    const frame = requestAnimationFrame(() => {
      document
        .getElementById(`call-${reveal.key}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [wanted, reveal]);

  return (
    // No card. A run of calls is an aside to the answer, and a filled, bordered
    // box gave it more visual weight than the prose it interrupts. The summary
    // reads as a line of text; the calls hang off a rule when opened.
    <div>
      <button
        onClick={() => {
          touched.current = true;
          setOpen(!open);
        }}
        aria-expanded={open}
        className="group text-muted-foreground hover:text-foreground -ml-1 flex max-w-full items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors"
      >
        <ChevronRight
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
        />
        {pending && <Loader2 className="text-running size-3.5 shrink-0 animate-spin" />}
        <span className="truncate text-xs">
          {pending ? workingLabel(elapsed) : workedLabel(elapsed)}
          <Dot />
          {calls.length} tool call{calls.length === 1 ? "" : "s"}
          {failed > 0 && (
            <>
              <Dot />
              <span className="text-failed">{failed} failed</span>
            </>
          )}
        </span>
        {/* The names, so a collapsed group still says what it did. */}
        {!open && (
          <span className="hidden shrink truncate font-mono text-[10px] opacity-60 sm:block">
            {[...new Set(calls.map(({ part }) => getToolName(part)))].join(" ")}
          </span>
        )}
      </button>

      {open && (
        <div className="border-border mt-1 ml-[7px] space-y-1 border-l pl-3">
          {calls.map(({ part, index }) => (
            <ToolCall
              key={index}
              id={`call-${messageId}-${index}`}
              part={part}
              name={getToolName(part)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Dot() {
  return <span className="px-1.5 opacity-40">·</span>;
}

function workingLabel(elapsed: number | null): string {
  return elapsed === null ? "Working" : `Working for ${seconds(elapsed)}`;
}

function workedLabel(elapsed: number | null): string {
  // A group already finished when it first rendered was never timed, and a
  // guess would read as fact. Sub-second runs round to "0 seconds", which is
  // worse than saying nothing.
  return elapsed === null || elapsed < 1000 ? "Worked" : `Worked for ${seconds(elapsed)}`;
}

function seconds(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} second${total === 1 ? "" : "s"}`;
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

/**
 * How long this group has been running, ticking while it is.
 *
 * Measured here rather than taken from the parts, which carry no timestamps.
 * A group that was already settled on its first render was never observed
 * running, so it reports null instead of a duration it cannot know.
 */
function useElapsed(pending: boolean): number | null {
  const startedAt = useRef<number | null>(pending ? Date.now() : null);
  const endedAt = useRef<number | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    if (pending) {
      startedAt.current ??= Date.now();
      endedAt.current = null;
    } else if (startedAt.current !== null) {
      endedAt.current ??= Date.now();
    }
  }, [pending]);

  // Only while running: a settled group's label never changes again.
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [pending]);

  if (startedAt.current === null) return null;
  return (endedAt.current ?? Date.now()) - startedAt.current;
}
