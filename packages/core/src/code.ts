import {
  CodeLimits,
  type CodeCall,
  type CodeResult,
  type HostCallRequest,
  type HostCallResponse,
  type Json,
} from "./schemas.js";
import type { HostBridge, Invoke } from "./ports.js";
import type { Diagnostic, HostCallError } from "./schemas.js";
import type { Redactor } from "./redact.js";

const encoder = new TextEncoder();

type HostCallErrorCode = HostCallError["code"];

/**
 * Code mode: the model writes a script against typed action proxies and we
 * run it in an isolate, bridging each call back to a host-side handler.
 *
 * The point is context economy. Ten installed apps add zero tokens to the
 * system prompt — the model finds what it needs with `search`, gets a scoped
 * `.d.ts`, and writes one script instead of a chain of tool calls.
 */

/**
 * Builds the JavaScript prepended to the model's source.
 *
 * Every identifier the guest can reach is created here — the apps, plus the
 * workspace's own `fs`, `bash` and `memory`. Code mode is meant to be the
 * whole computer in one turn, so a script that reads a file, shells out and
 * posts the result should not have to bounce back through three separate tool
 * calls to do it.
 *
 * Anything not named below does not exist in the isolate: no network, no host
 * filesystem, no require. `fetch` and `require` are throwing stubs rather than
 * undefined, because a clear message beats a bare ReferenceError.
 */
/**
 * Builds the JavaScript prepended to the model's source.
 *
 * Generated code calls actions exactly the way the `run` tool does —
 * `run("slack.sendMessage", { ... })` — so there is one calling convention to
 * learn instead of two, and a snippet the model works out in code mode can be
 * replayed as a single tool call without rewriting it.
 *
 * Anything not named here does not exist in the isolate: no network, no host
 * globals. `fetch` is a throwing stub rather than undefined, because a clear
 * message beats a bare ReferenceError.
 *
 * `require` is real, and serves four modules. `path`, `os` and `util` are
 * pure JavaScript and cost nothing. `fs` is the interesting one: the isolate
 * has no filesystem of its own, so each call goes over the same bridge
 * `console` and `run` use — which means it is recorded in `CodeResult.calls`
 * and counted against the host-call limits, unlike a native `fs` would be.
 *
 * It exists because the alternative was worse. Without it a script reads a
 * file by writing shell, quoted inside a JS string, inside JSON —
 * `run("bash", { cmd: "cat " + path })` — to do what one line of JS does.
 */
export function buildPrelude(): string {
  return `"use strict";
const console = {
  log: (...args) => __log("log", args),
  info: (...args) => __log("log", args),
  warn: (...args) => __log("warn", args),
  error: (...args) => __log("error", args),
};
const run = (ref, input) => __host(ref, input);
const fetch = () => { throw new Error('there is no network in code mode; use an action or run("bash", { cmd })'); };
${MODULES}`;
}

/**
 * `require`, and the four modules behind it.
 *
 * `fs` throws on failure rather than returning an envelope, because it is
 * pretending to be Node and that is what Node does; `run` keeps the envelope.
 * Mixing the two conventions in one script is the cost, and it is the right
 * way round — a script that forgets to check `existsSync` should stop, where
 * a script calling an app's action should be able to branch on the error.
 */
const MODULES = String.raw`
const __fs = (op, args) => {
  const result = __host("fs." + op, args);
  if (result && result.status === "error") {
    const message = result.error.message || "filesystem error";
    const error = new Error(message);
    // A script checks e.code === "ENOENT", not the host's taxonomy, which
    // classifies a missing file as "internal" for want of a better bucket.
    error.code = /no such file/i.test(message) ? "ENOENT" : result.error.code;
    throw error;
  }
  return result ? result.value : undefined;
};
const __modules = {
  fs: {
    readFileSync: (path) => __fs("read", { path }),
    writeFileSync: (path, content) => { __fs("write", { path, content: String(content) }); },
    appendFileSync: (path, content) => {
      let existing = "";
      try { existing = __fs("read", { path }); } catch (error) { existing = ""; }
      __fs("write", { path, content: existing + String(content) });
    },
    readdirSync: (path) => {
      const prefix = path === "/" ? "/" : String(path).replace(/\/+$/, "");
      return __fs("list", { prefix }).map((entry) => {
        const rest = entry.path.slice(prefix === "/" ? 1 : prefix.length + 1);
        return rest.split("/")[0];
      }).filter((name, index, all) => name && all.indexOf(name) === index);
    },
    statSync: (path) => {
      const stat = __fs("stat", { path });
      if (!stat) { const error = new Error("ENOENT: no such file or directory, stat '" + path + "'"); error.code = "ENOENT"; throw error; }
      return { ...stat, isFile: () => stat.type === "file", isDirectory: () => stat.type === "directory" };
    },
    existsSync: (path) => { try { return __fs("stat", { path }) !== null; } catch (error) { return false; } },
    rmSync: (path) => { __fs("remove", { path }); },
    unlinkSync: (path) => { __fs("remove", { path }); },
    mkdirSync: () => undefined,
  },
  path: {
    sep: "/",
    join: (...parts) => {
      const joined = parts.filter((part) => part !== "" && part !== undefined && part !== null).join("/");
      const absolute = joined.startsWith("/");
      const out = [];
      for (const segment of joined.split("/")) {
        if (segment === "" || segment === ".") continue;
        if (segment === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
        else out.push(segment);
      }
      return (absolute ? "/" : "") + out.join("/") || (absolute ? "/" : ".");
    },
    dirname: (path) => { const index = String(path).replace(/\/+$/, "").lastIndexOf("/"); return index <= 0 ? (index === 0 ? "/" : ".") : path.slice(0, index); },
    basename: (path, ext) => { const name = String(path).replace(/\/+$/, "").split("/").pop() || ""; return ext && name.endsWith(ext) ? name.slice(0, -ext.length) : name; },
    extname: (path) => { const name = String(path).split("/").pop() || ""; const index = name.lastIndexOf("."); return index > 0 ? name.slice(index) : ""; },
    isAbsolute: (path) => String(path).startsWith("/"),
  },
  os: {
    EOL: "\n",
    platform: () => "linux",
    tmpdir: () => "/tmp",
    homedir: () => "/",
  },
  util: {
    format: (...args) => {
      if (typeof args[0] !== "string") return args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ");
      let index = 1;
      const head = args[0].replace(/%[sdijfo%]/g, (token) => {
        if (token === "%%") return "%";
        if (index >= args.length) return token;
        const value = args[index++];
        if (token === "%s") return String(value);
        if (token === "%d" || token === "%f") return String(Number(value));
        if (token === "%i") return String(Math.trunc(Number(value)));
        return JSON.stringify(value);
      });
      const rest = args.slice(index).map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg));
      return rest.length > 0 ? head + " " + rest.join(" ") : head;
    },
    inspect: (value) => { try { return JSON.stringify(value); } catch (error) { return String(value); } },
  },
};
// Also as bare globals: fs.readFileSync(path) is what a model writes
// unprompted, and a missing require line is a silly way to fail. Assigned,
// not declared, so a script writing its own const path shadows the module
// instead of colliding with a const in the same scope.
globalThis.fs = __modules.fs;
globalThis.path = __modules.path;
globalThis.os = __modules.os;
globalThis.util = __modules.util;
const require = (name) => {
  const key = String(name).replace(/^node:/, "");
  if (Object.prototype.hasOwnProperty.call(__modules, key)) return __modules[key];
  throw new Error("Cannot find module '" + name + "'. Available: " + Object.keys(__modules).join(", ") + ". Everything else is reachable through run().");
};
`;

export interface BridgeOptions {
  readonly invoke: Invoke;
  readonly limits: CodeLimits;
  readonly redactor: Redactor;
  readonly onCall?: (call: CodeCall) => void;
}

/**
 * The host end of the bridge. Counts calls and bytes, validates sequencing,
 * and — importantly — never throws: an engine gets an error frame back so the
 * guest's own `catch`/`finally` runs and partial work is still reported.
 */
export class ActionBridge implements HostBridge {
  readonly #options: BridgeOptions;
  readonly #logs: string[] = [];
  readonly calls: CodeCall[] = [];
  readonly limitsHit = new Set<string>();

  #callCount = 0;
  #totalBytes = 0;
  #logBytes = 0;
  #expectedSeq = 0;

  constructor(options: BridgeOptions) {
    this.#options = options;
  }

  get logs(): string {
    return this.#options.redactor.text(this.#logs.join("\n"));
  }

  async call(request: HostCallRequest, signal: AbortSignal): Promise<HostCallResponse> {
    const { limits } = this.#options;
    const seq = request.seq;

    if (seq !== this.#expectedSeq) {
      return this.#fail(
        seq,
        "internal",
        `out-of-order host call (expected ${this.#expectedSeq})`,
        false,
      );
    }
    this.#expectedSeq += 1;

    if (signal.aborted) return this.#fail(seq, "cancelled", "the run was cancelled", false);

    if (this.#callCount >= limits.maxHostCalls) {
      this.limitsHit.add("maxHostCalls");
      return this.#fail(
        seq,
        "limit_exceeded",
        `host call limit of ${limits.maxHostCalls} reached`,
        false,
      );
    }
    this.#callCount += 1;

    const started = Date.now();
    try {
      const envelope = await this.#options.invoke(request.action, request.args as Json);
      const value = envelope as unknown as Json;
      const callFailed = envelope.status === "error";
      const serialized = JSON.stringify(value) ?? "null";
      const bytes = encoder.encode(serialized).byteLength;

      this.#totalBytes += bytes;
      if (this.#totalBytes > limits.maxTotalBytes) {
        this.limitsHit.add("maxTotalBytes");
        this.#record(request.action, false, started);
        return this.#fail(seq, "limit_exceeded", "total result bytes exceeded", false);
      }
      if (bytes > limits.maxResultBytes) {
        this.limitsHit.add("maxResultBytes");
        this.#record(request.action, true, started);
        return {
          v: 1,
          seq,
          ok: true,
          value: {
            $truncated: true,
            bytes,
            preview: serialized.slice(0, 2000),
          } as Json,
          bytes,
          truncated: true,
        };
      }

      // The envelope carries success or failure; the frame is "ok" either way,
      // because the host call itself completed. The call trace records which.
      this.#record(request.action, !callFailed, started);
      return { v: 1, seq, ok: true, value: this.#options.redactor.value(value) as Json, bytes };
    } catch (error) {
      this.#record(request.action, false, started);
      const message = this.#options.redactor.text(
        error instanceof Error ? error.message : String(error),
      );
      const code = classify(error);
      return this.#fail(seq, code, message, code === "rate_limited" || code === "upstream_error");
    }
  }

  log(level: "log" | "warn" | "error", args: unknown[]): void {
    const line = args.map((arg) => (typeof arg === "string" ? arg : safeStringify(arg))).join(" ");
    const bytes = encoder.encode(line).byteLength;
    if (this.#logBytes + bytes > this.#options.limits.maxLogBytes) {
      this.limitsHit.add("maxLogBytes");
      return;
    }
    this.#logBytes += bytes;
    this.#logs.push(level === "log" ? line : `[${level}] ${line}`);
  }

  #record(action: string, ok: boolean, started: number): void {
    const call = { action, ok, durationMs: Date.now() - started };
    this.calls.push(call);
    this.#options.onCall?.(call);
  }

  #fail(
    seq: number,
    code: HostCallErrorCode,
    message: string,
    retryable: boolean,
  ): HostCallResponse {
    return { v: 1, seq, ok: false, error: { code, message, retryable } };
  }
}

function classify(error: unknown): HostCallErrorCode {
  const name = error instanceof Error ? error.name : "";
  if (name === "InvalidArgumentsError") return "invalid_args";
  if (name === "UnauthorizedError") return "not_authenticated";
  if (name === "RateLimitedError") return "rate_limited";
  if (name === "ActionFailedError") return "upstream_error";
  return "internal";
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function resolveLimits(overrides?: Partial<CodeLimits>): CodeLimits {
  return CodeLimits.parse(overrides ?? {});
}

/** Assembles the final result, applying redaction to everything model-facing. */
export function finishResult(args: {
  outcome: CodeResult["outcome"];
  value?: Json;
  error?: { name: string; message: string; stack?: string };
  bridge: ActionBridge;
  durationMs: number;
  redactor: Redactor;
  extraLimits?: readonly string[];
  diagnostics?: readonly Diagnostic[];
}): CodeResult {
  const limitsHit = new Set([...args.bridge.limitsHit, ...(args.extraLimits ?? [])]);
  return {
    outcome: args.outcome,
    ...(args.value !== undefined ? { value: args.redactor.value(args.value) } : {}),
    ...(args.error !== undefined
      ? {
          error: {
            name: args.error.name,
            message: args.redactor.text(args.error.message),
            ...(args.error.stack !== undefined
              ? { stack: args.redactor.text(args.error.stack) }
              : {}),
          },
        }
      : {}),
    logs: args.bridge.logs,
    calls: args.bridge.calls,
    durationMs: args.durationMs,
    limitsHit: [...limitsHit].toSorted(),
    diagnostics: [...(args.diagnostics ?? [])],
  };
}
