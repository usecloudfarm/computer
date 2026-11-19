import net from "node:net";
import { FirecrackerError, FirecrackerTimeoutError } from "./errors.js";

/**
 * Opens a host-initiated vsock connection to `port` inside the guest.
 *
 * Firecracker multiplexes guest vsock ports over one host Unix socket: the
 * host connects to `udsPath`, writes `CONNECT <port>\n`, and the VMM answers
 * `OK <hostPort>\n` once something in the guest is listening. The returned
 * socket is the raw byte stream to the guest process.
 *
 * For the other direction (guest connects out), listen on `${udsPath}_${port}`
 * before the guest connects - see {@link guestListenerPath}.
 */
export async function connectToGuest(
  udsPath: string,
  port: number,
  options: { timeoutMs?: number } = {},
): Promise<net.Socket> {
  const timeoutMs = options.timeoutMs ?? 5_000;

  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.createConnection({ path: udsPath });
    const onError = (error: Error) => {
      s.destroy();
      reject(error);
    };
    s.once("error", onError);
    s.once("connect", () => {
      s.off("error", onError);
      resolve(s);
    });
  });

  return new Promise<net.Socket>((resolve, reject) => {
    // Read in paused mode: switching the socket to flowing here would drop
    // whatever the guest sends before the caller attaches its own listener.
    let buffered = Buffer.alloc(0);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("readable", onReadable);
      socket.off("error", onError);
    };
    const fail = (error: Error) => {
      cleanup();
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new FirecrackerTimeoutError(`vsock CONNECT ${port}`, timeoutMs)),
      timeoutMs,
    );
    const onError = (error: Error) => fail(error);
    const onReadable = () => {
      for (;;) {
        const chunk = socket.read() as Buffer | null;
        if (chunk === null) return;
        buffered = Buffer.concat([buffered, chunk]);

        const newline = buffered.indexOf(0x0a);
        if (newline === -1) {
          // Guard against a peer that never terminates the banner.
          if (buffered.byteLength > 256) {
            fail(new FirecrackerError(`vsock handshake garbage: ${buffered.toString("utf8")}`));
          }
          continue;
        }

        const line = buffered.subarray(0, newline).toString("utf8");
        const rest = buffered.subarray(newline + 1);
        cleanup();
        if (!line.startsWith("OK")) {
          socket.destroy();
          reject(
            new FirecrackerError(`vsock CONNECT ${port} refused: ${line.trim() || "no reply"}`),
          );
          return;
        }
        // Anything the guest already sent after the banner belongs to the caller.
        if (rest.byteLength > 0) socket.unshift(rest);
        resolve(socket);
        return;
      }
    };

    socket.on("readable", onReadable);
    socket.on("error", onError);
    socket.write(`CONNECT ${port}\n`);
  });
}

/**
 * Path the host must listen on to accept connections the guest opens to
 * `port` on CID 2.
 */
export function guestListenerPath(udsPath: string, port: number): string {
  return `${udsPath}_${port}`;
}
