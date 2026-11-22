import { Badge } from "@/components/ui/badge.tsx";
import { Empty } from "./FileTree.tsx";
import type { AppInfo } from "@/types.ts";

/**
 * The apps installed in this workspace, and the refs each one answers to.
 *
 * The refs are the point: they are what `run` takes, and seeing them next to
 * the app makes the indirection in `search` concrete.
 */
export function AppList({ apps }: { apps: AppInfo[] }) {
  if (apps.length === 0) return <Empty>No apps installed.</Empty>;

  return (
    <div className="divide-border divide-y">
      {apps.map((app) => (
        <div key={app.id} className="px-3 py-3">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium">{app.name}</span>
            {app.auth !== "none" && app.auth !== "unknown" && (
              <Badge variant="secondary" className="h-4 px-1.5 font-mono text-[10px]">
                {app.auth}
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{app.description}</p>
          <div className="mt-2 flex flex-wrap gap-1">
            {app.actions.map((action) => (
              <code
                key={action}
                className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[10px]"
              >
                {action}
              </code>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
