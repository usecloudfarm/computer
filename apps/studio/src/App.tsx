import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { api, runCode, sessionId } from "./api.js";
import { FileTree } from "./components/FileTree.js";
import { Terminal, type TerminalHandle } from "./components/Terminal.js";
import type { DirectoryNode, RunEvent, RunStats, RuntimeInfo } from "./types.js";

const ANSI = {
  dim: "\u001b[90m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
  magenta: "\u001b[35m",
  bold: "\u001b[1m",
  reset: "\u001b[0m",
};

const GLYPHS: Record<string, string> = {
  quickjs: "◆",
  v8: "▲",
  cpython: "●",
  bash: "❯",
  dash: "❯",
};

const ISOLATION_LABEL: Record<string, string> = {
  wasm: "wasm",
  "v8-isolate": "v8 isolate",
  "js-interpreter": "js interp",
  "host-process": "host proc",
};

export default function App() {
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [runtimeId, setRuntimeId] = useState<string>("");
  const [sampleId, setSampleId] = useState<string>("hello");
  const [tree, setTree] = useState<DirectoryNode | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [openContents, setOpenContents] = useState<string>("");
  const [code, setCode] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState<RunStats>({ code: null, durationMs: null, changed: [] });
  const [panelTab, setPanelTab] = useState<"output" | "about">("output");
  const [error, setError] = useState<string | null>(null);
  const [panelHeight, setPanelHeight] = useState(240);

  const terminalRef = useRef<TerminalHandle | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const runtime = useMemo(
    () => runtimes.find((candidate) => candidate.id === runtimeId),
    [runtimes, runtimeId],
  );
  const changedSet = useMemo(() => new Set(stats.changed), [stats.changed]);

  const onTerminalReady = useCallback((handle: TerminalHandle) => {
    terminalRef.current = handle;
    handle.write(
      `${ANSI.dim}unsandbox studio — pick a runtime, press ${ANSI.reset}${ANSI.bold}⌘↵${ANSI.reset}${ANSI.dim} to run.${ANSI.reset}\r\n`,
    );
  }, []);

  // --- bootstrap -----------------------------------------------------------

  useEffect(() => {
    void (async () => {
      try {
        const [{ runtimes: list }, files] = await Promise.all([api.runtimes(), api.files()]);
        setRuntimes(list);
        setTree(files.tree);
        const first = list.find((candidate) => candidate.available) ?? list[0];
        if (first) setRuntimeId(first.id);
      } catch (cause) {
        setError((cause as Error).message);
      }
    })();
  }, []);

  // Load the selected sample whenever the runtime or sample changes.
  useEffect(() => {
    if (!runtime) return;
    const wanted = runtime.samples.some((sample) => sample.id === sampleId)
      ? sampleId
      : (runtime.samples[0]?.id ?? "");
    if (!wanted) return;
    if (wanted !== sampleId) {
      setSampleId(wanted);
      return;
    }
    void (async () => {
      try {
        const { sample } = await api.sample(runtime.id, wanted);
        setCode(sample.code);
        setOpenPath(null);
        setDirty(false);
      } catch (cause) {
        setError((cause as Error).message);
      }
    })();
  }, [runtime, sampleId]);

  // --- actions -------------------------------------------------------------

  const refreshTree = useCallback(async () => {
    try {
      setTree((await api.files()).tree);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, []);

  const openFile = useCallback(async (path: string) => {
    try {
      const { contents } = await api.readFile(path);
      setOpenPath(path);
      setOpenContents(contents);
      setCode(contents);
      setDirty(false);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, []);

  const saveOpenFile = useCallback(async () => {
    if (!openPath) return;
    try {
      await api.writeFile(openPath, code);
      setOpenContents(code);
      setDirty(false);
      await refreshTree();
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, [openPath, code, refreshTree]);

  const deleteFile = useCallback(
    async (path: string) => {
      try {
        await api.deleteFile(path);
        if (path === openPath) {
          setOpenPath(null);
          setOpenContents("");
        }
        await refreshTree();
      } catch (cause) {
        setError((cause as Error).message);
      }
    },
    [openPath, refreshTree],
  );

  const resetWorkspace = useCallback(async () => {
    try {
      setTree((await api.resetWorkspace()).tree);
      setStats({ code: null, durationMs: null, changed: [] });
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
    terminalRef.current?.write(`${ANSI.yellow}■ stopped by user${ANSI.reset}\r\n`);
  }, []);

  const run = useCallback(async () => {
    const terminal = terminalRef.current;
    if (!runtime || !terminal || running) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setPanelTab("output");
    setStats({ code: null, durationMs: null, changed: [] });
    terminal.clear();

    const entryPath = openPath ?? runtime.defaultEntry;
    terminal.write(
      `${ANSI.dim}$ ${ANSI.reset}${ANSI.cyan}${runtime.label}${ANSI.reset}${ANSI.dim} run ${entryPath}${ANSI.reset}\r\n`,
    );

    await runCode(
      { runtime: runtime.id, code, entryPath },
      {
        onStart: () => {},
        onEvent: (event: RunEvent) => {
          switch (event.type) {
            case "stdout":
              terminal.write(event.data.replace(/\n/g, "\r\n"));
              return;
            case "stderr":
              terminal.write(`${ANSI.red}${event.data.replace(/\n/g, "\r\n")}${ANSI.reset}`);
              return;
            case "result":
              terminal.write(`${ANSI.magenta}⇒ ${event.value}${ANSI.reset}\r\n`);
              return;
            case "error":
              terminal.write(
                `${ANSI.red}✗ ${(event.stack ?? event.message).replace(/\n/g, "\r\n")}${ANSI.reset}\r\n`,
              );
              return;
            case "files":
              terminal.write(`${ANSI.dim}· wrote ${event.changed.join(", ")}${ANSI.reset}\r\n`);
              return;
            case "exit":
              setStats((previous) => ({
                ...previous,
                code: event.code,
                durationMs: event.durationMs,
              }));
              terminal.write(
                `${event.code === 0 ? ANSI.green : ANSI.red}${event.code === 0 ? "✓" : "✗"} exit ${event.code}${ANSI.reset}${ANSI.dim} in ${event.durationMs}ms${ANSI.reset}\r\n`,
              );
          }
        },
        onWorkspace: ({ changed, tree: next }) => {
          setTree(next);
          setStats((previous) => ({ ...previous, changed }));
        },
        onDone: () => {
          setRunning(false);
          abortRef.current = null;
        },
        onError: (message) => {
          terminal.write(`${ANSI.red}✗ ${message}${ANSI.reset}\r\n`);
          setRunning(false);
          abortRef.current = null;
        },
      },
      controller.signal,
    );
  }, [runtime, running, code, openPath]);

  // ⌘↵ / ⌃↵ to run, ⌘S to save the open file.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        if (running) stop();
        else void run();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveOpenFile();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [run, stop, running, saveOpenFile]);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(timer);
  }, [error]);

  const startResize = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      const startY = event.clientY;
      const startHeight = panelHeight;
      const onMove = (move: MouseEvent) => {
        const next = startHeight - (move.clientY - startY);
        setPanelHeight(Math.min(Math.max(next, 90), window.innerHeight - 220));
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [panelHeight],
  );

  const tabName = openPath?.split("/").pop() ?? `${sampleId}${extensionFor(runtime)}`;

  return (
    <div className="shell">
      <div className="titlebar">
        <span className="lights">
          <i /> <i /> <i />
        </span>
        <span className="title">
          <b>unsandbox studio</b> — {runtime ? runtime.label : "loading…"}
        </span>
        <span className="spacer" />
        <span className="title" style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
          session {sessionId()}
        </span>
      </div>

      <div className="body">
        <nav className="activity-bar">
          <button className="active" title="Explorer">
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M3 5.5h6l1.5 2H21v11H3z" />
            </svg>
          </button>
          <button title="Runtimes" onClick={() => setPanelTab("about")}>
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <circle cx="12" cy="12" r="8" />
              <path d="M12 8v8M8 12h8" />
            </svg>
          </button>
        </nav>

        <aside className="sidebar">
          <div className="sidebar-section">
            <div className="sidebar-header">
              <span>Runtimes</span>
            </div>
            <div className="runtime-list">
              {runtimes.map((candidate) => (
                <button
                  key={candidate.id}
                  className={`runtime${candidate.id === runtimeId ? " selected" : ""}${candidate.available ? "" : " unavailable"}`}
                  onClick={() => setRuntimeId(candidate.id)}
                  disabled={!candidate.available}
                  title={candidate.detail ?? candidate.description}
                >
                  <span className="glyph">{GLYPHS[candidate.id] ?? "◆"}</span>
                  <span>
                    <span className="name">
                      {candidate.label}
                      <span className={`badge ${candidate.isolation}`}>
                        {ISOLATION_LABEL[candidate.isolation] ?? candidate.isolation}
                      </span>
                    </span>
                    <span className="meta">
                      {candidate.available
                        ? (candidate.detail ?? candidate.language)
                        : "unavailable"}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="sidebar-header">
            <span>Explorer</span>
            <span className="sidebar-actions">
              <button className="icon-button" title="Refresh" onClick={() => void refreshTree()}>
                ⟳
              </button>
              <button
                className="icon-button"
                title="Reset workspace"
                onClick={() => void resetWorkspace()}
              >
                ⌫
              </button>
            </span>
          </div>
          <div className="sidebar-scroll">
            {tree ? (
              <FileTree
                tree={tree}
                activePath={openPath}
                changed={changedSet}
                onOpen={(path) => void openFile(path)}
                onDelete={(path) => void deleteFile(path)}
              />
            ) : (
              <div style={{ padding: "8px 12px", color: "var(--text-faint)" }}>loading…</div>
            )}
          </div>
        </aside>

        <main className="main">
          <div className="tabbar">
            <div className="tab active">
              {dirty && <span className="dot" />}
              <span>{tabName}</span>
              {openPath && (
                <button
                  className="close"
                  title="Close file"
                  onClick={() => {
                    setOpenPath(null);
                    setDirty(false);
                  }}
                >
                  ×
                </button>
              )}
            </div>
            <div className="toolbar">
              <select
                className="select"
                value={sampleId}
                onChange={(event) => setSampleId(event.target.value)}
                title="Sample code"
              >
                {(runtime?.samples ?? []).map((sample) => (
                  <option key={sample.id} value={sample.id}>
                    {sample.title}
                  </option>
                ))}
              </select>
              {openPath && dirty && (
                <button
                  className="icon-button"
                  title="Save (⌘S)"
                  onClick={() => void saveOpenFile()}
                >
                  ⌘S
                </button>
              )}
              <button
                className={`run-button${running ? " stop" : ""}`}
                onClick={() => (running ? stop() : void run())}
                disabled={!runtime?.available}
              >
                {running ? "■ Stop" : "▶ Run"}
                <span style={{ opacity: 0.6, fontSize: 11 }}>⌘↵</span>
              </button>
            </div>
          </div>

          <div className="editor-area">
            <div className="editor-host">
              <Editor
                theme="vs-dark"
                language={runtime?.editorLanguage ?? "plaintext"}
                path={openPath ?? `sample://${runtimeId}/${sampleId}`}
                value={code}
                onChange={(next) => {
                  setCode(next ?? "");
                  if (openPath) setDirty((next ?? "") !== openContents);
                }}
                options={{
                  fontSize: 13,
                  fontFamily: '"SF Mono", ui-monospace, Menlo, Consolas, monospace',
                  minimap: { enabled: true, maxColumn: 70 },
                  scrollBeyondLastLine: false,
                  smoothScrolling: true,
                  renderLineHighlight: "line",
                  cursorBlinking: "smooth",
                  padding: { top: 12 },
                  tabSize: 2,
                  automaticLayout: true,
                }}
              />
            </div>

            <div>
              <div className="resizer" onMouseDown={startResize} />
              <div className="panel" style={{ height: panelHeight }}>
                <div className="panel-tabs">
                  <button
                    className={`panel-tab${panelTab === "output" ? " active" : ""}`}
                    onClick={() => setPanelTab("output")}
                  >
                    Output
                  </button>
                  <button
                    className={`panel-tab${panelTab === "about" ? " active" : ""}`}
                    onClick={() => setPanelTab("about")}
                  >
                    Runtime
                  </button>
                  <span className="panel-meta">
                    {stats.durationMs !== null && <span>{stats.durationMs}ms</span>}
                    {stats.code !== null && (
                      <span className={stats.code === 0 ? "ok" : "bad"}>exit {stats.code}</span>
                    )}
                    {stats.changed.length > 0 && <span>{stats.changed.length} files written</span>}
                    <button
                      className="icon-button"
                      title="Clear output"
                      onClick={() => terminalRef.current?.clear()}
                    >
                      ⌧
                    </button>
                  </span>
                </div>
                <div style={{ display: panelTab === "output" ? "block" : "none", minHeight: 0 }}>
                  <Terminal onReady={onTerminalReady} />
                </div>
                {panelTab === "about" && runtime && (
                  <div className="panel-info">
                    <h4>{runtime.label}</h4>
                    <p>{runtime.description}</p>
                    <dl>
                      <dt>runtime id</dt>
                      <dd>{runtime.id}</dd>
                      <dt>isolation</dt>
                      <dd>{runtime.isolation}</dd>
                      <dt>language</dt>
                      <dd>{runtime.language}</dd>
                      <dt>entry path</dt>
                      <dd>{runtime.defaultEntry}</dd>
                      <dt>detected as</dt>
                      <dd>{runtime.detail ?? "—"}</dd>
                    </dl>
                    <p style={{ marginTop: 16, color: "var(--text-dim)" }}>
                      Every runtime mounts the same workspace at <code>/work</code>. Write a file
                      with one engine, read it with another.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </main>
      </div>

      <footer className="statusbar">
        <span className="item">
          {runtime ? `${GLYPHS[runtime.id] ?? "◆"} ${runtime.label}` : "no runtime"}
        </span>
        <span className="item">{runtime?.isolation ?? "—"}</span>
        <span className="item">{openPath ?? "scratch buffer"}</span>
        <span className="spacer" />
        {running && <span className="item">running…</span>}
        <span className="item">{runtime?.editorLanguage ?? "plaintext"}</span>
        <span className="item">UTF-8</span>
      </footer>

      {error && <div className="toast">{error}</div>}
    </div>
  );
}

function extensionFor(runtime: RuntimeInfo | undefined): string {
  switch (runtime?.language) {
    case "python":
      return ".py";
    case "shell":
      return ".sh";
    default:
      return ".js";
  }
}
