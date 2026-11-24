import type { FileSystem } from "./ports.js";
import type { LargeRef } from "./schemas.js";

const encoder = new TextEncoder();

/**
 * One implementation of "too big for a context window", used by every
 * model-facing path. Re-implementing this per call site is how 200 KB of HTML
 * ends up in a prompt.
 *
 * Oversize content is written to the workspace so nothing is lost: the model
 * gets a preview plus the path, and can read more with the filesystem tools.
 */
export async function clampForModel(
  text: string,
  limit: number,
  options: { fs: FileSystem; path: string },
): Promise<{ text: string; truncated?: { bytesDropped: number; path: string } }> {
  const bytes = encoder.encode(text).byteLength;
  if (bytes <= limit) return { text };

  // Keep the tail: for command output the end is almost always the useful part.
  const kept = text.slice(-Math.floor(limit * 0.9));
  await options.fs.write(options.path, text);
  return {
    text: kept,
    truncated: { bytesDropped: bytes - encoder.encode(kept).byteLength, path: options.path },
  };
}

export async function toLargeRef(
  data: Uint8Array | string,
  options: { fs: FileSystem; path: string; mime?: string },
): Promise<LargeRef> {
  const stat = await options.fs.write(options.path, data);
  const preview = typeof data === "string" ? data.slice(0, 200) : undefined;
  return {
    $ref: stat.path,
    bytes: stat.size,
    ...(options.mime !== undefined ? { mime: options.mime } : {}),
    ...(preview !== undefined ? { preview } : {}),
  };
}
