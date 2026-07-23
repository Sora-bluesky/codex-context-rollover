# 🔄 Codex Context Rollover

[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933.svg)](package.json)
[![Validation](https://img.shields.io/badge/validation-51%20tests%20passing-brightgreen.svg)](docs/evidence.md)
[![Status](https://img.shields.io/badge/status-experimental-orange.svg)](#current-status)

**🌐 Language: English | [日本語](README.ja.md)**

---

**Codex Context Rollover** transfers an active Codex task to a fresh successor
before the context window runs out. The transfer is checkpointed, explicit, and
safe to stop.

The controller does not guess which project, handoff file, CI run, or task you
mean. It creates no real Codex task and starts no real CI watcher until reviewed
providers are configured.

---

## ✨ What Is This?

Long Codex sessions eventually approach their context limit. A naive rollover
can lose the project state, duplicate a successor task, or leave a CI run with
no owner.

This plugin treats rollover as an ownership transfer:

```text
Codex Stop hook
      │
      ▼
Measure active context ── below threshold ──▶ exit silently
      │
      ▼ threshold reached
Persist Requested
      │
      ▼
Verify one explicit handoff file
      │
      ▼
Start successor CI watcher ── wait for first successful observation
      │
      ▼
Persist CreatingThread ── create one successor task
      │
      ├── ambiguous response ──▶ Reconcile, never retry blindly
      ▼
Persist successor ID ── guide old task ── stop old watcher
```

The old task is never archived or deleted automatically.

---

## 🛡️ Safety Properties

| Property | Behavior |
|----------|----------|
| Explicit scope | Project root, handoff path, thresholds, and watcher target come from configuration |
| Active-context math | Rollover uses current context usage, never accumulated session usage |
| Single owner | A per-task lease prevents concurrent rollover owners |
| Verified handoff | The file must stay inside the project, keep the same identity, change content, and retain required headings |
| No watcher gap | The old watcher stays active until the successor watcher acknowledges the same immutable target |
| No duplicate successor | An ambiguous `thread/start` result enters reconciliation instead of automatic retry |
| Durable ordering | Every external action is preceded or followed by the checkpoint required to recover safely |
| Minimal persistence | State stores opaque IDs, hashes, timestamps, phases, and redacted error categories only |
| Safe failure | Missing or ambiguous inputs produce `needs decision` without external mutation |

---

## 🎯 Who Is This For?

- You run long Codex tasks and want a controlled handoff before context
  exhaustion.
- You need a CI watcher to remain owned throughout the transfer.
- You want failures to stop at a reviewable checkpoint instead of silently
  creating another task.
- You are building a project-specific provider and need tested rollover
  invariants before connecting real services.

---

## 📋 Prerequisites

| Requirement | Check | Notes |
|-------------|-------|-------|
| Node.js 20+ | `node --version` | The implementation uses built-in Node.js modules and `node:test` |
| npm | `npm --version` | Used only to run the repository scripts |
| Codex CLI | `codex --version` | Required when integrating the plugin with Codex |
| Python 3 | `python --version` | Optional; used by the plugin validator |

No third-party npm package is required.

---

## 🚀 Quick Start

### Clone and run the synthetic gates

```powershell
git clone https://github.com/Sora-bluesky/codex-context-rollover.git
Set-Location codex-context-rollover
npm test
npm run dry-run
```

The dry run executes a complete synthetic transfer and should report:

```text
status: complete
realCodexThreadsCreated: 0
realCiWatchersStarted: 0
globalConfigurationChanges: 0
minimumWatcherOwners: 1
```

### Inspect the example configuration

See [`examples/config.example.json`](examples/config.example.json). A real
configuration must identify:

- one absolute project root;
- one plugin data directory;
- one project-relative handoff path;
- required handoff headings;
- remaining-percentage and raw-token thresholds;
- acknowledgement and cancellation timeouts when the defaults are not used.

Real Codex and CI providers are intentionally not bundled. Connecting them is a
separate, reviewed deployment step.

---

## ⚙️ How It Works

### 1. Measure the active context

The preferred source is `thread/tokenUsage/updated` from a controller-owned
Codex app-server connection. The compatibility adapter can read only the exact
`transcript_path` supplied by a Stop hook and scans a bounded tail for the
currently supported `event_msg/token_count` shape.

Unknown or malformed data stops the rollover.

### 2. Persist the request

The Stop hook writes a durable `Requested` checkpoint before returning
`decision: block`. Repeated Stop events become no-ops, and `stop_hook_active`
prevents a continuation loop.

### 3. Verify the handoff

The controller resolves one configured file inside the project, reads it
through a verified file handle, runs the injected updater, then confirms the
same single-linked file changed and still contains every required heading.

### 4. Transfer the watcher

The successor watcher must observe the same immutable target and acknowledge
its first successful observation. A timeout is considered a normal failure only
after cancellation is confirmed. Otherwise the state becomes `NeedsDecision`
and the old watcher remains authoritative.

### 5. Create or reconcile the successor

`CreatingThread` is persisted before the single creation request. A valid
successor ID is persisted before the old task receives guidance. If the response
is lost or malformed, the controller enters `Reconcile` and accepts exactly one
matching candidate.

---

## 📏 Context Measurement

`last.totalTokens` or `last_token_usage.total_tokens` represents active context.
Accumulated session usage is exposed separately and never drives the threshold.

The remaining percentage follows the Codex display baseline:

```text
effective remaining % =
  max(model context window - active context tokens - 12,000, 0)
  / max(model context window - 12,000, 1)
  × 100
```

Both the percentage threshold and the raw remaining-token threshold are
explicit configuration.

---

## 📁 Repository Structure

```text
codex-context-rollover/
├── .codex-plugin/             # Plugin manifest
├── hooks/                     # Bundled Stop hook
├── skills/                    # Continue and status workflows
├── scripts/
│   ├── adapters/              # Codex, transcript, handoff, CI, and thread boundaries
│   ├── controller/            # Rollover orchestration
│   ├── domain/                # Context math and state machine
│   ├── state/                 # Atomic checkpoints and per-task leases
│   └── synthetic/             # Side-effect-free providers and dry-run scenario
├── test/
│   ├── unit/                  # Boundary and invariant tests
│   └── e2e/                   # Complete synthetic transfer
├── docs/
│   ├── design.md              # Architecture and invariants
│   ├── acceptance.md          # Acceptance contract
│   └── evidence.md            # Protocol and validation evidence
└── CONTRIBUTING.md            # Public development and safety rules
```

Operator notes and local agent configuration are gitignored.

---

## ✅ Validation

Run all local gates:

```powershell
npm run test:unit
npm run test:e2e
npm run dry-run
$validator = Join-Path $env:USERPROFILE '.codex\skills\.system\plugin-creator\scripts\validate_plugin.py'
python $validator '.'
```

Current verified result:

| Gate | Result |
|------|--------|
| Unit tests | 50 passed |
| Synthetic end-to-end test | 1 passed |
| Full test run | 51 passed, 0 failed |
| Synthetic dry run | Complete |
| Real Codex tasks created | 0 |
| Real CI watchers started | 0 |
| Global configuration changes | 0 |
| Plugin validator | Passed |

---

## ⚠️ Current Status

The state machine, bundled Stop hook, continuation runner, status workflow,
synthetic providers, and acceptance tests are implemented.

The repository does **not** include:

- an authenticated real Codex task provider;
- a real CI provider;
- automatic plugin installation or trust configuration;
- project, handoff, task, or CI discovery by recency;
- automatic archival or deletion of the old task.

Installation and real-provider wiring require a separate security and rollback
review.

---

## ❓ FAQ

<details>
<summary><strong>Does the dry run create a real Codex task?</strong></summary>

No. It uses recording providers and verifies that real Codex task creation,
real CI watcher startup, and global configuration changes all remain at zero.

</details>

<details>
<summary><strong>Why not retry thread creation after a lost response?</strong></summary>

The task may already exist even when the response is lost. Retrying can create
a duplicate. The controller records `Reconcile` and searches within bounded,
explicit identity constraints.

</details>

<details>
<summary><strong>Why keep the old watcher running so long?</strong></summary>

Stopping it early creates an interval with no owner. The old watcher remains in
place until the successor has acknowledged the target, the successor task ID is
durable, and the old task has received the link.

</details>

<details>
<summary><strong>Can the plugin discover my current task automatically?</strong></summary>

No. Recency is not identity. Missing task, project, handoff, or CI information
produces `needs decision`.

</details>

---

## 🤝 Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before changing an invariant. Tests
must use synthetic fixtures, and a change may not weaken or skip an acceptance
condition to pass.

Bug reports and proposals are welcome in
[GitHub Issues](https://github.com/Sora-bluesky/codex-context-rollover/issues).

---

## 🔗 Documentation

- [Architecture and invariants](docs/design.md)
- [Acceptance contract](docs/acceptance.md)
- [Protocol and validation evidence](docs/evidence.md)
- [Example configuration](examples/config.example.json)
- [OpenAI Codex](https://github.com/openai/codex)

---

📅 **Last Updated:** July 24, 2026
