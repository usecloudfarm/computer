import { Markdown } from "@pierre/words/react";
import { isToolUIPart } from "ai";
import type { UIMessage } from "ai";
import { ToolGroup } from "./ToolGroup.tsx";
import type { GroupedCall, Reveal } from "./ToolGroup.tsx";

/**
 * One message, rendered part by part in the order the model produced them.
 *
 * Order matters: a tool call that happened between two sentences is shown
 * between them, so the transcript reads as what actually occurred rather than
 * prose followed by a pile of calls.
 */
export function Message({
  message,
  streaming,
  reveal,
}: {
  message: UIMessage;
  streaming: boolean;
  reveal: Reveal | null;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="bg-muted max-w-[85%] rounded-2xl rounded-br-md px-4 py-2.5 text-[15px] leading-7 whitespace-pre-wrap">
          {textOf(message)}
        </div>
      </div>
    );
  }

  const blocks = group(message.parts);

  return (
    <div className="space-y-4">
      {blocks.map((block, blockIndex) => {
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

        // A run of calls is one unit of work, so it collapses to one row.
        // Consecutive calls behind a single summary keeps the transcript
        // readable; the gaps between separate boxes read as pauses that did
        // not happen anyway.
        return (
          <ToolGroup
            key={blockIndex}
            messageId={message.id}
            calls={block.calls}
            reveal={reveal}
            // The model has started talking again after this run, which is the
            // cue to fold it away. Only this component knows — a group cannot
            // see what came after it.
            superseded={blocks
              .slice(blockIndex + 1)
              .some((later) => later.kind === "text" && later.text.trim() !== "")}
          />
        );
      })}
    </div>
  );
}

// `GroupedCall` carries whichever kind `isToolUIPart` narrowed to: a
// server-declared `tool-<name>` or a runtime `dynamic-tool`. Narrowing to
// only the first, as this did, meant casting the second back to a shape it
// does not have.
type Block = { kind: "text"; text: string } | { kind: "tools"; calls: GroupedCall[] };

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
      last.calls.push({ part, index });
    } else {
      blocks.push({ kind: "tools", calls: [{ part, index }] });
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
