import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { Message } from "./components/Message.tsx";
import { LeftPanel } from "./components/LeftPanel.tsx";
import { RightPanel } from "./components/RightPanel.tsx";
import { FileViewer } from "./components/FileViewer.tsx";
import type { WorkspaceState } from "./types.ts";

const EMPTY: WorkspaceState = { files: [], apps: [], tools: [] };

/** History rows jump to the call in the transcript, rather than duplicating it. */
const revealCall = (key: string) => {
  document.getElementById(`call-${key}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
};

const PROMPTS = [
  "What's on the Hacker News front page right now? Give me the top 5 with scores.",
  "Find the top HN story, read its comments, and summarise what people think.",
  "Read /data/sales.csv, total it by region, and tell me which region won.",
  "What can you do? Search for the actions available to you.",
];

export function App() {
  const [input, setInput] = useState("");
  const [model, setModel] = useState("");
  const [state, setState] = useState<WorkspaceState>(EMPTY);
  const [openFile, setOpenFile] = useState<{ path: string; content: string | null } | null>(null);

  const { messages, sendMessage, status, stop, error } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });

  const busy = status === "submitted" || status === "streaming";
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void fetch("/api/info")
      .then((response) => response.json() as Promise<{ model: string }>)
      .then((info) => setModel(info.model))
      .catch(() => setModel(""));
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  // Refetch once a turn settles. The agent writes files as it works, and a
  // panel showing the workspace one turn out of date is worse than useless —
  // it is the thing you are looking at to check the work.
  useEffect(() => {
    if (busy) return;
    void fetch("/api/workspace")
      .then((response) => response.json() as Promise<WorkspaceState>)
      .then(setState)
      .catch(() => setState(EMPTY));
  }, [busy]);

  // Grow with the text, up to the max-height the stylesheet sets. Reset to
  // auto first or the box can only ever get taller.
  useEffect(() => {
    const field = inputRef.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }, [input]);

  const send = (text: string) => {
    if (!text.trim() || busy) return;
    void sendMessage({ text });
    setInput("");
  };

  const openPath = (path: string) => {
    setOpenFile({ path, content: null });
    void fetch(`/api/file?path=${encodeURIComponent(path)}`)
      .then((response) => response.json() as Promise<{ content?: string; error?: string }>)
      .then((body) => setOpenFile({ path, content: body.content ?? body.error ?? "" }))
      .catch(() => setOpenFile({ path, content: "could not read this file" }));
  };

  return (
    <div className="app">
      <header className="header">
        <span className="header__dot" />
        <h1>cloudfarm</h1>
        <span className="header__sub">a computer, driven by an agent</span>
        {model && <span className="header__model">{model}</span>}
      </header>

      <div className="layout">
        <LeftPanel
          files={state.files}
          apps={state.apps}
          onOpenFile={openPath}
          openPath={openFile?.path ?? null}
        />

        <div className="center">
          <main className="thread">
            <div className="thread__inner">
              {messages.length === 0 && (
                <div className="empty">
                  <h2 className="empty__title">What should it work on?</h2>
                  <p className="empty__lead">
                    The agent has a filesystem, a shell, and actions it finds with{" "}
                    <code>search</code>. Every tool call shows up inline — open one to see exactly
                    what it sent.
                  </p>
                  <div className="empty__prompts">
                    {PROMPTS.map((prompt) => (
                      <button key={prompt} className="chip" onClick={() => send(prompt)}>
                        {prompt}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((message, index) => (
                <Message
                  key={message.id}
                  message={message}
                  streaming={busy && index === messages.length - 1}
                />
              ))}

              {status === "submitted" && <div className="thinking">thinking</div>}
              {error && <div className="error">{error.message}</div>}
              <div ref={endRef} />
            </div>
          </main>

          <div className="composer-wrap">
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                send(input);
              }}
            >
              <textarea
                ref={inputRef}
                className="composer__input"
                value={input}
                rows={1}
                placeholder="Ask it to do something with the workspace…"
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  // Enter sends, shift+enter writes a newline — the convention.
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    send(input);
                  }
                }}
              />
              {busy ? (
                <button
                  type="button"
                  className="composer__button"
                  onClick={() => void stop()}
                  aria-label="Stop generating"
                >
                  <StopIcon />
                </button>
              ) : (
                <button
                  type="submit"
                  className="composer__button"
                  disabled={!input.trim()}
                  aria-label="Send message"
                >
                  <SendIcon />
                </button>
              )}
            </form>
            <p className="composer__hint">
              Enter to send, Shift+Enter for a new line. The workspace persists between turns.
            </p>
          </div>
        </div>

        <RightPanel tools={state.tools} messages={messages} onSelect={revealCall} />
      </div>

      {openFile && (
        <FileViewer
          path={openFile.path}
          content={openFile.content}
          onClose={() => setOpenFile(null)}
        />
      )}
    </div>
  );
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 13V3M8 3L3.5 7.5M8 3l4.5 4.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <rect x="3" y="3" width="8" height="8" rx="1.5" fill="currentColor" />
    </svg>
  );
}
