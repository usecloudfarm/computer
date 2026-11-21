---
"@cloudfarm/core": minor
---

Add a `list_apps` tool (ref `apps.list`) returning every installed app with its
id, name, description, the names of the actions it contributes, and its auth
scheme's kind.

`search` answers "what is relevant" and can only rank a guess; this answers
"what is installed", which has one correct answer. A model asked "what can you
do?" previously had to probe with searches and infer the answer from hits.

It is a built-in ref, so code mode can call `run("apps.list", {})` without a
search first. `apps` joins the reserved namespaces, so no app can shadow it.
