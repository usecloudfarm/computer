import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectToGuest, guestListenerPath } from "./vsock.js";
import { FirecrackerError, FirecrackerTimeoutError } from "./errors.js";

/** Stands in for Firecracker's vsock multiplexer on the host socket. */
async function startVsockStub(reply: (port: number, socket: net.Socket) => void) {
  const dir = await mkdtemp("/tmp/unsbx-vsock-");
  const udsPath = join(dir, "v.sock");
  const server = net.createServer((socket) => {
    socket.once("data", (chunk: Buffer) => {
      const match = /^CONNECT (\d+)\n/.exec(chunk.toString("utf8"));
      reply(match ? Number(match[1]) : -1, socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(udsPath, resolve));
  return {
    udsPath,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe("connectToGuest", () => {
  it("performs the CONNECT handshake and hands back the stream", async () => {
    const stub = await startVsockStub((port, socket) => {
      socket.write(`OK ${1024 + port}\n`);
      socket.write("hello from the guest");
    });

    const socket = await connectToGuest(stub.udsPath, 52);
    const first = await new Promise<Buffer>((resolve) => socket.once("data", resolve));

    expect(first.toString("utf8")).toBe("hello from the guest");
    socket.destroy();
    await stub.close();
  });

  it("keeps guest bytes that arrive in the same packet as the banner", async () => {
    const stub = await startVsockStub((_port, socket) => {
      socket.write("OK 1076\npayload");
    });

    const socket = await connectToGuest(stub.udsPath, 52);
    const first = await new Promise<Buffer>((resolve) => socket.once("data", resolve));

    expect(first.toString("utf8")).toBe("payload");
    socket.destroy();
    await stub.close();
  });

  it("rejects when nothing in the guest is listening", async () => {
    const stub = await startVsockStub((_port, socket) => {
      socket.end("ERROR No such CID\n");
    });

    await expect(connectToGuest(stub.udsPath, 52)).rejects.toBeInstanceOf(FirecrackerError);
    await stub.close();
  });

  it("times out when the VMM never answers", async () => {
    const stub = await startVsockStub(() => {
      /* silence */
    });

    await expect(connectToGuest(stub.udsPath, 52, { timeoutMs: 60 })).rejects.toBeInstanceOf(
      FirecrackerTimeoutError,
    );
    await stub.close();
  });

  it("rejects when the host socket does not exist", async () => {
    await expect(connectToGuest("/tmp/unsbx-no-such.sock", 52)).rejects.toBeTruthy();
  });

  it("derives the path a guest-initiated connection lands on", () => {
    expect(guestListenerPath("/run/vm/v.sock", 52)).toBe("/run/vm/v.sock_52");
  });
});
