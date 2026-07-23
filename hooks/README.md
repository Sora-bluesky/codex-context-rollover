# Stop hook

`hooks/hooks.json` is the default plugin-bundled lifecycle configuration.
`hooks/stop.mjs` is its executable command.

Behavior:

1. read one bounded JSON object from standard input;
2. return silently when `stop_hook_active` is true;
3. require exact session id, turn id, transcript path, and project `cwd`;
4. refuse sessions outside the explicitly configured project;
5. scan only the exact transcript tail for the supported token-count shape;
6. produce no output and no state mutation below threshold;
7. use a per-thread lease and persist one `Requested` checkpoint at threshold;
8. return `decision: block` with a non-empty continuation reason only after a
   durable request exists.

Safely ignored input returns exit code 0 with no stdout or stderr. Unexpected
hook failures use a non-blocking failure exit, never exit code 2.

The hook reads configuration from `PLUGIN_DATA/config.json` and requires the
configured state directory to equal `PLUGIN_DATA`.

After blocking, Codex is directed to the bundled `rollover-continue` skill.
That skill uses `scripts/run-rollover.mjs` with one exact reviewed provider
module, or reports `needs decision` while retaining old ownership.

The hook is bundled but not installed, enabled, or trusted by this repository.
Codex requires review and trust of non-managed hooks after installation.
