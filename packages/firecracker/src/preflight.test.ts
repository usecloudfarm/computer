import { describe, expect, it } from "vitest";
import { assertHostSupported, checkHost } from "./preflight.js";
import { HostUnsupportedError } from "./errors.js";

describe("checkHost", () => {
  it("reports the platform and never throws", async () => {
    const report = await checkHost({ binaryPath: "/nonexistent/firecracker" });

    expect(report.platform).toBe(process.platform);
    expect(report.arch).toBe(process.arch);
    expect(report.problems.some((p) => p.includes("firecracker --version"))).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("explains that a non-Linux host cannot run Firecracker", async () => {
    const report = await checkHost();

    if (process.platform === "linux") {
      expect(report.problems.every((p) => !p.includes("needs Linux"))).toBe(true);
    } else {
      expect(report.ok).toBe(false);
      expect(report.kvm).toBe(false);
      expect(report.problems.some((p) => p.includes("needs Linux with KVM"))).toBe(true);
    }
  });

  it("throws HostUnsupportedError when asserting on an unusable host", async () => {
    await expect(
      assertHostSupported({ binaryPath: "/nonexistent/firecracker" }),
    ).rejects.toBeInstanceOf(HostUnsupportedError);
  });
});
