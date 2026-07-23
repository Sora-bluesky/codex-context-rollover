---
name: rollover-continue
description: Continue a durable Codex context rollover request through one explicitly configured provider host, or return needs decision without external mutation.
---

# Continue Rollover

Use this workflow only after the Stop hook reports that a durable rollover
request exists.

Require all three exact inputs:

- the opaque thread id from the Stop continuation;
- the explicit plugin-data `config.json` path;
- one reviewed provider module path inside the installed plugin root.

Do not discover a provider module, configuration, project, handoff, task, or CI
target. If any input is missing or ambiguous, report `needs decision` and leave
the old task and watcher authoritative.

Run:

```powershell
node scripts/run-rollover.mjs --config <exact-config-path> --thread-id <opaque-thread-id> --provider-module <reviewed-plugin-relative-module>
```

Interpret only the structured result:

- `complete`: report the successor pointer already recorded by the provider;
- `reconcile`: do not call thread creation again; use the provider's bounded
  reconciliation path;
- `needs_decision`: stop without external mutation;
- `not_ready`: report the durable phase and do not restart the workflow.

The bundled synthetic provider refuses non-synthetic configuration. A real
provider must be added, reviewed, and approved separately before installation.
