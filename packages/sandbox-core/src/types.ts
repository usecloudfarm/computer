/** A snapshot of a workspace: absolute path -> UTF-8 text contents. */
export type FileMap = Record<string, string>;

/** How strongly a runtime separates guest code from the host process. */
export type IsolationKind =
  /** Guest code runs inside a WebAssembly module: separate memory, no host syscalls. */
  | "wasm"
  /** A separate V8 isolate (own heap, killable, memory-capped). */
  | "v8-isolate"
  /** Interpreted in JavaScript on the host heap: a simulation, not a boundary. */
  | "js-interpreter"
  /** A real host process. Fast and complete, but only as isolated as the OS makes it. */
  | "host-process";

export type Language = "javascript" | "python" | "shell";

/** Events a run emits, in order. Streamed to the client as they happen. */
export type RunEvent =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  /** The value the last expression evaluated to, for runtimes that have one. */
  | { type: "result"; value: string }
  /** Files created, changed or deleted by the run. */
  | { type: "files"; changed: readonly string[] }
  | { type: "error"; message: string; stack?: string }
  | { type: "exit"; code: number; durationMs: number };

export interface RunLimits {
  /** Wall-clock budget for the run. */
  readonly timeoutMs?: number;
  /** Memory ceiling, where the runtime can enforce one. */
  readonly memoryBytes?: number;
}

export interface RunRequest {
  /** Source to execute. */
  readonly code: string;
  /** The workspace to mount before running. */
  readonly files: FileMap;
  /** Where `code` is written in the workspace before it runs. */
  readonly entryPath?: string;
  readonly limits?: RunLimits;
  readonly argv?: readonly string[];
  readonly stdin?: string;
}

export interface RunOutcome {
  /** The workspace after the run, so the caller can diff it back. */
  readonly files: FileMap;
}

export interface RuntimeAvailability {
  readonly ok: boolean;
  /** Why it is unavailable, or what was found when it is. */
  readonly detail?: string;
}

/**
 * One pluggable sandbox. Everything the server and UI know about a runtime
 * comes from this interface, so adding an engine means adding one of these
 * and registering it - nothing else changes.
 */
export interface SandboxRuntime {
  readonly id: string;
  readonly label: string;
  readonly language: Language;
  readonly isolation: IsolationKind;
  /** One line on what this engine is and what it is good for. */
  readonly description: string;
  /** Default path for the entry file, e.g. `/work/main.py`. */
  readonly defaultEntry: string;
  /** Monaco language id for the editor. */
  readonly editorLanguage: string;
  /** Whether this engine can run here, checked at request time. */
  available(): Promise<RuntimeAvailability>;
  /** Executes `request`, calling `emit` for each event as it happens. */
  run(request: RunRequest, emit: (event: RunEvent) => void): Promise<RunOutcome>;
}

export interface CodeSample {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly code: string;
  /** Extra files the sample needs in the workspace. */
  readonly files?: FileMap;
}

export const DEFAULT_LIMITS: Required<RunLimits> = {
  timeoutMs: 10_000,
  memoryBytes: 128 * 1024 * 1024,
};
