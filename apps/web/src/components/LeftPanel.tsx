import { useState } from "react";
import type { AppInfo, FileEntry } from "../types.ts";

/**
 * The workspace's own state: what is on disk, and what is installed.
 *
 * Both are things the agent changes while you watch, which is the reason to
 * show them at all — a file appearing here is the clearest evidence that a
 * tool call did what it claimed.
 */
export function LeftPanel({
  files,
  apps,
  onOpenFile,
  openPath,
}: {
  files: FileEntry[];
  apps: AppInfo[];
  onOpenFile: (path: string) => void;
  openPath: string | null;
}) {
  const [tab, setTab] = useState<"files" | "apps">("files");

  return (
    <aside className="panel panel--left">
      <div className="panel__tabs">
        <button
          className={`panel__tab ${tab === "files" ? "is-active" : ""}`}
          onClick={() => setTab("files")}
        >
          Files
        </button>
        <button
          className={`panel__tab ${tab === "apps" ? "is-active" : ""}`}
          onClick={() => setTab("apps")}
        >
          Apps
          <span className="panel__count">{apps.length}</span>
        </button>
      </div>

      <div className="panel__body">
        {tab === "files" && <FileTree files={files} onOpenFile={onOpenFile} openPath={openPath} />}
        {tab === "apps" && <AppList apps={apps} />}
      </div>
    </aside>
  );
}

function FileTree({
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
    return <p className="panel__empty">No files yet. Ask the agent to write one.</p>;
  }

  // The API returns every directory first and then every file, which rendered
  // as two blocks: files appeared under whichever folder happened to be last
  // rather than under their own. Sorting by full path interleaves them, since
  // "/data" < "/data/sales.csv" < "/memory" is exactly tree order.
  const sorted = files.toSorted((a, b) => a.path.localeCompare(b.path));

  const toggle = (path: string) => {
    const next = new Set(collapsed);
    if (!next.delete(path)) next.add(path);
    setCollapsed(next);
  };

  const hidden = (path: string) => [...collapsed].some((folder) => path.startsWith(`${folder}/`));

  return (
    <ul className="tree">
      {sorted.map((entry) => {
        if (hidden(entry.path)) return null;

        const depth = entry.path.split("/").length - 2;
        const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
        const isDir = entry.type === "directory";
        const isCollapsed = collapsed.has(entry.path);

        return (
          <li key={entry.path}>
            <button
              className={`tree__row ${openPath === entry.path ? "is-open" : ""} ${isDir ? "tree__row--dir" : ""}`}
              style={{ paddingLeft: `${8 + depth * 14}px` }}
              onClick={() => (isDir ? toggle(entry.path) : onOpenFile(entry.path))}
            >
              <span className={`tree__icon ${isDir && !isCollapsed ? "is-open" : ""}`}>
                {isDir ? "▸" : "·"}
              </span>
              <span className="tree__name">{name}</span>
              {!isDir && <span className="tree__size">{formatSize(entry.size)}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function AppList({ apps }: { apps: AppInfo[] }) {
  return (
    <ul className="applist">
      {apps.map((app) => (
        <li key={app.id} className="applist__item">
          <div className="applist__head">
            <span className="applist__name">{app.name}</span>
            {app.auth !== "none" && app.auth !== "unknown" && (
              <span className="applist__auth">{app.auth}</span>
            )}
          </div>
          <p className="applist__desc">{app.description}</p>
          <div className="applist__actions">
            {app.actions.map((action) => (
              <code key={action} className="applist__action">
                {action}
              </code>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}b`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}k`;
  return `${(bytes / 1024 / 1024).toFixed(1)}m`;
}
