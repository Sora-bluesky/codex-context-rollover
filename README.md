# Codex Context Rollover

Status: the dependency-free controller, bundled Stop hook, status skill,
synthetic providers, and acceptance tests are implemented. Nothing is installed,
enabled, or trusted on this machine.

The controller performs a guarded ownership transfer:

1. normalize active context usage;
2. create one durable rollover request at a configured threshold;
3. update and verify one explicit handoff file;
4. obtain a successful first observation from the successor CI watcher;
5. persist `CreatingThread` before one thread-creation request;
6. reconcile an ambiguous result without retrying automatically;
7. persist the successor id before guiding the old thread;
8. stop the old watcher only after the successor is running and linked.

The old thread is never archived or deleted automatically.

## Measurement sources

- Preferred: `thread/tokenUsage/updated` from a controller-owned app-server
  thread.
- Compatibility fallback: the exact `transcript_path` supplied to a Stop hook.
  The adapter scans only a bounded tail for the current supported
  `event_msg/token_count` JSONL shape. Unknown or malformed data stops safely.

`last.totalTokens`/`last_token_usage.total_tokens` is active context.
Accumulated session usage is exposed separately and never drives the threshold.
The remaining percentage follows Codex's 12,000-token display baseline.

## Run the local gates

Requires Node.js 20 or newer.

```powershell
npm test
npm run test:unit
npm run test:e2e
npm run dry-run
$validator = Join-Path $env:USERPROFILE '.codex\skills\.system\plugin-creator\scripts\validate_plugin.py'
python $validator '.'
```

The dry run uses a temporary synthetic project. It creates no Codex thread,
starts no CI integration, and changes no global Codex or OS configuration.

## Configuration boundary

The bundled hook reads one explicit `config.json` from `PLUGIN_DATA`. The
configuration must name:

- the absolute project root;
- the same plugin data directory;
- `provider` or explicitly synthetic execution mode;
- exactly one project-relative handoff path;
- required handoff headings;
- both rollover thresholds;
- optionally, watcher acknowledgement and cancellation timeouts.

See `examples/config.example.json`. A Stop event is ignored unless its real
working directory is the configured project or one of its descendants. The
plugin never discovers projects, handoff files, transcripts, CI providers, or
current tasks by recency.

At threshold, the Stop hook persists `Requested` and returns a blocking
continuation that invokes the `rollover-continue` skill. The executable
`scripts/run-rollover.mjs` accepts one exact thread id, config path, and reviewed
provider module. Provider modules must resolve inside the plugin's fixed root;
the caller cannot override that trust boundary. This repository bundles only a
synthetic provider; absent real-provider
wiring returns `needs decision`.

## Installation and rollback

Installation, marketplace changes, hook trust, and real provider configuration
are intentionally outside this implementation run and require a separate written
proposal and explicit approval.

After an approved installation, disabling or uninstalling the plugin restores
the pre-feature behavior. Do not edit global hook files by hand. Durable plugin
state may be retained for diagnosis, but it is inert while the plugin is
disabled.

## Repository map

- `scripts/domain/`: context math and rollover state machine.
- `scripts/adapters/`: app-server, transcript, handoff, watcher, and thread
  protocol boundaries.
- `scripts/state/`: atomic state checkpoints and per-thread leases.
- `scripts/controller/`: orchestration and safety ordering.
- `hooks/`: default plugin-bundled Stop hook.
- `skills/rollover-status/`: explicit-source context status workflow.
- `test/unit/`: invariant and boundary tests with synthetic fixtures.
- `test/e2e/`: complete synthetic ownership-transfer test.
- `docs/design.md`: architecture and invariants.
- `docs/acceptance.md`: acceptance status.
- `docs/evidence.md`: observed primary-source and execution evidence.
- `CONTRIBUTING.md`: public development, safety, and verification rules.
