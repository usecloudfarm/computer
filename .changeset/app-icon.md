---
"@cloudfarm/computer": minor
---

Apps can declare an `icon`.

An absolute `https:` URL on `createApp`, carried through to the built `App`.
A URL rather than bundled bytes: an icon is the one part of an app that a
docs page, a terminal and a chat UI all want at different sizes, and none of
them want it inlined into a module that also ships to a Worker.

It is never shown to the model — a logo is for the human choosing the app,
and the model has the description. A relative path is rejected at
construction, because a catalogue renders the URL from its own origin and a
path has nothing to resolve against there.
