import { useState } from "react";
import type { DirectoryNode, TreeNode } from "../types.js";

const ICONS: Record<string, string> = {
  js: "JS",
  mjs: "JS",
  ts: "TS",
  py: "PY",
  sh: "SH",
  json: "{}",
  csv: "::",
  md: "MD",
  txt: "··",
};

function iconFor(name: string): string {
  return ICONS[name.split(".").pop() ?? ""] ?? "··";
}

interface RowProps {
  activePath: string | null;
  changed: Set<string>;
  onOpen: (path: string) => void;
  onDelete: (path: string) => void;
}

interface Props extends RowProps {
  tree: DirectoryNode;
}

export function FileTree({ tree, activePath, changed, onOpen, onDelete }: Props) {
  return (
    <div className="tree">
      {tree.children.map((child) => (
        <Row
          key={child.path}
          node={child}
          depth={0}
          activePath={activePath}
          changed={changed}
          onOpen={onOpen}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

function Row({
  node,
  depth,
  activePath,
  changed,
  onOpen,
  onDelete,
}: RowProps & { node: TreeNode; depth: number }) {
  // Workspace directories start open: the tree is small and the point of the
  // explorer here is seeing what a run wrote without hunting for it.
  const [open, setOpen] = useState(depth < 2);
  const indent = 8 + depth * 12;

  if (node.type === "directory") {
    return (
      <>
        <button
          className="tree-row dir"
          style={{ paddingLeft: indent }}
          onClick={() => setOpen(!open)}
          title={node.path}
        >
          <span className="chev">{open ? "▾" : "▸"}</span>
          <span className="label">{node.name}</span>
        </button>
        {open &&
          node.children.map((child) => (
            <Row
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              changed={changed}
              onOpen={onOpen}
              onDelete={onDelete}
            />
          ))}
      </>
    );
  }

  const isActive = node.path === activePath;
  return (
    <button
      className={`tree-row${isActive ? " active" : ""}${changed.has(node.path) ? " changed" : ""}`}
      style={{ paddingLeft: indent + 12 }}
      onClick={() => onOpen(node.path)}
      onAuxClick={(event) => {
        if (event.button === 1) onDelete(node.path);
      }}
      title={`${node.path} — ${node.size} bytes (middle-click to delete)`}
    >
      <span className="chev" style={{ fontSize: 9, color: "var(--text-faint)" }}>
        {iconFor(node.name)}
      </span>
      <span className="label">{node.name}</span>
      <span className="size">{node.size}</span>
    </button>
  );
}
