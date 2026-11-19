import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MicroVM } from "./microvm.js";

const FAKE_FIRECRACKER = fileURLToPath(new URL("../test/fake-firecracker.mjs", import.meta.url));

/**
 * Boots against a stand-in binary that speaks the API but runs no guest, so
 * the configuration sequence is verifiable on a host without KVM.
 */
async function bootFake(overrides: Partial<Parameters<typeof MicroVM.boot>[0]> = {}) {
  const dir = await mkdtemp("/tmp/unsbx-vm-");
  const logPath = join(dir, "requests.jsonl");
  await writeFile(logPath, "");
  process.env.FAKE_FC_LOG = logPath;

  const vm = await MicroVM.boot({
    apiSocketPath: join(dir, "fc.sock"),
    binaryPath: FAKE_FIRECRACKER,
    kernelImagePath: "/srv/vmlinux",
    vcpuCount: 2,
    memSizeMib: 512,
    drives: [{ driveId: "rootfs", pathOnHost: "/srv/rootfs.ext4", isRootDevice: true }],
    ...overrides,
  });

  const calls = async () =>
    (await readFile(logPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method: string; path: string; body: string });

  return { vm, dir, calls, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("MicroVM.boot", () => {
  let cleanups: Array<() => Promise<unknown>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups) await cleanup();
    cleanups = [];
    delete process.env.FAKE_FC_LOG;
  });

  it("configures the VM in order and starts it", async () => {
    const booted = await bootFake({
      network: [{ ifaceId: "eth0", hostDevName: "tap0" }],
      vsockUdsPath: "/tmp/unsbx-vm-vsock.sock",
      bootArgs: "console=ttyS0 quiet",
    });
    cleanups.push(() => booted.vm.kill(), booted.cleanup);

    const calls = await booted.calls();

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /",
      "PUT /machine-config",
      "PUT /boot-source",
      "PUT /drives/rootfs",
      "PUT /network-interfaces/eth0",
      "PUT /vsock",
      "PUT /actions",
    ]);
    expect(JSON.parse(calls[2]!.body)).toMatchObject({
      kernel_image_path: "/srv/vmlinux",
      boot_args: "console=ttyS0 quiet",
    });
    expect(JSON.parse(calls[5]!.body)).toMatchObject({ guest_cid: 3 });
    expect(JSON.parse(calls[6]!.body)).toEqual({ action_type: "InstanceStart" });
  });

  it("applies a default kernel command line and skips absent devices", async () => {
    const booted = await bootFake();
    cleanups.push(() => booted.vm.kill(), booted.cleanup);

    const calls = await booted.calls();

    expect(JSON.parse(calls[2]!.body).boot_args).toBe("console=ttyS0 reboot=k panic=1 pci=off");
    expect(calls.some((c) => c.path === "/vsock")).toBe(false);
    expect(calls.some((c) => c.path.startsWith("/network-interfaces"))).toBe(false);
  });

  it("pauses, snapshots and resumes", async () => {
    const booted = await bootFake();
    cleanups.push(() => booted.vm.kill(), booted.cleanup);

    await booted.vm.snapshot({
      snapshotPath: join(booted.dir, "state"),
      memFilePath: join(booted.dir, "mem"),
    });

    const calls = (await booted.calls()).slice(-3);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "PATCH /vm",
      "PUT /snapshot/create",
      "PATCH /vm",
    ]);
    expect(JSON.parse(calls[0]!.body)).toEqual({ state: "Paused" });
    expect(JSON.parse(calls[2]!.body)).toEqual({ state: "Resumed" });
  });

  it("refuses to connect over vsock when no device was attached", async () => {
    const booted = await bootFake();
    cleanups.push(() => booted.vm.kill(), booted.cleanup);

    expect(() => booted.vm.connect(52)).toThrow(/no vsock device/);
  });

  it("kills the VMM and removes its API socket", async () => {
    const booted = await bootFake();
    cleanups.push(booted.cleanup);
    const socketPath = booted.vm.process.apiSocketPath;

    expect(booted.vm.process.running).toBe(true);
    await booted.vm.kill();

    expect(booted.vm.process.running).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
  });

  it("tears the process down when configuration fails", async () => {
    const dir = await mkdtemp("/tmp/unsbx-vm-fail-");
    cleanups.push(() => rm(dir, { recursive: true, force: true }));

    await expect(
      MicroVM.boot({
        apiSocketPath: join(dir, "fc.sock"),
        binaryPath: FAKE_FIRECRACKER,
        kernelImagePath: "/srv/vmlinux",
        vcpuCount: 1,
        memSizeMib: 128,
        drives: [],
        // The stand-in never listens on this path, so readiness times out.
        readyTimeoutMs: 1,
      }),
    ).rejects.toBeTruthy();
  });
});
