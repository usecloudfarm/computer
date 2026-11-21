import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { Message } from "./components/Message.tsx";

const PROMPTS = [
  "Read /data/sales.csv, total it by region, and tell me which region won.",
  "Write a short markdown summary of the sales data to /out/summary.md, then publish it.",
  "What can you do? Search for the actions available to you.",
  "Run `ls -la /data` and show me what is there.",
];

export function App() {
  const [input, setInput] = useState("");
  const [model, setModel] = useState("");
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

  return (
    <div className="app">
      <header className="header">
        <span className="header__dot" />
        <h1>cloudfarm</h1>
        <span className="header__sub">a computer, driven by an agent</span>
        {model && <span className="header__model">{model}</span>}
      </header>

      <main className="thread">
        <div className="thread__inner">
          {messages.length === 0 && (
            <div className="empty">
              <h2 className="empty__title">What should it work on?</h2>
              <p className="empty__lead">
                The agent has a filesystem, a shell, and actions it finds with <code>search</code>.
                Every tool call shows up inline — open one to see exactly what it sent.
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
              // Enter sends, shift+enter writes a newline — the chat convention.
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
