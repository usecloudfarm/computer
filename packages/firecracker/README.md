# @unsandbox/firecracker

A typed driver for [Firecracker](https://github.com/firecracker-microvm/firecracker)
microVMs: the API client, a process supervisor for the VMM, microVM lifecycle
(boot, pause, snapshot, restore, shutdown) and the host side of vsock.

Modelled on the Firecracker **v1.18.0** API description.

## Host requirements

Firecracker is Linux-only and needs KVM. `checkHost()` reports what is missing
rather than failing deep inside a boot:

```ts
import { checkHost } from "@unsandbox/firecracker";

const report = await checkHost();
// { ok, problems, platform, arch, kvm, binaryPath, version }
```

- Linux on x86_64 or aarch64
- `/dev/kvm` readable and writable by the process (usually: be in the `kvm` group)
- a `firecracker` binary on `PATH`, or pass `binaryPath`

There is no macOS or Windows path: develop against a Linux box with KVM (bare
metal, or a cloud instance with nested virtualization enabled).

## Booting a microVM

```ts
import { MicroVM } from "@unsandbox/firecracker";

const vm = await MicroVM.boot({
  apiSocketPath: "/run/unsandbox/vm-1/fc.sock",
  kernelImagePath: "/srv/images/vmlinux",
  drives: [{ driveId: "rootfs", pathOnHost: "/srv/images/rootfs.ext4", isRootDevice: true }],
  vcpuCount: 2,
  memSizeMib: 512,
  network: [{ ifaceId: "eth0", hostDevName: "tap0" }],
  vsockUdsPath: "/run/unsandbox/vm-1/v.sock",
});

const socket = await vm.connect(52); // a guest agent listening on vsock port 52
await vm.shutdown();
```

`boot()` applies the pre-boot configuration in the order the VMM requires
(machine config, boot source, drives, network, vsock) and then issues
`InstanceStart`. If any step fails it kills the VMM rather than leaking a
process.

The host owns everything outside the VM: the tap device named by
`hostDevName`, the rootfs image, and the kernel. This package does not create
them.

## Snapshots

Snapshot and restore are the reason to pick Firecracker for sandboxes: a
restored VM skips guest boot entirely.

```ts
await vm.snapshot({ snapshotPath: "/srv/snap/state", memFilePath: "/srv/snap/mem" });

const clone = await MicroVM.restore({
  apiSocketPath: "/run/unsandbox/vm-2/fc.sock",
  snapshotPath: "/srv/snap/state",
  memBackend: { backend_type: "File", backend_path: "/srv/snap/mem" },
  networkOverrides: [{ iface_id: "eth0", host_dev_name: "tap1" }],
});
```

Restoring one snapshot many times gives every clone the same entropy pool and
clock. Re-seed `/dev/urandom` and resync time in the guest, or pass per-clone
state in through MMDS or vsock.

Use `backend_type: "Uffd"` with a userfaultfd handler to page guest memory in
lazily instead of reading the whole memory file up front.

## Jailer

For untrusted guests, run the VMM under the jailer, which chroots it, drops to
an unprivileged uid/gid and installs a seccomp filter:

```ts
const vm = await MicroVM.boot({
  /* ... */
  jailer: { uid: 10_001, gid: 10_001, chrootBaseDir: "/srv/jailer" },
});
```

Paths in the configuration are then resolved inside the chroot, so the kernel
and rootfs must be placed (or hard-linked) into the jail first.

## vsock

Firecracker multiplexes guest vsock ports over one host Unix socket.

- Host to guest: `vm.connect(port)` does the `CONNECT <port>` handshake and
  hands back the raw stream.
- Guest to host: listen on `guestListenerPath(udsPath, port)`, which is
  `<udsPath>_<port>`, before the guest connects.

## Testing without KVM

The test suite runs on any platform. It drives the real client against a stub
API on a Unix socket, and boots `test/fake-firecracker.mjs` - a stand-in binary
that speaks the API and records requests - so the boot sequence is verified
without a hypervisor.
