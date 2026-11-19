/**
 * Request and response shapes for the Firecracker API, from the v1.18.0
 * OpenAPI description (`src/firecracker/swagger/firecracker.yaml`).
 *
 * Only the surface this driver uses is modelled; the API has more devices
 * (balloon, pmem, entropy, enclave, memory hotplug) that can be added as
 * needed.
 */

/** `GET /` */
export interface InstanceInfo {
  app_name: string;
  id: string;
  state: "Not started" | "Running" | "Paused";
  vmm_version: string;
}

/** `PUT /machine-config` */
export interface MachineConfiguration {
  vcpu_count: number;
  mem_size_mib: number;
  smt?: boolean;
  track_dirty_pages?: boolean;
  huge_pages?: "None" | "Transparent" | "2M";
  cpu_template?: string;
}

/** `PUT /boot-source` */
export interface BootSource {
  kernel_image_path: string;
  boot_args?: string;
  initrd_path?: string;
}

/** `PUT /drives/{drive_id}` */
export interface Drive {
  drive_id: string;
  is_root_device: boolean;
  path_on_host?: string;
  is_read_only?: boolean;
  partuuid?: string;
  cache_type?: "Unsafe" | "Writeback";
  io_engine?: "Sync" | "Async";
  discard?: boolean;
  rate_limiter?: RateLimiter;
}

/** `PUT /network-interfaces/{iface_id}` */
export interface NetworkInterface {
  iface_id: string;
  host_dev_name: string;
  guest_mac?: string;
  mtu?: number;
  rx_rate_limiter?: RateLimiter;
  tx_rate_limiter?: RateLimiter;
}

/** `PUT /vsock` */
export interface VsockConfig {
  guest_cid: number;
  uds_path: string;
}

/** `PUT /logger` */
export interface LoggerConfig {
  log_path?: string;
  level?: "Error" | "Warning" | "Info" | "Debug" | "Trace" | "Off";
  show_level?: boolean;
  show_log_origin?: boolean;
  module?: string;
}

export interface TokenBucket {
  size: number;
  refill_time: number;
  one_time_burst?: number;
}

export interface RateLimiter {
  bandwidth?: TokenBucket;
  ops?: TokenBucket;
}

/** `PUT /actions` */
export type ActionType = "InstanceStart" | "FlushMetrics" | "SendCtrlAltDel";

/** `PATCH /vm` */
export type VmState = "Paused" | "Resumed";

/** `PUT /snapshot/create` */
export interface SnapshotCreateParams {
  snapshot_path: string;
  mem_file_path: string;
  snapshot_type?: "Full" | "Diff";
  sync_snapshot_files?: boolean;
}

export interface MemoryBackend {
  backend_type: "File" | "Uffd";
  backend_path: string;
}

export interface NetworkOverride {
  iface_id: string;
  host_dev_name: string;
}

/** `PUT /snapshot/load` */
export interface SnapshotLoadParams {
  snapshot_path: string;
  mem_backend: MemoryBackend;
  resume_vm?: boolean;
  track_dirty_pages?: boolean;
  network_overrides?: NetworkOverride[];
}

/** `PUT /mmds/config` */
export interface MmdsConfig {
  version?: "V1" | "V2";
  network_interfaces?: string[];
  ipv4_address?: string;
  imds_compat?: boolean;
}

/** Error body returned by the API on 4xx/5xx. */
export interface ApiErrorBody {
  fault_message?: string;
}
