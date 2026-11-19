#!/usr/bin/env node
// A stand-in for the `firecracker` binary, so the boot sequence can be tested
// on hosts without KVM. It serves the API over the Unix socket it is given and
// appends every request to $FAKE_FC_LOG as JSON lines.
import http from "node:http";
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const socketPath = args[args.indexOf("--api-sock") + 1];
const id = args.includes("--id") ? args[args.indexOf("--id") + 1] : "anonymous";
const logPath = process.env.FAKE_FC_LOG;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    if (logPath) {
      appendFileSync(logPath, JSON.stringify({ method: req.method, path: req.url, body }) + "\n");
    }
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          app_name: "Firecracker",
          id,
          state: "Not started",
          vmm_version: "1.18.0",
        }),
      );
      return;
    }
    res.writeHead(204).end();
  });
});

server.listen(socketPath);
process.on("SIGTERM", () => process.exit(0));
