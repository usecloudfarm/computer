import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { ArrowUp, Square } from "lucide-react";
import { Message } from "./components/Message.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { FileViewer } from "./components/FileViewer.tsx";
import { ScrollArea } from "@/components/ui/scroll-area.tsx";
import { Button } from "@/components/ui/button.tsx";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { toHistory } from "@/lib/history.ts";
import type { Info, WorkspaceState } from "./types.ts";

const EMPTY: WorkspaceState = { files: [], apps: [], tools: [] };

const PROMPTS = [
  "What's on the Hacker News front page right now? Give me the top 5 with scores.",
  "Find the top HN story, read its comments, and summarise what people think.",
  "Read /data/sales.csv, total it by region, and tell me which region won.",
  "What can you do? Search for the actions available to you.",
];

export function App() {
  const [input, setInput] = useState("");
  const [state, setState] = useState<WorkspaceState>(EMPTY);
  const [info, setInfo] = useState<Info | null>(null);
  const [openFile, setOpenFile] = useState<{ path: string; content: string | null } | null>(null);

  const { messages, sendMessage, status, stop, error } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });

  const busy = status === "submitted" || status === "streaming";
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const history = useMemo(() => toHistory(messages), [messages]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  useEffect(() => {
    void fetch("/api/info")
      .then((response) => response.json() as Promise<Info>)
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

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

  // Grow with the text, up to the max-height the class sets. Reset to auto
  // first or the box can only ever get taller.
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
    <TooltipProvider>
      <div className="flex h-full overflow-hidden">
        <Sidebar
          files={state.files}
          apps={state.apps}
          tools={state.tools}
          history={history}
          info={info}
          onOpenFile={openPath}
          openPath={openFile?.path ?? null}
          // History rows jump to the call in the transcript rather than
          // duplicating it.
          onSelectCall={(key) =>
            document
              .getElementById(`call-${key}`)
              ?.scrollIntoView({ behavior: "smooth", block: "center" })
          }
        />

        <main className="flex min-w-0 flex-1 flex-col">
          <ScrollArea className="flex-1">
            <div className="mx-auto w-full max-w-3xl space-y-6 px-6 pt-10 pb-6">
              {messages.length === 0 && (
                <div className="pt-[12vh]">
                  <h1 className="text-2xl font-semibold tracking-tight">What should it work on?</h1>
                  <p className="text-muted-foreground mt-2 text-[15px] leading-7">
                    The agent has a filesystem, a shell, and actions it finds with{" "}
                    <code className="bg-muted rounded px-1 py-0.5 font-mono text-[13px]">
                      search
                    </code>
                    . Every tool call shows up inline — open one to see exactly what it sent.
                  </p>
                  <div className="mt-6 grid gap-2 sm:grid-cols-2">
                    {PROMPTS.map((prompt) => (
                      <button
                        key={prompt}
                        onClick={() => send(prompt)}
                        className="hover:bg-muted/60 hover:border-foreground/20 rounded-xl border px-3.5 py-3 text-left text-[13px] leading-relaxed transition-colors"
                      >
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

              {status === "submitted" && (
                <p className="text-muted-foreground animate-pulse text-sm">thinking…</p>
              )}
              {error && (
                <p className="text-failed border-failed/30 bg-failed/5 rounded-lg border px-3 py-2 text-sm">
                  {error.message}
                </p>
              )}
              <div ref={endRef} />
            </div>
          </ScrollArea>

          <div className="shrink-0 px-6 pb-5">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                send(input);
              }}
              className="bg-background focus-within:border-foreground/25 mx-auto flex w-full max-w-3xl items-end gap-2 rounded-2xl border p-2 shadow-sm transition-colors"
            >
              <textarea
                ref={inputRef}
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
                className="placeholder:text-muted-foreground max-h-48 flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] leading-6 outline-none"
              />
              {busy ? (
                <Button
                  type="button"
                  size="icon"
                  variant="secondary"
                  onClick={() => void stop()}
                  aria-label="Stop generating"
                  className="size-9 shrink-0 rounded-xl"
                >
                  <Square className="size-3.5 fill-current" />
                </Button>
              ) : (
                <Button
                  type="submit"
                  size="icon"
                  disabled={!input.trim()}
                  aria-label="Send message"
                  className="size-9 shrink-0 rounded-xl"
                >
                  <ArrowUp className="size-4" />
                </Button>
              )}
            </form>
          </div>
        </main>

        {openFile && (
          <FileViewer
            path={openFile.path}
            content={openFile.content}
            onClose={() => setOpenFile(null)}
          />
        )}
      </div>
    </TooltipProvider>
  );
}
