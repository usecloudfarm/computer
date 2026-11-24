# @cloudfarm/computer

## 1.0.0

### Major Changes

- 1590b7e: One shell, one engine, neither configurable.

  `@cloudfarm/e2b-sandbox`, `@cloudfarm/vercel-sandbox`, `@cloudfarm/boat-sandbox`,
  `@cloudfarm/agent37-sandbox` and `@cloudfarm/node-engine` are deleted. The
  shell is `just-bash` and code mode is QuickJS, both found at runtime.
  `ComputerOptions.provider` and `ComputerOptions.codeEngine` are gone, with no
  replacement.

  What the remote sandboxes cost was never the code that talked to them. It was
  everything underneath: two filesystems and a copy sync around every command to
  pretend they were one, a second code-mode engine that ran inside the sandbox,
  bucket credentials handed to a machine running model-written code, and two
  dialects of the same `fs` to keep in step. What they bought was `npm` and
  `python`.

  The numbers that settled it, measured against E2B on 2026-11-23: ~1s to create
  a microVM, ~6s more to mount storage over FUSE, 1.6s median for a warm
  `code()` call and a tail into the tens of seconds when its filesystem RPC
  stalled. The in-process isolate does the same call in 2–5ms over the same
  filesystem the host reads.

  ### Removed
  - `ComputerOptions.provider`, `ComputerOptions.codeEngine`
  - `Attachment`, `StorageProvider.attachment()`, `ComputerHost.attachment`,
    `S3StorageOptions.attachCredentials` — mounting was their only caller
  - `SandboxFiles`, `Sandbox.files`, `Sandbox.mounted`, `SandboxSync` — one
    filesystem needs no reconciling
  - `CodeEngineCapabilities.sandboxed`, `CodeJob.sandbox`, `PreludeOptions`
  - `"mount"` and `"code"` from `SandboxCapability`

  ### Added
  - `ComputerOptions.wasmModule`, for Workers only. Not a choice of engine:
    Workers refuses `WebAssembly.compile` on bytes, so the module has to arrive
    as a static import and only your bundler can emit one.
  - `setTestDefaults()`, the seam `provider` used to be. Tests need to assert
    what reached the shell; that was never a reason to let a consumer swap it.

  `SandboxProvider` and `Sandbox` remain exported, because core and
  `@cloudfarm/bash-sandbox` are separate packages and need a shared type. They
  are not an extension point — nothing accepts one.

- d422844: Remove the `fs.*` actions. The shell is the filesystem.

  `fs.read`, `fs.write`, `fs.list` and `fs.remove` are gone from the computer's
  actions, from `run`'s description and from dispatch. What the model has left
  is `bash` and `apps.list` — `cat`, `ls`, `grep`, `>` and `rm` do the rest.

  They were a second filesystem surface over the same bytes, so every file the
  model touched came with a choice that did not matter, and the two-ways-to-do-it
  shape is what has caused every confusion on this surface so far. The shell was
  already the documented way to reach files; this removes the alternative rather
  than describing it again.

  Code mode is unaffected in reach and changes in spelling: `run("bash", { cmd })`
  is how a script touches files now, and the `code` tool's description says to
  build commands with template strings rather than hand-quoting them. A heredoc
  interpolated from a template literal works, which is the case the fs refs were
  kept for.

  `workspace.fs` is untouched. It is the API for the program embedding a
  Computer — the playground's own file explorer uses it — and was never part of
  what the model sees.

  Measured before removing: reading one file through `bash` costs about 3ms
  against a 400KB workspace, where `fs.read` was effectively free, because the
  default provider snapshots the workspace per command. Real, and far below the
  latency of the model deciding to make the call.

- a886176: Remove the `list_apps` tool. The surface is three: `search`, `code`, `run`.

  `search` finds, `code` chains, `run` does. `list_apps` was `search` with an
  empty query and a different result shape, and it was the second place a model
  could learn a ref exists without learning how to call it — the same shape that
  taught models to call `bash` as a tool of its own.

  `apps.list` stays an action, so nothing is unreachable: `search` ranks it
  first for "what is installed", "what apps are available" and "what can you
  do", and the playground's own Apps panel still calls it through `run`.

  That last query exposed a real bug, fixed here: a query made entirely of
  stopwords tokenized to nothing and returned no results at all. "what can you
  do" is the most natural way to ask what a computer has, and it was answered
  with silence — which mattered less when `list_apps` was a tool you could just
  call. Stopword removal now never empties a query; if every term is a
  stopword, the query falls back to matching on them.

### Minor Changes

- 0cb3f0f: Apps can declare an `icon`.

  An absolute `https:` URL on `createApp`, carried through to the built `App`.
  A URL rather than bundled bytes: an icon is the one part of an app that a
  docs page, a terminal and a chat UI all want at different sizes, and none of
  them want it inlined into a module that also ships to a Worker.

  It is never shown to the model — a logo is for the human choosing the app,
  and the model has the description. A relative path is rejected at
  construction, because a catalogue renders the URL from its own origin and a
  path has nothing to resolve against there.

- fce2c8d: Rename `@cloudfarm/core` to `@cloudfarm/computer`, and add `cloudfarm` — one
  install for the Computer, the shell and the engine.

  The package holds a Computer, not a core of loose utilities, and the name now
  says so. Every import of `@cloudfarm/core` becomes `@cloudfarm/computer`.

  Alongside it, `cloudfarm` re-exports that package and depends on
  `@cloudfarm/rbash-sandbox` and `@cloudfarm/qjs-engine`. Those two are separate
  packages because they implement interfaces defined in the Computer and depend
  on it, so it cannot depend on them back — a constraint of the build graph that
  a new project should not have to know about. `pnpm add cloudfarm` leaves
  nothing to wire up; `@cloudfarm/computer` is still there for anyone choosing a
  shell or trimming a Workers bundle.

- f7bc7ed: `code` is a tool, and no longer also a ref.

  It was both, which made it the last name on the surface that could be reached
  two ways — the same asymmetry that taught models to call `bash` as a tool of
  its own. And the two ways did not answer alike: the tool returns the
  `CodeResult`, while `run("code", { source })` wrapped it, handing back
  `{ status: "ok", value: { outcome, value, … } }` — two nested result shapes
  with the real value at `value.value`, and a failed script reporting
  `status: "ok"` because the dispatch succeeded. That is the confusion
  `CodeResult`'s own schema comment exists to avoid.

  Indexing it bought nothing either. A tool is in context on every request, so
  it never needed `search` to be found; being in the registry only meant it
  competed in search results and appeared in `apps.list` and the generated
  `.d.ts` as an action.

  So `code` is gone from `builtinActions`, from `run`'s description, and from
  the dead `case "code"` in dispatch that the `run()` guard had been shadowing.
  The tool is unchanged. One thing falls out for free: a script calling
  `run("code", …)` is now refused by validation, before anything executes,
  rather than recursing into a nested run.

- 31eeac8: Code mode can no longer be turned off. `codeEngine: null` now resolves the
  default engine, exactly as leaving the field unset does.

  Chaining several actions in one pass is the reason the tool surface stays at
  five whatever is installed, so a Computer without code mode is a different,
  worse product rather than a configuration of this one. A shell stays genuinely
  optional — `provider: null` still means no shell.

  The `code` tool also no longer waits for an app to be installed. It was gated
  on the action registry being non-empty, which withheld it from a bare
  Computer — exactly when `run("fs.read")` and `run("bash")` in one pass are
  most useful.

  One platform caveat, unchanged: on Workers the default cannot resolve itself,
  because the wasm must be a static import that only your bundler can emit. Pass
  `quickjsForWorkers(wasmModule)` there, or code mode is unavailable whatever
  this option says.

- dda004d: Drop the `fs` tool. The surface is four tools now: `search`, `code`, `run`,
  `list_apps`.

  Files are what a shell is for. `cat`, `head`, `grep`, `ls` and a heredoc cover
  everything the tool did, and one way to reach the filesystem is one fewer
  thing to choose between — the two-ways-to-do-it shape is what taught a model
  to call `bash` as a tool of its own in the first place.

  `run`'s description now teaches those commands, and how not to drown in them:
  `wc -l` before reading something unsized, `grep` instead of reading a file to
  search it, `head`/`tail` instead of whole files. Output is clamped either way,
  so `cat` on a large file spends context and still arrives incomplete — naming
  the cheaper commands is more use to a model than telling it to be careful. The
  storage provider's own line about where files live moves here too, since
  whether a file survives the turn changes whether writing it was worth doing.

  `fs.read` / `fs.write` / `fs.list` are unchanged as refs: they take `{ path }`
  and `{ path, content }` as arguments, which beats quoting when the content is
  awkward, and code mode has nothing else to call.

  Code mode is unaffected — `run('fs.write', { path, content })` works as
  before — but its description now says why it points at the fs refs where
  `run` points at the shell: inside a script a heredoc ends up quoted in a JS
  string inside JSON, three levels deep, while `fs.write` takes the content as
  an argument.

- cf82e76: Remove memory as a concept: the `MemoryStore` port, the `MemoryRecord` schema,
  the `memory` option, the three `memory.*` built-ins, and the
  `@cloudfarm/sqlite-memory` package.

  It was redundant with the workspace. An agent handed a filesystem that
  outlives its context already writes notes to it — in the playground it chose
  `/memory/user_preferences.md` before memory actions existed — so a second,
  narrower store bought nothing a `fs.write` did not, while costing a port, a
  package, three indexed actions competing with `fs.*` in search, and a
  scope-less interface that would have surfaced one user's notes in another's
  workspace if a deployment shared it.

  The convention replaces the capability: keep what you learn in `/memory/*.md`.
  Markdown is editable, diffable and greppable with `bash`, and it needs no
  second backend to persist.

- 0a4aa8d: The `run`, `code` and `fs` tool descriptions are built from what a computer
  actually has rather than fixed in a constant.

  `run` names only the built-ins that are available — no `'bash'` when no
  sandbox is configured. It quotes
  the sandbox provider's own description too, so a model is told up front that
  the default shell cannot run npm, node or python instead of discovering it by
  failing. `fs` carries the storage provider's description, so "lost when the
  process ends" is visible before anything is written.

  The ref list comes from the registry's availability-filtered built-ins — the
  same source `search` and `list_apps` use — so a description cannot name a ref
  that dispatch would reject.

- 11b136b: `fs`, `path`, `os` and `util` work in code mode, as globals and through
  `require`.

  It was forbidden because there was nothing behind it: QuickJS is a bare
  ECMAScript engine with no Node standard library, and the isolate has no
  filesystem. The validator and the throwing stub were belt-and-braces over
  genuine absence.

  The modules are built in the prelude instead, and are in scope without a
  `require` line, since `fs.readFileSync(path)` is what a model writes
  unprompted. They are assigned rather than declared, so a script writing its
  own `const path` shadows the module instead of colliding with it. `path`, `os` and `util` are
  plain JavaScript and cost nothing. `fs` goes over the same bridge `run` and
  `console` use, so `readFileSync` is a host call — which means it appears in
  `CodeResult.calls` and counts against `maxHostCalls`, where a native `fs`
  would be invisible.

  This removes the last reason for the worst thing a script was doing: reading a
  file by writing shell, quoted inside a JS string, inside JSON —
  `run("bash", { cmd: "cat " + path })` — to do what one line of JS does.

  `fs` throws on failure rather than returning an envelope, because it is
  pretending to be Node; a missing file is `ENOENT`, not the host's `internal`.
  `run` keeps the envelope.

  `fs.*` is reachable by dispatch again but is still not an action: absent from
  `builtinActions` and from the validator's known refs, so `search` never offers
  it and a script writing `run("fs.read", …)` is rejected. `require` is the one
  spelling.

  `CodeEngineCapabilities.guestModules` and `CodeJob.fs` are removed. They
  existed so an engine could say it had its own modules; now every engine gets
  the same four from the prelude, which is what keeps one dialect across them.

- 04e6c75: Add `@cloudfarm/s3-storage`: workspace files in any S3-compatible bucket you own —
  AWS, R2, MinIO, B2. Signed with `aws4fetch` (SigV4 over WebCrypto), so it runs
  unchanged on Node and Workers where an AWS SDK would not.

  Each `{ userId, workspaceId }` gets its own key prefix, which is both the
  tenant boundary and the thing a scoped credential should be pinned to.

  Keys are laid out as `<prefix>/<userId>/workspaces/<workspaceId>/`. The user
  owns the root folder, so anything of theirs that outlives a single workspace
  has somewhere to sit beside `workspaces/`.

- 2674796: The shell can no longer be turned off. `provider: null` resolves the default
  instead of opting out, exactly as `codeEngine: null` already did.

  A shell is part of what makes this a computer rather than a tool router, and
  it is what an agent reaches for when no action fits. A Computer without one is
  a different, worse product rather than a configuration of this one — and the
  inconsistency was its own problem, since `null` meaning "default" in one field
  and "off" in the next is the kind of thing nobody reads twice.

  `provider` can still come back undefined, but only when `@cloudfarm/bash-sandbox` is
  not installed. That is a fact about a deployment rather than a choice about
  the product, and the behaviour is unchanged: `bash` stays out of `search`, out
  of `run`'s description and out of `apps.list`, and calling it explains how to
  install the package.

### Patch Changes

- 4ddbcb6: `await` works in code mode.

  The engine already ran on the asyncify variant with `evalCodeAsync` and an
  asyncified host function — the only thing stopping `await` was that the guest
  was wrapped in a non-async arrow, so it failed to compile. Wrapping it in an
  async one and resolving the returned promise is the whole change.

  Worth doing because models write `await` by habit, and a hard rejection cost
  a whole turn to learn a rule that bought nothing.

  It buys correctness, not speed, and the description says so. Asyncify unwinds
  the entire wasm stack for each host call and cannot be re-entered while
  unwound, so calls are serialised however a script is written. Measured:
  `Promise.all` of four 200ms actions takes 808ms — the same as awaiting them
  one at a time. A model reaching for `Promise.all` expects the opposite, so
  the `code` tool now states it.

- 8badb16: Stop models calling `bash` as a tool of its own.

  A computer's actions are refs reached through `run`, with one exception that
  is not visible from the outside: `code` and `fs` are tools _as well as_ refs.
  Given those two, "and `bash`" is the reasonable generalisation — and the old
  `run` description invited it, listing `'bash' for the shell ({ cmd })`
  alongside two names that really were tools in the same request. An undeclared
  tool name is rejected before anything executes, so the slip cost a whole turn.

  `run`'s description now shows refs in call position — `{ ref: 'bash', args:
{ cmd } }` — so a ref can never be read as a tool name, and says outright that
  the shell has no tool of its own.

  `@cloudfarm/ai-sdk-toolset` gains `repairToRun()` for the other half, since a description
  cannot make a model infallible:

  ```ts
  streamText({ model, tools: await workspace.tools(), repairToolCall: repairToRun() });
  ```

  It rewrites a call to an undeclared tool into `run` for that ref. Wrong
  guesses are cheap — dispatch answers an unknown ref with an error envelope
  carrying a hint, which the model can act on, where a dead turn gives it
  nothing. It repairs the name only: malformed _arguments_ raise
  `InvalidToolInputError`, which is a real schema mismatch worth surfacing.

- 91830ae: Add `@cloudfarm/sqlite-storage`: workspace files in SQLite, through
  `node:sqlite` on Node, a Durable Object's own storage on Workers, or D1.

  No bucket, no endpoint and no credentials, so there is nothing to scope or
  keep away from model-written code. It also suits the traffic a workspace has:
  the shell reads the workspace before every command, which over S3 is one
  HTTPS request per file and here is one statement.

  Content is stored in 256 KiB chunks rather than one blob per file. A Durable
  Object caps a key and value together at a few megabytes — raised twice, with
  the docs trailing the runtime — so a whole-file blob is a cliff a workspace
  reaches by saving a CSV.

  `SqlDriver` is two methods, `all` and `write`, and either may return a
  promise — so a database reached over the network fits, which is what `./d1`
  is. `write` takes a statement list rather than a callback because neither
  platform with an opinion can serve a callback: a Durable Object's
  `transactionSync` needs a synchronous body, impossible once a driver call may
  be awaited, and D1 has no `BEGIN`, only `batch()`. A chunked write therefore
  reaches D1 as one `batch` — one round trip instead of one per chunk, and
  atomic.

  `d1Storage` takes either shape:

  ```ts
  d1Storage({ database: env.DB }); // the binding, in a Worker
  d1Storage({ accountId, databaseId, apiToken }); // the REST API, anywhere
  ```

  Both reach the same tables. The REST form is for running outside Cloudflare,
  and it is the slowest of the four: a public HTTPS round trip per statement,
  where the binding is an internal hop and the other two are a function call.

  It also has to work around JSON. The REST `params` is documented as an array
  of strings, and a `Uint8Array` is an object with numeric keys to
  `JSON.stringify` rather than an array — so bytes survive neither direction.
  That driver writes a chunk as an `X'…'` blob literal in the SQL and reads it
  back with `hex()`, which keeps the column a real `BLOB` so the binding can
  read what it wrote. `SqlDriver.blobAsHex` is the flag; the local drivers leave
  it off and read the blob directly.

  The binding driver is covered by a suite that runs under workerd against a
  real D1 binding, because what `bind` accepts as a blob is not something a
  hand-written double can settle. The REST driver is covered against a real HTTP
  server implementing the documented contract, which exercises the URL, the
  bearer header, the body shape and `success: false` arriving with HTTP 200.

  It attaches to the shell and to code mode without either knowing: `just-bash`
  runs over `host.fs` and code mode's `fs` calls the host, so both see one store
  and each other's writes.

  `path` accepts a filesystem path, a `file:` URL string, a `URL` object or
  `":memory:"`, and a missing parent directory is created — SQLite will not, and
  reports only "unable to open database file". `readOnly` opens without write
  access. URI query parameters are not supported; SQLite needs an open flag for
  those that `node:sqlite` does not expose.

  `@cloudfarm/computer` now exports `FileNotFoundError`, which a storage provider
  needs to report a missing file the way the rest of the system expects — code
  mode maps it to `ENOENT`.

  `MemoryFileSystem.remove("/", { recursive: true })` reported a missing file
  instead of clearing the workspace. The scope of `/` was spelled `${path}/`,
  giving `//`, which no path starts with; `list` already special-cased it and
  `remove` and `move` did not.

- 8608f55: Fix the generated `.d.ts` declaring refs that do not exist.

  `renderDeclarations` rebuilt each ref as `appId + "." + action.name`. That is
  correct for an app — `slack.sendMessage` — and wrong for every built-in, whose
  app is `computer` while its ref is `bash` or `fs.read`. The types handed to a
  model declared `computer.bash` and `computer.read`, which `run` rejects.

  `DeclarationEntry` now carries the real ref. The bug arrived with built-ins
  becoming searchable and was invisible because the `@example` line beside each
  declaration was right, so a model following the example still worked.

- Updated dependencies [4ddbcb6]
- Updated dependencies [1590b7e]
- Updated dependencies [39c05ae]
- Updated dependencies [d2b68e1]
- Updated dependencies [fce2c8d]
- Updated dependencies [c6ad0e0]
- Updated dependencies [274f11e]
  - @cloudfarm/qjs-engine@1.0.0
  - @cloudfarm/bash-sandbox@1.0.0
  - @cloudfarm/rbash-sandbox@0.1.0

## 0.0.1

### Patch Changes

- First release.

  A Computer gives an agent a workspace: a filesystem, a shell, and actions it
  finds by searching rather than carrying in its context. Five tools whatever is
  installed — `search`, `run`, `code`, `list_apps`, `fs` — so a tenth app costs
  nothing in the system prompt.

  - **`@cloudfarm/computer`** — `Computer` and `Workspace`, the plugin interfaces,
    ref dispatch, BM25 action search, code-mode orchestration with
    validation-before-execution, one result envelope for every call, redaction
    and output clamping. Isomorphic: its whole suite runs under workerd as well
    as Node.
  - **Sandboxes** — `bash` (the zero-infrastructure default), `e2b`, `boat`,
    `agent37`, `vercel-sandbox`.
  - **Engines** — `quickjs`, the default for code mode.
  - **Apps** — `slack`, `hackernews`, `firecrawl`, `cloudflare-browser`.
  - **Toolsets** — `ai`, for the Vercel AI SDK.

- Updated dependencies
  - @cloudfarm/bash-sandbox@0.0.1
  - @cloudfarm/quickjs@0.0.1
