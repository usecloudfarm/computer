/**
 * Runs the API and the Vite dev server together, so `pnpm dev` is one command.
 *
 * A tiny script rather than a `concurrently` dependency: the only things it
 * needs to get right are prefixed output and killing both halves when one of
 * them exits.
 */
import { spawn } from "node:child_process";

const parts = [
  { name: "api", color: "\x1b[36m", command: "pnpm", args: ["run", "dev:server"] },
  { name: "web", color: "\x1b[35m", command: "pnpm", args: ["run", "dev:client"] },
];

const children = parts.map(({ name, color, command, args }) => {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  const prefix = `${color}${name.padEnd(3)}\x1b[0m `;
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      for (const line of chunk.replace(/\n$/, "").split("\n")) console.log(prefix + line);
    });
  }
  child.on("exit", (code) => {
    console.log(`${prefix}exited (${code})`);
    stopAll();
    process.exit(code ?? 0);
  });
  return child;
});

function stopAll() {
  for (const child of children) if (!child.killed) child.kill("SIGTERM");
}

process.on("SIGINT", () => {
  stopAll();
  process.exit(0);
});
