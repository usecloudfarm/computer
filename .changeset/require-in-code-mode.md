---
"@cloudfarm/core": minor
---

`require` works in code mode, with `fs`, `path`, `os` and `util`.

It was forbidden because there was nothing behind it: QuickJS is a bare
ECMAScript engine with no Node standard library, and the isolate has no
filesystem. The validator and the throwing stub were belt-and-braces over
genuine absence.

The modules are built in the prelude instead. `path`, `os` and `util` are
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
