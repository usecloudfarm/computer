import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FirecrackerApi } from "./api.js";
import { FirecrackerApiError, FirecrackerTimeoutError } from "./errors.js";

interface Recorded {
  method: string | undefined;
  path: string | undefined;
  body: string;
}

/** A stub of the Firecracker API: HTTP over a Unix socket, like the real VMM. */
async function startStub(
  handler: (req: Recorded) => { status: number; body?: string },
): Promise<{ socketPath: string; requests: Recorded[]; close: () => Promise<void> }> {
  const dir = await mkdtemp("/tmp/unsbx-api-");
  const socketPath = join(dir, "fc.sock");
  const requests: Recorded[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const recorded: Recorded = {
        method: req.method,
        path: req.url,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(recorded);
      const { status, body } = handler(recorded);
      res.writeHead(status, body ? { "Content-Type": "application/json" } : undefined);
      res.end(body);
    });
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  return {
    socketPath,
    requests,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe("FirecrackerApi", () => {
  let stub: Awaited<ReturnType<typeof startStub>> | undefined;

  afterEach(async () => {
    await stub?.close();
    stub = undefined;
  });

  it("reads instance info", async () => {
    stub = await startStub(() => ({
      status: 200,
      body: JSON.stringify({
        app_name: "Firecracker",
        id: "vm-1",
        state: "Running",
        vmm_version: "1.18.0",
      }),
    }));
    const api = new FirecrackerApi({ socketPath: stub.socketPath });

    await expect(api.instanceInfo()).resolves.toMatchObject({ id: "vm-1", state: "Running" });
    expect(stub.requests[0]).toMatchObject({ method: "GET", path: "/" });
  });

  it("sends pre-boot configuration to the documented endpoints", async () => {
    stub = await startStub(() => ({ status: 204 }));
    const api = new FirecrackerApi({ socketPath: stub.socketPath });

    await api.putMachineConfig({ vcpu_count: 2, mem_size_mib: 512 });
    await api.putBootSource({ kernel_image_path: "/vmlinux", boot_args: "console=ttyS0" });
    await api.putDrive({
      drive_id: "rootfs",
      path_on_host: "/rootfs.ext4",
      is_root_device: true,
      is_read_only: false,
    });
    await api.putNetworkInterface({ iface_id: "eth0", host_dev_name: "tap0" });
    await api.putVsock({ guest_cid: 3, uds_path: "/tmp/v.sock" });
    await api.action("InstanceStart");
    await api.setVmState("Paused");

    expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "PUT /machine-config",
      "PUT /boot-source",
      "PUT /drives/rootfs",
      "PUT /network-interfaces/eth0",
      "PUT /vsock",
      "PUT /actions",
      "PATCH /vm",
    ]);
    expect(JSON.parse(stub.requests[0]!.body)).toEqual({ vcpu_count: 2, mem_size_mib: 512 });
    expect(JSON.parse(stub.requests[5]!.body)).toEqual({ action_type: "InstanceStart" });
    expect(JSON.parse(stub.requests[6]!.body)).toEqual({ state: "Paused" });
  });

  it("percent-encodes ids in paths", async () => {
    stub = await startStub(() => ({ status: 204 }));
    const api = new FirecrackerApi({ socketPath: stub.socketPath });

    await api.putDrive({
      drive_id: "scratch disk",
      path_on_host: "/d.ext4",
      is_root_device: false,
    });

    expect(stub.requests[0]?.path).toBe("/drives/scratch%20disk");
  });

  it("surfaces fault_message from an API error", async () => {
    stub = await startStub(() => ({
      status: 400,
      body: JSON.stringify({ fault_message: "Cannot create drive: invalid path" }),
    }));
    const api = new FirecrackerApi({ socketPath: stub.socketPath });

    await expect(
      api.putDrive({ drive_id: "rootfs", path_on_host: "/nope", is_root_device: true }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof FirecrackerApiError &&
        error.status === 400 &&
        error.faultMessage === "Cannot create drive: invalid path" &&
        error.message.includes("PUT /drives/rootfs"),
    );
  });

  it("times out waiting for a socket that never appears", async () => {
    const api = new FirecrackerApi({ socketPath: "/tmp/unsbx-does-not-exist.sock" });

    await expect(api.waitUntilReady(60, 10)).rejects.toBeInstanceOf(FirecrackerTimeoutError);
  });

  it("waits for a socket that appears late", async () => {
    const dir = await mkdtemp("/tmp/unsbx-late-");
    const socketPath = join(dir, "fc.sock");
    const api = new FirecrackerApi({ socketPath });

    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          app_name: "Firecracker",
          id: "late",
          state: "Not started",
          vmm_version: "1.18.0",
        }),
      );
    });
    setTimeout(() => server.listen(socketPath), 50);

    await expect(api.waitUntilReady(3_000, 10)).resolves.toMatchObject({ id: "late" });

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
});
