import { checkHost, MicroVM } from "@unsandbox/firecracker";

const report = await checkHost();
console.log(
  `host: ${report.platform}/${report.arch}  kvm: ${report.kvm}  firecracker: ${report.version ?? "not found"}`,
);

if (!report.ok) {
  console.log("\nThis host cannot boot microVMs:");
  for (const problem of report.problems) console.log(`  - ${problem}`);
  process.exit(0);
}

// Paths come from your image build; see README for how to produce them.
const vm = await MicroVM.boot({
  apiSocketPath: "/run/unsandbox/demo/fc.sock",
  kernelImagePath: "/srv/unsandbox/vmlinux",
  drives: [{ driveId: "rootfs", pathOnHost: "/srv/unsandbox/rootfs.ext4", isRootDevice: true }],
  vcpuCount: 2,
  memSizeMib: 512,
  vsockUdsPath: "/run/unsandbox/demo/v.sock",
});

console.log(`booted ${vm.id}:`, await vm.info());
await vm.shutdown();
