import { expect, it } from "vitest";
import { env } from "cloudflare:test";

/**
 * E2B on Cloudflare Workers.
 *
 * The original plan listed this as a risk — "the SDK is Node-shaped" — and it
 * is: it requires node:crypto, node:fs, node:os, node:path, node:stream and
 * node:url at the top level. `nodejs_compat` satisfies all of them, which the
 * first test pins, because the failure would be an import error at deploy
 * time rather than anything a type checker sees.
 *
 * The reasoning that made this look impossible was wrong in an instructive
 * way: a remote sandbox does its work elsewhere, so the provider is an HTTP
 * client and nothing more. It was confused with an engine that ran a guest
 * locally in a worker thread, which workerd genuinely cannot do.
 */
const key = (env as { E2B_API_KEY?: string }).E2B_API_KEY;

it("loads the SDK and the provider under workerd", async () => {
  expect(typeof (await import("e2b")).Sandbox).not.toBe("undefined");
  expect(typeof (await import("./index.js")).e2b).toBe("function");
});

// Needs a live key and network, so it is skipped in CI and runs locally with
// `set -a; . ./.env; set +a` before the command.
it.skipIf(!key)(
  "boots a real microVM and runs a command, from inside workerd",
  async () => {
    const { Computer } = await import("@cloudfarm/core");
    const { e2b } = await import("./index.js");
    const ws = await new Computer({ provider: e2b({ apiKey: key! }) }).createWorkspace("workerd");

    const result = await ws.run("bash", { cmd: "echo from-workerd" });
    await ws.close();

    expect(result).toMatchObject({ status: "ok" });
    expect((result as unknown as { value: { stdout: string } }).value.stdout.trim()).toBe(
      "from-workerd",
    );
  },
  120_000,
);
