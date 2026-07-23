---
name: rollover-status
description: Report normalized Codex context usage only when an exact opaque thread id and one exact app-server notification or hook transcript path are supplied.
---

# Rollover Status

Use the bundled status command only when the current task is selected without
guessing.

Required inputs:

- one exact opaque thread id;
- one exact opaque turn id when reading a transcript;
- exactly one exact input path: an app-server notification fixture or the
  hook-supplied transcript path.

Do not discover sessions, scan transcript directories, parse `/status`, or infer
the current task from recency.

Run one of:

```powershell
node scripts/context-status.mjs --thread-id <opaque-id> --notification-file <exact-path>
node scripts/context-status.mjs --thread-id <opaque-id> --turn-id <opaque-turn-id> --transcript-file <exact-path>
```

If the command returns `unambiguous_context_source_required`, report
`needs decision`. Do not select a task on the user's behalf.
