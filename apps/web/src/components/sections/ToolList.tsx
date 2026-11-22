import { Empty } from "./FileTree.tsx";
import type { ToolSpecInfo } from "@/types.ts";

/**
 * The tool surface, exactly as the model receives it.
 *
 * Descriptions are prompt text, so reading them here is reading what the
 * model was told — including the parts built from what this computer has.
 */
export function ToolList({ tools }: { tools: ToolSpecInfo[] }) {
  if (tools.length === 0) return <Empty>No tools.</Empty>;

  return (
    <div className="divide-border divide-y">
      {tools.map((tool) => (
        <div key={tool.name} className="px-3 py-3">
          <div className="flex items-center gap-2">
            <code className="text-[13px] font-medium">{tool.name}</code>
            {tool.ref !== tool.name && (
              <span className="text-muted-foreground font-mono text-[10px]">{tool.ref}</span>
            )}
          </div>
          <p className="text-muted-foreground mt-1 line-clamp-4 text-xs leading-relaxed">
            {tool.description}
          </p>
          <div className="mt-2 flex flex-wrap gap-1">
            {Object.keys(tool.inputSchema?.properties ?? {}).map((arg) => (
              <code
                key={arg}
                className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[10px]"
              >
                {/* `?` marks optional, the way the generated .d.ts does. */}
                {arg}
                {tool.inputSchema?.required?.includes(arg) ? "" : "?"}
              </code>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
