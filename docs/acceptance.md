# Acceptance contract

## Measurement

- [x] Returns active context from `last.totalTokens`.
- [x] Exposes accumulated session usage separately.
- [x] Never uses accumulated usage for the rollover threshold.
- [x] Calculates raw remaining tokens at zero, one, baseline, threshold minus
      one, threshold, threshold plus one, window minus one, window, and above
      window.
- [x] Matches the 12,000-token baseline percentage formula.
- [x] Treats a missing or invalid context window as unknown.
- [x] After a synthetic compaction event, active context may decrease while
      accumulated usage continues to increase.
- [x] Direct and transcript adapters normalize to the same domain shape.
- [x] An unknown transcript shape stops safely without a rollover.

## Triggering

- [x] Below-threshold turns produce no hook output and no state mutation.
- [x] The first threshold crossing creates exactly one rollover request.
- [x] Repeated `Stop` events for the same turn are no-ops after the request.
- [x] Concurrent `Stop` events for one thread cannot both own the lease.
- [x] Concurrent stale-lease recovery elects one owner and cannot take over a
      replacement lease.
- [x] A crash-abandoned recovery claim cannot permanently block the thread.
- [x] `stop_hook_active` prevents a continuation loop.

## Handoff

- [x] No configured handoff path returns `needs decision`.
- [x] Two declared handoff paths return `needs decision`.
- [x] A path outside the project is rejected.
- [x] A replaced or multiply linked handoff file is rejected.
- [x] The update is verified by content requirements and post-write hash.
- [x] A failed update leaves the old thread and watcher authoritative.

## CI watcher

- [x] The successor watches the same immutable target as the old watcher.
- [x] The old watcher continues until successor acknowledgement.
- [x] Acknowledgement includes the target hash and a successful first
      observation.
- [x] Failure and timeout leave the old watcher running.
- [x] The test timeline contains no interval with zero owners.

## Thread creation

- [x] State is durably `CreatingThread` before the request.
- [x] A successful response is persisted before old-thread guidance.
- [x] A lost or malformed response does not trigger an automatic retry.
- [x] Reconciliation accepts exactly one candidate and rejects zero or multiple.
- [x] The old thread receives the successor id and handoff path.
- [x] The old thread is not archived or deleted automatically.

## Privacy and operations

- [x] Logs contain no transcript text, prompt text, tool output, environment
      values, credentials, email addresses, or repository remotes.
- [x] Fixtures are synthetic.
- [x] Dry run creates no real Codex thread and starts no real CI watcher.
- [x] Dry run changes no global Codex or OS configuration.
- [x] Continuation provider loading stays inside the plugin's fixed root.
- [x] Plugin validation succeeds.
- [x] Uninstalling or disabling the plugin restores pre-feature behavior.

## Evidence beyond tests

- [x] Record the exact local Codex version.
- [x] Regenerate app-server schemas from that version and confirm the required
      notification and fields.
- [ ] Run one explicitly approved test-project rollover.
- [ ] Observe the old watcher until the successor acknowledgement.
- [ ] Open the successor in Codex and confirm it reads the verified handoff.
- [ ] Confirm the old thread contains a working successor pointer.

The last four checks require real Codex and CI mutations. They are intentionally
unexecuted in the synthetic-only implementation run and remain an explicit
post-install approval gate.
