import type net from "node:net";
import { FirecrackerApi } from "./api.js";
import { FirecrackerProcess, type JailerOptions, type SpawnOptions } from "./process.js";
import { connectToGuest } from "./vsock.js";
import type {
  Drive,
  InstanceInfo,
  LoggerConfig,
  MachineConfiguration,
  MemoryBackend,
  NetworkInterface,
  NetworkOverride,
} from "./types.js";

export interface MicroVMDrive {
  /** Identifier for the drive. `rootfs` is conventional for the root device. */
  readonly driveId: string;
  /** Host path of the backing file or block device. */
  readonly pathOnHost: string;
  readonly isRootDevice?: boolean;
  readonly isReadOnly?: boolean;
  /** `Async` needs a host kernel newer than 5.10.51 and is faster under load. */
  readonly ioEngine?: "Sync" | "Async";
}

export interface MicroVMNetwork {
  /** Identifier for the interface, e.g. `eth0`. */
  readonly ifaceId: string;
  /** Name of the tap device on the host, e.g. `tap0`. The caller creates it. */
  readonly hostDevName: string;
  readonly guestMac?: string;
  readonly mtu?: number;
}

export interface MicroVMOptions {
  /** Path of the API Unix socket to create. */
  readonly apiSocketPath: string;
  /** Host path of the uncompressed kernel image (vmlinux). */
  readonly kernelImagePath: string;
  /** Kernel command line. Defaults to a quiet serial console with panic-on-reboot. */
  readonly bootArgs?: string;
  readonly initrdPath?: string;
  readonly vcpuCount: number;
  readonly memSizeMib: number;
  /** Block devices. Exactly one should set `isRootDevice`. */
  readonly drives: readonly MicroVMDrive[];
  readonly network?: readonly MicroVMNetwork[];
  /**
   * Host path for the vsock Unix socket. Attaching vsock is how you talk to a
   * guest agent without giving the VM a network.
   */
  readonly vsockUdsPath?: string;
  /** Guest CID. Defaults to 3 (the lowest usable). */
  readonly vsockGuestCid?: number;
  /** Required before taking a diff snapshot. */
  readonly trackDirtyPages?: boolean;
  readonly hugePages?: MachineConfiguration["huge_pages"];
  readonly logger?: LoggerConfig;
  readonly instanceId?: string;
  readonly binaryPath?: string;
  readonly jailer?: JailerOptions;
  /** How long to wait for the API socket after spawning. Defaults to 5000ms. */
  readonly readyTimeoutMs?: number;
}

export interface SnapshotOptions {
  readonly snapshotPath: string;
  readonly memFilePath: string;
  /** `Diff` needs `trackDirtyPages` and a previous full snapshot to layer onto. */
  readonly snapshotType?: "Full" | "Diff";
  /** Leave the VM paused after snapshotting instead of resuming it. */
  readonly keepPaused?: boolean;
}

export interface RestoreOptions {
  readonly apiSocketPath: string;
  readonly snapshotPath: string;
  /** Guest memory source: a file, or a UFFD handler socket for lazy paging. */
  readonly memBackend: MemoryBackend;
  /** Start the VM immediately after loading. Defaults to true. */
  readonly resume?: boolean;
  readonly trackDirtyPages?: boolean;
  /** Repoint interfaces at fresh tap devices on this host. */
  readonly networkOverrides?: readonly NetworkOverride[];
  readonly instanceId?: string;
  readonly binaryPath?: string;
  readonly jailer?: JailerOptions;
  readonly readyTimeoutMs?: number;
  /** Needed only so {@link MicroVM.connect} knows where the vsock socket lives. */
  readonly vsockUdsPath?: string;
}

const DEFAULT_BOOT_ARGS = "console=ttyS0 reboot=k panic=1 pci=off";

/**
 * One Firecracker microVM: the VMM process, its API client, and the
 * lifecycle operations on top of them.
 *
 * `boot()` runs the pre-boot configuration in the order Firecracker expects
 * and then issues `InstanceStart`. `restore()` loads a snapshot instead,
 * which skips the guest's boot entirely.
 */
export class MicroVM {
  readonly api: FirecrackerApi;
  readonly process: FirecrackerProcess;
  readonly vsockUdsPath: string | undefined;

  private constructor(args: {
    api: FirecrackerApi;
    process: FirecrackerProcess;
    vsockUdsPath?: string;
  }) {
    this.api = args.api;
    this.process = args.process;
    this.vsockUdsPath = args.vsockUdsPath;
  }

  get id(): string {
    return this.process.id;
  }

  /** Configures and starts a microVM from a kernel and rootfs. */
  static async boot(options: MicroVMOptions): Promise<MicroVM> {
    const proc = await FirecrackerProcess.spawn(spawnOptions(options));
    const api = new FirecrackerApi({ socketPath: options.apiSocketPath });

    try {
      await api.waitUntilReady(options.readyTimeoutMs ?? 5_000);

      if (options.logger) await api.putLogger(options.logger);

      await api.putMachineConfig({
        vcpu_count: options.vcpuCount,
        mem_size_mib: options.memSizeMib,
        ...(options.trackDirtyPages !== undefined
          ? { track_dirty_pages: options.trackDirtyPages }
          : {}),
        ...(options.hugePages !== undefined ? { huge_pages: options.hugePages } : {}),
      });

      await api.putBootSource({
        kernel_image_path: options.kernelImagePath,
        boot_args: options.bootArgs ?? DEFAULT_BOOT_ARGS,
        ...(options.initrdPath !== undefined ? { initrd_path: options.initrdPath } : {}),
      });

      for (const drive of options.drives) await api.putDrive(toDrive(drive));
      for (const iface of options.network ?? []) await api.putNetworkInterface(toInterface(iface));

      if (options.vsockUdsPath) {
        await api.putVsock({
          guest_cid: options.vsockGuestCid ?? 3,
          uds_path: options.vsockUdsPath,
        });
      }

      await api.action("InstanceStart");
    } catch (error) {
      await proc.kill();
      throw error;
    }

    return new MicroVM({
      api,
      process: proc,
      ...(options.vsockUdsPath !== undefined ? { vsockUdsPath: options.vsockUdsPath } : {}),
    });
  }

  /**
   * Restores a microVM from a snapshot. This is the fast path: the guest
   * resumes from saved state instead of booting, so start-up is milliseconds
   * rather than hundreds of them.
   */
  static async restore(options: RestoreOptions): Promise<MicroVM> {
    const proc = await FirecrackerProcess.spawn({
      apiSocketPath: options.apiSocketPath,
      ...(options.instanceId !== undefined ? { id: options.instanceId } : {}),
      ...(options.binaryPath !== undefined ? { binaryPath: options.binaryPath } : {}),
      ...(options.jailer !== undefined ? { jailer: options.jailer } : {}),
    });
    const api = new FirecrackerApi({ socketPath: options.apiSocketPath });

    try {
      await api.waitUntilReady(options.readyTimeoutMs ?? 5_000);
      await api.loadSnapshot({
        snapshot_path: options.snapshotPath,
        mem_backend: options.memBackend,
        resume_vm: options.resume ?? true,
        ...(options.trackDirtyPages !== undefined
          ? { track_dirty_pages: options.trackDirtyPages }
          : {}),
        ...(options.networkOverrides !== undefined
          ? { network_overrides: [...options.networkOverrides] }
          : {}),
      });
    } catch (error) {
      await proc.kill();
      throw error;
    }

    return new MicroVM({
      api,
      process: proc,
      ...(options.vsockUdsPath !== undefined ? { vsockUdsPath: options.vsockUdsPath } : {}),
    });
  }

  /** Current instance state as the VMM reports it. */
  info(): Promise<InstanceInfo> {
    return this.api.instanceInfo();
  }

  /** Pauses the vCPUs. Required before snapshotting. */
  async pause(): Promise<void> {
    await this.api.setVmState("Paused");
  }

  async resume(): Promise<void> {
    await this.api.setVmState("Resumed");
  }

  /**
   * Pauses the VM, writes state and guest memory to disk, then resumes
   * unless `keepPaused` is set.
   *
   * Restoring the same snapshot more than once gives several VMs the same
   * entropy and clock: re-seed `/dev/urandom` and resync time in the guest,
   * or hand each clone fresh state over MMDS or vsock.
   */
  async snapshot(options: SnapshotOptions): Promise<void> {
    await this.pause();
    try {
      await this.api.createSnapshot({
        snapshot_path: options.snapshotPath,
        mem_file_path: options.memFilePath,
        ...(options.snapshotType !== undefined ? { snapshot_type: options.snapshotType } : {}),
      });
    } finally {
      if (!options.keepPaused) await this.resume();
    }
  }

  /** Opens a stream to a guest process listening on `port` over vsock. */
  connect(port: number, options?: { timeoutMs?: number }): Promise<net.Socket> {
    if (!this.vsockUdsPath) {
      throw new Error("This microVM has no vsock device; set `vsockUdsPath` when booting.");
    }
    return connectToGuest(this.vsockUdsPath, port, options ?? {});
  }

  /**
   * Asks the guest to shut down with Ctrl+Alt+Del and waits for the VMM to
   * exit, falling back to {@link kill} after `timeoutMs`.
   *
   * x86_64 only: on aarch64 Firecracker has no equivalent action, so this
   * goes straight to `kill()`.
   */
  async shutdown(timeoutMs = 10_000): Promise<void> {
    if (process.arch === "x64") {
      try {
        await this.api.action("SendCtrlAltDel");
        await this.process.waitForExit(timeoutMs);
        await this.process.kill();
        return;
      } catch {
        // Guest ignored it or has no ACPI handler; fall through to kill.
      }
    }
    await this.kill();
  }

  /** Kills the VMM immediately and removes its API socket. */
  async kill(): Promise<void> {
    await this.process.kill();
  }
}

function spawnOptions(options: MicroVMOptions): SpawnOptions {
  return {
    apiSocketPath: options.apiSocketPath,
    ...(options.instanceId !== undefined ? { id: options.instanceId } : {}),
    ...(options.binaryPath !== undefined ? { binaryPath: options.binaryPath } : {}),
    ...(options.jailer !== undefined ? { jailer: options.jailer } : {}),
  };
}

function toDrive(drive: MicroVMDrive): Drive {
  return {
    drive_id: drive.driveId,
    path_on_host: drive.pathOnHost,
    is_root_device: drive.isRootDevice ?? false,
    is_read_only: drive.isReadOnly ?? false,
    ...(drive.ioEngine !== undefined ? { io_engine: drive.ioEngine } : {}),
  };
}

function toInterface(iface: MicroVMNetwork): NetworkInterface {
  return {
    iface_id: iface.ifaceId,
    host_dev_name: iface.hostDevName,
    ...(iface.guestMac !== undefined ? { guest_mac: iface.guestMac } : {}),
    ...(iface.mtu !== undefined ? { mtu: iface.mtu } : {}),
  };
}
