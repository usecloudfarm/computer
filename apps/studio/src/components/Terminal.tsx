import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export interface TerminalHandle {
  write: (text: string) => void;
  clear: () => void;
}

interface Props {
  onReady: (handle: TerminalHandle) => void;
}

/** xterm.js as the output pane: it already handles ANSI colour and wrapping. */
export function Terminal({ onReady }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: '"SF Mono", ui-monospace, Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.35,
      theme: {
        background: "#1a1a1a",
        foreground: "#cccccc",
        black: "#1a1a1a",
        red: "#f48771",
        green: "#4ec9b0",
        yellow: "#dcdcaa",
        blue: "#569cd6",
        magenta: "#c586c0",
        cyan: "#9cdcfe",
        white: "#d4d4d4",
        brightBlack: "#6e7681",
        selectionBackground: "#264f78",
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // The pane can be mid-layout; the next observation will settle it.
      }
    });
    observer.observe(host);

    onReady({
      write: (text) => term.write(text),
      clear: () => term.clear(),
    });

    return () => {
      observer.disconnect();
      term.dispose();
    };
  }, [onReady]);

  return <div className="terminal-host" ref={hostRef} />;
}
