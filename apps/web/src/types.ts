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

/** Where the files in the panel actually live. */
export interface StorageInfo {
  id: string;
  description: string;
  /** Set when the storage is something you could go and look at. */
  location?: string;
}

export interface WorkspaceState {
  files: FileEntry[];
  apps: AppInfo[];
  tools: ToolSpecInfo[];
  storage?: StorageInfo;
}

/** What /api/info returns: enough to name what you are talking to. */
export interface Info {
  model: string;
  workspace: string;
}
