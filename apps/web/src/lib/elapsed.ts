import { useEffect, useRef, useState } from "react";

/**
 * How long something has been running, ticking while it is.
 *
 * Measured here rather than taken from the parts, which carry no timestamps.
 * Something already settled on its first render — a reloaded transcript — was
 * never observed running, so it reports null rather than a duration it cannot
 * know. Showing a made-up number would be worse than showing none.
 */
export function useElapsed(pending: boolean): number | null {
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

  // Only while running: a settled duration never changes again.
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [pending]);

  if (startedAt.current === null) return null;
  return (endedAt.current ?? Date.now()) - startedAt.current;
}

/** A duration as a reader wants it: `820ms`, `1.4s`, `2m 05s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}

/**
 * Durations for a run of calls, keyed by index.
 *
 * In `ToolCall` the timer could only start when the row mounted, and a row
 * inside a collapsed group does not mount until you open it — by which time
 * the call has long finished and has no duration to report. The group is
 * mounted the whole time, so it is the one that can watch.
 */
export function useCallDurations(pending: readonly boolean[]): (number | null)[] {
  const marks = useRef<{ started: number; ended: number | null }[]>([]);
  const [, tick] = useState(0);

  // During render, not in an effect: a call can settle in the same commit
  // that first shows it, and an effect would miss the start.
  for (const [i, isPending] of pending.entries()) {
    const mark = marks.current[i];
    if (!mark) {
      marks.current[i] = { started: Date.now(), ended: isPending ? null : Date.now() };
      continue;
    }
    if (!isPending) mark.ended ??= Date.now();
  }

  const anyPending = pending.some(Boolean);
  useEffect(() => {
    if (!anyPending) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [anyPending]);

  return pending.map((isPending, i) => {
    const mark = marks.current[i];
    if (!mark) return null;
    // Settled before this component ever saw it: no duration to claim.
    if (!isPending && mark.ended === mark.started) return null;
    return (mark.ended ?? Date.now()) - mark.started;
  });
}
