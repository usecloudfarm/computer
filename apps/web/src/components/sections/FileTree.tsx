import { useState } from "react";
import { ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { formatSize } from "@/lib/history.ts";
import type { FileEntry } from "@/types.ts";

/**
 * What is on disk, as a collapsible tree.
 *
 * A file appearing here is the clearest evidence a tool call did what it
 * claimed, which is the reason the panel exists at all.
 */
export function FileTree({
  files,
  onOpenFile,
  openPath,
}: {
  files: FileEntry[];
  onOpenFile: (path: string) => void;
  openPath: string | null;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  if (files.length === 0) {
    return <Empty>No files yet. Ask the agent to write one.</Empty>;
  }

  // The API returns every directory first and then every file, which rendered
  // as two blocks: files appeared under whichever folder happened to be last
  // rather than under their own. Sorting by full path interleaves them, since
  // "/data" < "/data/sales.csv" < "/out" is exactly tree order.
  const sorted = files.toSorted((a, b) => a.path.localeCompare(b.path));

  const toggle = (path: string) => {
    const next = new Set(collapsed);
    if (!next.delete(path)) next.add(path);
    setCollapsed(next);
  };

  const hidden = (path: string) => [...collapsed].some((folder) => path.startsWith(`${folder}/`));

  return (
    <div className="py-1">
      {sorted.map((entry) => {
        if (hidden(entry.path)) return null;

        const depth = entry.path.split("/").length - 2;
        const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
        const isDir = entry.type === "directory";
        const isOpen = isDir && !collapsed.has(entry.path);

        return (
          <button
            key={entry.path}
            style={{ paddingLeft: `${8 + depth * 12}px` }}
            onClick={() => (isDir ? toggle(entry.path) : onOpenFile(entry.path))}
            className={cn(
              "group flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-[13px]",
              "hover:bg-sidebar-accent focus-visible:ring-sidebar-ring outline-none focus-visible:ring-2",
              openPath === entry.path && "bg-sidebar-accent font-medium",
            )}
          >
            {isDir ? (
              <>
                <ChevronRight
                  className={cn(
                    "text-muted-foreground size-3 shrink-0 transition-transform",
                    isOpen && "rotate-90",
                  )}
                />
                {isOpen ? (
                  <FolderOpen className="size-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
                ) : (
                  <Folder className="size-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
                )}
              </>
            ) : (
              // Files sit where a folder's chevron would be, so names in the
              // same directory still line up.
              <>
                <span className="size-3 shrink-0" />
                <File className="text-muted-foreground size-3.5 shrink-0" />
              </>
            )}
            <span className="truncate">{name}</span>
            {!isDir && (
              <span className="text-muted-foreground ml-auto shrink-0 font-mono text-[10px] tabular-nums">
                {formatSize(entry.size)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground px-3 py-6 text-[13px] leading-relaxed">{children}</p>;
}
