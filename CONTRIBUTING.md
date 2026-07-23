# Contributing

## Scope

This repository owns the Codex Context Rollover plugin and its local
controller. It does not own global Codex configuration, CI provider
configuration, or a consuming project's handoff document.

Use these public sources of truth:

- `docs/design.md` for architecture and invariants;
- `docs/acceptance.md` for acceptance criteria;
- `docs/evidence.md` for observed protocol and validation evidence.

Operator session notes such as `HANDOFF.md`, `AGENTS.md`, and `CLAUDE.md` are
local-only and intentionally ignored.

## Safety and privacy

- Use synthetic fixtures only. Never copy real transcripts, prompts, tool
  output, credentials, environment values, or private CI logs into the
  repository.
- Do not guess a handoff path, CI provider, task, or watcher target. Missing or
  ambiguous configuration must produce `needs decision` without external
  mutation.
- Keep the old task and watcher authoritative until successor ownership is
  acknowledged and durably linked.
- Do not weaken, skip, or narrow an invariant to make a test pass.

## Development

- Use Node.js 20 or newer.
- Prefer dependency-free Node.js modules and `node:test`.
- Keep protocol-specific shapes behind adapters.
- Save text as UTF-8 without BOM and with LF line endings.
- Keep changes small and update the public design or acceptance documents when
  an invariant changes.

## Verification

Run all gates before proposing a change:

```powershell
npm run test:unit
npm run test:e2e
npm run dry-run
$validator = Join-Path $env:USERPROFILE '.codex\skills\.system\plugin-creator\scripts\validate_plugin.py'
python $validator '.'
```

The dry run must create no real Codex task, start no real CI watcher, and
change no global Codex or operating-system configuration.
