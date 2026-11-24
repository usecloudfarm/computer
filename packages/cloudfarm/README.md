# cloudfarm

Hand an agent a computer: a filesystem, a shell, apps and code mode — in one
install.

```bash
pnpm add cloudfarm
```

```ts
import { Computer } from "cloudfarm";

const computer = new Computer();
const workspace = await computer.createWorkspace("user_id");

const result = await generateText({ model, tools: await workspace.tools(), prompt });
```

## What this package is

A re-export of [`@cloudfarm/computer`](../computer), plus a dependency on the
shell and the code engine.

`@cloudfarm/computer` holds the Computer and every interface the rest of the
repo implements. The shell (`@cloudfarm/rbash-sandbox`) and code mode
(`@cloudfarm/qjs-engine`) are separate packages because they implement those
interfaces and depend on it — so it cannot depend on them back without a cycle
in the build graph. It finds them at runtime instead.

That split is real, but it is the build graph's problem rather than yours.
This package sits above all three and declares them as ordinary dependencies,
so one install leaves nothing to wire up.

## When to take the parts instead

Install `@cloudfarm/computer` directly when you want to

- choose the shell yourself, or
- keep a Workers bundle down to what it actually uses — the wasm shell is
  ~865 KB gzipped, and a Worker that never shells out should not carry it.
