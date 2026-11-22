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
      <div className="flex justify-end">
        <div className="bg-muted max-w-[85%] rounded-2xl rounded-br-md px-4 py-2.5 text-[15px] leading-7 whitespace-pre-wrap">
          {textOf(message)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {group(message.parts).map((block, blockIndex) => {
        if (block.kind === "text") {
          return (
            <Markdown
              key={blockIndex}
              className="prose-chat"
              // Streaming mode copes with half-written markdown — an unclosed
              // code fence mid-token renders as a code block, not as literal
              // backticks that reflow when the next chunk lands.
              mode={streaming ? "streaming" : "static"}
              isAnimating={streaming}
              parseIncompleteMarkdown
            >
              {block.text}
            </Markdown>
          );
        }

        // A run of calls is one card with dividers rather than a stack of
        // boxes: consecutive calls are one unit of work, and the gaps between
        // them read as pauses that did not happen.
        return (
          <div
            key={blockIndex}
            className="bg-muted/40 divide-border divide-y overflow-hidden rounded-xl border"
          >
            {block.calls.map(({ part, index }) => (
              <ToolCall
                key={index}
                id={`call-${message.id}-${index}`}
                part={part}
                name={getToolName(part)}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

type ToolPart = Extract<UIMessage["parts"][number], { type: `tool-${string}` }>;

type Block =
  { kind: "text"; text: string } | { kind: "tools"; calls: { part: ToolPart; index: number }[] };

/**
 * Collapse the part list into alternating prose and runs of tool calls.
 *
 * Order is preserved: a call that happened between two sentences still shows
 * between them. Only adjacency is used, so prose always breaks a run.
 */
function group(parts: UIMessage["parts"]): Block[] {
  const blocks: Block[] = [];

  for (const [index, part] of parts.entries()) {
    if (part.type === "text") {
      blocks.push({ kind: "text", text: part.text });
      continue;
    }
    if (!isToolUIPart(part)) continue;

    const last = blocks.at(-1);
    if (last?.kind === "tools") {
      last.calls.push({ part: part as ToolPart, index });
    } else {
      blocks.push({ kind: "tools", calls: [{ part: part as ToolPart, index }] });
    }
  }
  return blocks;
}

function textOf(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}
