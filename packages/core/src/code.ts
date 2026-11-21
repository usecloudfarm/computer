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
 * Code mode: the model writes a script against typed capability proxies and we
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
 * Generated code calls capabilities exactly the way the `run` tool does —
 * `run("slack.sendMessage", { ... })` — so there is one calling convention to
 * learn instead of two, and a snippet the model works out in code mode can be
 * replayed as a single tool call without rewriting it.
 *
 * Anything not named here does not exist in the isolate: no network, no host
 * filesystem, no require. `fetch` and `require` are throwing stubs rather than
 * undefined, because a clear message beats a bare ReferenceError.
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
const fetch = () => { throw new Error('there is no network in code mode; use a capability or run("bash", { cmd })'); };
const require = () => { throw new Error("require is unavailable in code mode; every capability is reachable through run()"); };
`;
}

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
export class CapabilityBridge implements HostBridge {
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
      const value = (await this.#options.invoke(request.capability, request.args as Json)) ?? null;
      const serialized = JSON.stringify(value) ?? "null";
      const bytes = encoder.encode(serialized).byteLength;

      this.#totalBytes += bytes;
      if (this.#totalBytes > limits.maxTotalBytes) {
        this.limitsHit.add("maxTotalBytes");
        this.#record(request.capability, false, started);
        return this.#fail(seq, "limit_exceeded", "total result bytes exceeded", false);
      }
      if (bytes > limits.maxResultBytes) {
        this.limitsHit.add("maxResultBytes");
        this.#record(request.capability, true, started);
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

      this.#record(request.capability, true, started);
      return { v: 1, seq, ok: true, value: this.#options.redactor.value(value) as Json, bytes };
    } catch (error) {
      this.#record(request.capability, false, started);
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

  #record(capability: string, ok: boolean, started: number): void {
    const call = { capability, ok, durationMs: Date.now() - started };
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
  if (name === "CapabilityFailedError") return "upstream_error";
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
  status: CodeResult["status"];
  value?: Json;
  error?: { name: string; message: string; stack?: string };
  bridge: CapabilityBridge;
  durationMs: number;
  redactor: Redactor;
  extraLimits?: readonly string[];
  diagnostics?: readonly Diagnostic[];
}): CodeResult {
  const limitsHit = new Set([...args.bridge.limitsHit, ...(args.extraLimits ?? [])]);
  return {
    status: args.status,
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
    limitsHit: [...limitsHit].sort(),
    diagnostics: [...(args.diagnostics ?? [])],
  };
}
