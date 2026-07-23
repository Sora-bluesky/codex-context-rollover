# Research evidence

Observed on 2026-07-23.

## Local runtime

```text
codex-cli 0.145.0
```

The following commands were used:

```text
codex --version
codex app-server --help
codex app-server generate-ts --experimental --out <temporary-directory>
codex app-server generate-json-schema --experimental --out <temporary-directory>
```

Generated fields:

```text
thread/tokenUsage/updated
ThreadTokenUsage {
  total
  last
  modelContextWindow
}
TokenUsageBreakdown {
  totalTokens
  inputTokens
  cachedInputTokens
  cacheWriteInputTokens
  outputTokens
  reasoningOutputTokens
}
```

The generated evidence is temporary and is not copied into this repository.
Regenerate it from the runtime under test.

The schema was regenerated again during implementation on 2026-07-23 from
`codex-cli 0.145.0`. The generated TypeScript again contained:

```text
ThreadTokenUsageUpdatedNotification {
  threadId
  turnId
  tokenUsage
}
ThreadTokenUsage {
  total
  last
  modelContextWindow
}
```

## OpenAI primary sources

- Codex app-server protocol and thread lifecycle:
  <https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md>
- Codex TUI token semantics and remaining-percentage formula:
  <https://github.com/openai/codex/blob/main/codex-rs/tui/src/token_usage.rs>
- Codex stop-hook implementation:
  <https://github.com/openai/codex/blob/main/codex-rs/hooks/src/events/stop.rs>
- Codex official manual:
  <https://developers.openai.com/codex/codex-manual.md>

Relevant official manual facts:

- `/status` shows context use and rate limits.
- `/compact` summarizes context to free tokens.
- hooks include `Stop`, `PreCompact`, and `PostCompact`.
- common hook input includes `session_id`, `transcript_path`, and `cwd`.
- the transcript format is not a stable hook interface.

## Environment boundary

On this Windows machine:

```text
codex app-server daemon version
```

returns that daemon lifecycle is supported only on Unix platforms. Do not
design a Windows plugin that assumes it can attach to a managed Codex daemon.

## Implementation verification

Observed locally on Windows with Node.js `v24.16.0`:

```text
npm run test:unit
50 tests, 50 passed, 0 failed

npm run test:e2e
1 test, 1 passed, 0 failed

npm test
51 tests, 51 passed, 0 failed

npm run dry-run
status=complete
threadStartCalls=1
syntheticThreadStarts=1
syntheticWatcherStarts=1
oldThreadGuidanceCalls=1
realCodexThreadsCreated=0
realCiWatchersStarted=0
globalConfigurationChanges=0
minimumWatcherOwners=1

validate_plugin.py .
Plugin validation passed

node --check + JSON parse + encoding/line-ending validation
42 files checked, 0 failures
```

The Stop hook configuration was checked against the current Codex manual:
plugins discover `hooks/hooks.json` by default, use matcher groups containing
handler arrays, receive `PLUGIN_ROOT` and `PLUGIN_DATA`, and require explicit
trust before non-managed hooks run.

The current OpenAI Codex Stop-hook implementation was also checked directly.
It confirms that `decision: block` with a non-empty `reason` creates a
continuation prompt, exit code 0 with no output is a no-op, and exit code 2
uses stderr as blocking continuation feedback.

An ephemeral independent review found and drove fixes for:

- incorrect Stop continuation direction and safe-no-op exit behavior;
- crash-stale leases;
- persisted project-path privacy;
- unconfirmed watcher cancellation;
- hard-coded dry-run external-effect claims;
- missing executable continuation routing.

A narrow incremental independent review then found and drove an invariant-level
redesign for:

- concurrent stale-lease recovery, including crash-abandoned recovery claims;
- caller-controlled continuation provider roots;
- handoff identity verification that read by path after checking identity.

The final implementation uses a claimed lease directory with identity and
heartbeat reconfirmation, a fixed plugin provider root, and verified file-handle
reads before and after the handoff update.

## Deliberately absent evidence

No real task, CI watcher, marketplace, hook trust entry, global configuration,
credential, or startup setting was created or changed. A real test-project
rollover remains a separate approval gate.
