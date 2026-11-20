export type IsolationKind = "wasm" | "v8-isolate" | "js-interpreter" | "host-process";

export interface SampleSummary {
  id: string;
  title: string;
  description: string;
}

export interface RuntimeInfo {
  id: string;
  label: string;
  language: string;
  isolation: IsolationKind;
  description: string;
  defaultEntry: string;
  editorLanguage: string;
  available: boolean;
  detail: string | null;
  samples: SampleSummary[];
}

export interface FileNode {
  type: "file";
  name: string;
  path: string;
  size: number;
}

export interface DirectoryNode {
  type: "directory";
  name: string;
  path: string;
  children: TreeNode[];
}

export type TreeNode = FileNode | DirectoryNode;

export type RunEvent =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "result"; value: string }
  | { type: "files"; changed: string[] }
  | { type: "error"; message: string; stack?: string }
  | { type: "exit"; code: number; durationMs: number };

export interface RunStats {
  code: number | null;
  durationMs: number | null;
  changed: string[];
}
