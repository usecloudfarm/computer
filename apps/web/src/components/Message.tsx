import { Markdown } from "@pierre/words/react";
import { getToolName, isToolUIPart } from "ai";
import type { UIMessage } from "ai";
import { ToolCall } from "./ToolCall.tsx";

/**
 * One message, rendered part by part in the order the model produced them.
 *
 * Order matters: a tool call that happened between two sentences is shown
 * between them, so the transcript reads as what actually occurred rather than
 * prose followed by a pile of calls.
 */
export function Message({ message, streaming }: { message: UIMessage; streaming: boolean }) {
  if (message.role === "user") {
    return (
      <div className="msg msg--user">
        <div className="msg__bubble">{textOf(message)}</div>
      </div>
    );
  }

  return (
    <div className="msg msg--assistant">
      {message.parts.map((part, index) => {
        if (part.type === "text") {
          return (
            <Markdown
              key={index}
              className="msg__markdown"
              // Streaming mode copes with half-written markdown — an unclosed
              // code fence mid-token renders as a code block, not as literal
              // backticks that reflow when the next chunk lands.
              mode={streaming ? "streaming" : "static"}
              isAnimating={streaming}
              parseIncompleteMarkdown
            >
              {part.text}
            </Markdown>
          );
        }
        if (isToolUIPart(part)) {
          return (
            <ToolCall
              key={index}
              id={`call-${message.id}-${index}`}
              part={part}
              name={getToolName(part)}
            />
          );
        }
        return null;
      })}
    </div>
  );
}

function textOf(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}
