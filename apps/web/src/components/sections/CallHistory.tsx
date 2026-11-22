import { cn } from "@/lib/utils.ts";
import { Empty } from "./FileTree.tsx";
import type { HistoryRow } from "@/lib/history.ts";

/** Every tool call so far. Rows jump to the call rather than duplicating it. */
export function CallHistory({
  rows,
  onSelect,
}: {
  rows: HistoryRow[];
  onSelect: (key: string) => void;
}) {
  if (rows.length === 0) return <Empty>No tool calls yet.</Empty>;

  return (
    <div className="py-1">
      {rows.map((row) => (
        <button
          key={row.key}
          onClick={() => onSelect(row.key)}
          className={cn(
            "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px]",
            "hover:bg-sidebar-accent focus-visible:ring-sidebar-ring outline-none focus-visible:ring-2",
          )}
        >
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              row.failed
                ? "bg-failed"
                : row.state === "output-available"
                  ? "bg-done"
                  : "bg-running animate-pulse",
            )}
          />
          <span className="text-muted-foreground w-3 shrink-0 text-right font-mono text-[10px] tabular-nums">
            {row.turn}
          </span>
          <code className="shrink-0 text-xs">{row.name}</code>
          <span className="text-muted-foreground truncate font-mono text-[11px]">{row.detail}</span>
        </button>
      ))}
    </div>
  );
}
