import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HostUnsupportedError } from "./errors.js";

const execFileAsync = promisify(execFile);

export interface HostReport {
  /** True when nothing blocks booting a microVM here. */
  readonly ok: boolean;
  /** Human-readable reasons the host cannot run Firecracker. */
  readonly problems: readonly string[];
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly kvm: boolean;
  /** Resolved path of the `firecracker` binary, when it was found. */
  readonly binaryPath: string | undefined;
  /** Version reported by `firecracker --version`, when it ran. */
  readonly version: string | undefined;
}

export interface CheckHostOptions {
  /** Path to the Firecracker binary. Defaults to `firecracker` on `PATH`. */
  readonly binaryPath?: string;
  /** Path to the KVM device node. Defaults to `/dev/kvm`. */
  readonly kvmPath?: string;
}

/**
 * Checks whether this host can boot microVMs: Linux on x86_64 or aarch64,
 * a readable and writable `/dev/kvm`, and a runnable Firecracker binary.
 *
 * Never throws - inspect {@link HostReport.problems}. Use
 * {@link assertHostSupported} when you want it to throw instead.
 */
export async function checkHost(options: CheckHostOptions = {}): Promise<HostReport> {
  const binary = options.binaryPath ?? "firecracker";
  const kvmPath = options.kvmPath ?? "/dev/kvm";
  const problems: string[] = [];

  if (process.platform !== "linux") {
    problems.push(
      `Firecracker needs Linux with KVM; this host is ${process.platform}. ` +
        "Use a Linux host (bare metal, or a cloud instance with nested virtualization).",
    );
  }
  if (process.arch !== "x64" && process.arch !== "arm64") {
    problems.push(`Firecracker supports x86_64 and aarch64; this host is ${process.arch}.`);
  }

  let kvm = false;
  if (process.platform === "linux") {
    try {
      await access(kvmPath, constants.R_OK | constants.W_OK);
      kvm = true;
    } catch {
      problems.push(
        `${kvmPath} is not readable and writable. Check the host supports KVM and that this ` +
          "user is in the `kvm` group.",
      );
    }
  }

  let binaryPath: string | undefined;
  let version: string | undefined;
  try {
    const { stdout } = await execFileAsync(binary, ["--version"], { timeout: 5_000 });
    version = stdout.split("\n")[0]?.trim();
    binaryPath = binary;
    if (binary.includes("/")) {
      // A path was given: confirm it is a file we can execute.
      const info = await stat(binary);
      if (!info.isFile()) problems.push(`${binary} is not a file.`);
    }
  } catch {
    problems.push(
      `Could not run \`${binary} --version\`. Install Firecracker from ` +
        "https://github.com/firecracker-microvm/firecracker/releases or pass `binaryPath`.",
    );
  }

  return {
    ok: problems.length === 0,
    problems,
    platform: process.platform,
    arch: process.arch,
    kvm,
    binaryPath,
    version,
  };
}

/** Like {@link checkHost}, but throws {@link HostUnsupportedError} when the host is unusable. */
export async function assertHostSupported(options: CheckHostOptions = {}): Promise<HostReport> {
  const report = await checkHost(options);
  if (!report.ok) throw new HostUnsupportedError(report.problems);
  return report;
}
