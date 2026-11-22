/** What the panels receive from /api/workspace. */

export interface FileEntry {
  path: string;
  size: number;
  mtime: number;
  type: "file" | "directory";
}

export interface AppInfo {
  id: string;
  name: string;
  description: string;
  actions: string[];
  auth: string;
}

export interface ToolSpecInfo {
  name: string;
  ref: string;
  description: string;
  inputSchema?: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface WorkspaceState {
  files: FileEntry[];
  apps: AppInfo[];
  tools: ToolSpecInfo[];
}
