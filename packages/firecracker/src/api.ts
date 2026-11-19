import http from "node:http";
import { FirecrackerApiError, FirecrackerTimeoutError } from "./errors.js";
import type {
  ActionType,
  ApiErrorBody,
  BootSource,
  Drive,
  InstanceInfo,
  LoggerConfig,
  MachineConfiguration,
  MmdsConfig,
  NetworkInterface,
  SnapshotCreateParams,
  SnapshotLoadParams,
  VmState,
  VsockConfig,
} from "./types.js";

export interface FirecrackerApiOptions {
  /** Path to the API Unix socket (`--api-sock`). */
  readonly socketPath: string;
  /** Per-request timeout in milliseconds. Defaults to 10_000. */
  readonly timeoutMs?: number;
}

interface RequestOptions {
  method: "GET" | "PUT" | "PATCH";
  path: string;
  body?: unknown;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Typed client for the Firecracker API, which is plain HTTP over a Unix
 * domain socket. Every method rejects with {@link FirecrackerApiError} when
 * the VMM answers non-2xx, surfacing its `fault_message`.
 */
export class FirecrackerApi {
  readonly socketPath: string;
  readonly timeoutMs: number;

  constructor(options: FirecrackerApiOptions) {
    this.socketPath = options.socketPath;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // --- introspection -------------------------------------------------------

  /** `GET /` — instance id, state and VMM version. */
  instanceInfo(): Promise<InstanceInfo> {
    return this.request<InstanceInfo>({ method: "GET", path: "/" });
  }

  /** `GET /version` — the VMM build version. */
  version(): Promise<{ firecracker_version: string }> {
    return this.request({ method: "GET", path: "/version" });
  }

  /** `GET /vm/config` — the full configuration of the running VM. */
  vmConfig(): Promise<unknown> {
    return this.request({ method: "GET", path: "/vm/config" });
  }

  // --- pre-boot configuration ---------------------------------------------

  /** `PUT /machine-config` — vCPUs, memory, dirty page tracking. Pre-boot only. */
  async putMachineConfig(config: MachineConfiguration): Promise<void> {
    await this.request({ method: "PUT", path: "/machine-config", body: config });
  }

  /** `PUT /boot-source` — kernel image, boot args and optional initrd. Pre-boot only. */
  async putBootSource(source: BootSource): Promise<void> {
    await this.request({ method: "PUT", path: "/boot-source", body: source });
  }

  /** `PUT /drives/{drive_id}` — attach a block device. Pre-boot only (paths are patchable later). */
  async putDrive(drive: Drive): Promise<void> {
    await this.request({
      method: "PUT",
      path: `/drives/${encodeURIComponent(drive.drive_id)}`,
      body: drive,
    });
  }

  /** `PUT /network-interfaces/{iface_id}` — attach a tap device. Pre-boot only. */
  async putNetworkInterface(iface: NetworkInterface): Promise<void> {
    await this.request({
      method: "PUT",
      path: `/network-interfaces/${encodeURIComponent(iface.iface_id)}`,
      body: iface,
    });
  }

  /** `PUT /vsock` — attach the vsock device backed by a host Unix socket. Pre-boot only. */
  async putVsock(config: VsockConfig): Promise<void> {
    await this.request({ method: "PUT", path: "/vsock", body: config });
  }

  /** `PUT /logger` — where the VMM writes its own log. */
  async putLogger(config: LoggerConfig): Promise<void> {
    await this.request({ method: "PUT", path: "/logger", body: config });
  }

  /** `PUT /mmds/config` — configure the microVM metadata service. Pre-boot only. */
  async putMmdsConfig(config: MmdsConfig): Promise<void> {
    await this.request({ method: "PUT", path: "/mmds/config", body: config });
  }

  /** `PUT /mmds` — replace the metadata the guest can read. */
  async putMmds(data: unknown): Promise<void> {
    await this.request({ method: "PUT", path: "/mmds", body: data });
  }

  // --- lifecycle -----------------------------------------------------------

  /** `PUT /actions` — `InstanceStart`, `SendCtrlAltDel` or `FlushMetrics`. */
  async action(actionType: ActionType): Promise<void> {
    await this.request({ method: "PUT", path: "/actions", body: { action_type: actionType } });
  }

  /** `PATCH /vm` — pause or resume the microVM. */
  async setVmState(state: VmState): Promise<void> {
    await this.request({ method: "PATCH", path: "/vm", body: { state } });
  }

  /**
   * `PUT /snapshot/create` — write VM state and guest memory to disk.
   * The VM must be paused first.
   */
  async createSnapshot(params: SnapshotCreateParams): Promise<void> {
    await this.request({
      method: "PUT",
      path: "/snapshot/create",
      body: params,
      // Writing guest memory can take a while for large VMs.
      timeoutMs: Math.max(this.timeoutMs, 60_000),
    });
  }

  /** `PUT /snapshot/load` — restore a microVM from a snapshot. Pre-boot only. */
  async loadSnapshot(params: SnapshotLoadParams): Promise<void> {
    await this.request({
      method: "PUT",
      path: "/snapshot/load",
      body: params,
      timeoutMs: Math.max(this.timeoutMs, 60_000),
    });
  }

  // --- transport -----------------------------------------------------------

  /** Resolves once the API socket accepts a request, or rejects on timeout. */
  async waitUntilReady(timeoutMs = 5_000, pollMs = 10): Promise<InstanceInfo> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return await this.instanceInfo();
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    }
    const timeout = new FirecrackerTimeoutError(`API socket ${this.socketPath}`, timeoutMs);
    timeout.cause = lastError;
    throw timeout;
  }

  private request<T>(options: RequestOptions): Promise<T> {
    const { method, path, body } = options;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");

    return new Promise<T>((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          path,
          method,
          headers: {
            Accept: "application/json",
            ...(payload
              ? { "Content-Type": "application/json", "Content-Length": payload.byteLength }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              const fault = parseFault(text);
              reject(
                new FirecrackerApiError({
                  status,
                  method,
                  path,
                  ...(fault !== undefined ? { faultMessage: fault } : {}),
                }),
              );
              return;
            }
            if (!text) {
              resolve(undefined as T);
              return;
            }
            try {
              resolve(JSON.parse(text) as T);
            } catch {
              resolve(text as T);
            }
          });
        },
      );

      req.setTimeout(timeoutMs, () => {
        req.destroy(new FirecrackerTimeoutError(`${method} ${path}`, timeoutMs));
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
}

function parseFault(text: string): string | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as ApiErrorBody;
    return typeof parsed.fault_message === "string" ? parsed.fault_message : text;
  } catch {
    return text;
  }
}
