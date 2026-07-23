# Controller modules

The controller is implemented as small dependency-free Node.js modules:

```text
domain/context-snapshot.mjs
domain/remaining-context.mjs
domain/rollover-machine.mjs
adapters/app-server-usage.mjs
adapters/transcript-usage.mjs
adapters/handoff-file.mjs
adapters/ci-watcher.mjs
adapters/codex-thread-client.mjs
state/rollover-store.mjs
controller/rollover-controller.mjs
synthetic/dry-run-scenario.mjs
synthetic/runner-provider.mjs
context-status.mjs
dry-run.mjs
run-rollover.mjs
```

The executable Stop hook lives at `hooks/stop.mjs`. All provider side effects
are injected behind adapters. The checked-in implementation uses only synthetic
providers; it contains no authenticated Codex or CI client.

`run-rollover.mjs` is the executable continuation path for a durable request.
It loads only one exact, reviewed provider module whose real path stays inside
the plugin's fixed root; no caller-supplied root override is accepted. The
repository bundles only a synthetic provider;
missing real-provider wiring returns `needs decision`.

The status command requires an exact thread id and exact source path. Transcript
status also requires an exact turn id. It returns `needs decision` rather than
selecting a session by recency.
