import { useState } from "react";
import { Files, Blocks, Wrench, History, Moon, Sun, PanelLeftClose } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import { FileTree } from "./sections/FileTree.tsx";
import { AppList } from "./sections/AppList.tsx";
import { ToolList } from "./sections/ToolList.tsx";
import { CallHistory } from "./sections/CallHistory.tsx";
import { cn } from "@/lib/utils.ts";
import { useTheme } from "@/lib/theme.ts";
import type { HistoryRow } from "@/lib/history.ts";
import type { AppInfo, FileEntry, Info, ToolSpecInfo } from "@/types.ts";

type SectionId = "files" | "apps" | "tools" | "history";

interface Section {
  id: SectionId;
  label: string;
  icon: LucideIcon;
  /** What the panel header says under the label — the section in one line. */
  hint: string;
}

const SECTIONS: Section[] = [
  { id: "files", label: "Files", icon: Files, hint: "The workspace filesystem" },
  { id: "apps", label: "Apps", icon: Blocks, hint: "Installed apps and their refs" },
  { id: "tools", label: "Tools", icon: Wrench, hint: "The tool surface the model sees" },
  { id: "history", label: "History", icon: History, hint: "Every tool call this session" },
];

/**
 * A VS Code-shaped sidebar: an icon rail that picks a section, and one panel
 * beside it showing that section.
 *
 * This replaced two panels of tabs, one either side of the thread. Tabs put
 * every section's label on screen at all times and still only showed one, and
 * two columns of them left the thread about 500px wide. A rail costs 48px,
 * names the sections on hover, and keeps the chat the widest thing in the
 * window — which is what you are actually reading.
 */
export function Sidebar({
  files,
  apps,
  tools,
  history,
  info,
  onOpenFile,
  openPath,
  onSelectCall,
}: {
  files: FileEntry[];
  apps: AppInfo[];
  tools: ToolSpecInfo[];
  history: HistoryRow[];
  info: Info | null;
  onOpenFile: (path: string) => void;
  openPath: string | null;
  onSelectCall: (key: string) => void;
}) {
  const [active, setActive] = useState<SectionId>("files");
  // Narrow windows start with the panel closed. The panel is context and the
  // thread is content; 320px of chrome on a 900px window is the wrong trade,
  // and the rail is still there to open it.
  const [open, setOpen] = useState(() => window.innerWidth >= 1024);
  const [theme, toggleTheme] = useTheme();

  const counts: Record<SectionId, number> = {
    // Directories are structure, not content, so the badge counts files.
    files: files.filter((entry) => entry.type === "file").length,
    apps: apps.length,
    tools: tools.length,
    history: history.length,
  };

  const section = SECTIONS.find((candidate) => candidate.id === active) ?? SECTIONS[0]!;

  return (
    <div className="flex shrink-0">
      <nav className="bg-sidebar flex w-12 flex-col items-center gap-1 border-r py-3">
        <WorkspaceBadge info={info} />
        <Separator className="my-2 w-6" />

        {SECTIONS.map((candidate) => (
          <RailButton
            key={candidate.id}
            section={candidate}
            count={counts[candidate.id]}
            active={open && active === candidate.id}
            onClick={() => {
              // Clicking the open section closes the panel, the way an
              // activity bar does — it is the only way back to a full-width
              // thread without a second control.
              if (active === candidate.id && open) setOpen(false);
              else {
                setActive(candidate.id);
                setOpen(true);
              }
            }}
          />
        ))}

        <div className="flex-1" />

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={toggleTheme}
              aria-label={theme === "dark" ? "Switch to light" : "Switch to dark"}
              className="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground grid size-8 place-items-center rounded-md transition-colors"
            >
              {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">
            {theme === "dark" ? "Light theme" : "Dark theme"}
          </TooltipContent>
        </Tooltip>
      </nav>

      {open && (
        <aside className="bg-sidebar flex w-[272px] flex-col border-r">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <h2 className="text-[13px] font-semibold">{section.label}</h2>
                <span className="text-muted-foreground font-mono text-[11px] tabular-nums">
                  {counts[section.id]}
                </span>
              </div>
              <p className="text-muted-foreground truncate text-[11px]">{section.hint}</p>
            </div>
            <button
              onClick={() => setOpen(false)}
              aria-label="Collapse panel"
              className="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground grid size-7 shrink-0 place-items-center rounded-md transition-colors"
            >
              <PanelLeftClose className="size-4" />
            </button>
          </header>

          <ScrollArea className="flex-1">
            <div className="px-1 pb-4">
              {active === "files" && (
                <FileTree files={files} onOpenFile={onOpenFile} openPath={openPath} />
              )}
              {active === "apps" && <AppList apps={apps} />}
              {active === "tools" && <ToolList tools={tools} />}
              {active === "history" && <CallHistory rows={history} onSelect={onSelectCall} />}
            </div>
          </ScrollArea>
        </aside>
      )}
    </div>
  );
}

function RailButton({
  section,
  count,
  active,
  onClick,
}: {
  section: Section;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = section.icon;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          aria-label={section.label}
          aria-current={active}
          className={cn(
            "relative grid size-9 place-items-center rounded-md transition-colors",
            "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            active && "bg-sidebar-accent text-sidebar-accent-foreground",
          )}
        >
          <Icon className="size-[17px]" />
          {active && (
            <span className="bg-sidebar-primary absolute -left-[5px] h-4 w-[2px] rounded-full" />
          )}
        </button>
      </TooltipTrigger>
      {/* The count lives here rather than as a badge on the icon. A rail of
       * four icons each wearing a number is noise, and the panel header shows
       * the same figure the moment the section is open. */}
      <TooltipContent side="right">
        {section.label}
        {count > 0 && <span className="text-background/60"> · {count}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The workspace, as a square at the top of the rail.
 *
 * Borrowed from Slack's workspace switcher: it is not a switcher yet — the
 * playground is single-workspace by design — but it is where the identity
 * belongs, and the tooltip is the only place the model name appears now that
 * the top bar is gone.
 */
function WorkspaceBadge({ info }: { info: Info | null }) {
  const id = info?.workspace ?? "…";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={`Workspace ${id}`}
          className="bg-primary text-primary-foreground grid size-8 shrink-0 place-items-center rounded-lg text-[13px] font-semibold transition-transform hover:scale-105"
        >
          {id.slice(0, 1).toUpperCase()}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">
        <span className="font-medium">{id}</span>
        {info?.model && <span className="text-background/70"> · {info.model}</span>}
      </TooltipContent>
    </Tooltip>
  );
}
