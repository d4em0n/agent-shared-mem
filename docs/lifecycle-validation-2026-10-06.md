# Interactive compaction lifecycle validation — 2026-10-06

The three installed clients were tested in detached tmux sessions with isolated
configuration, data, cache, state, and memory directories. Test hooks logged
lifecycle inputs and injected unique context markers. The v2 runtime adapters ran
alongside the probes. Existing user hook/plugin configuration was not loaded or
modified.

## Versions

- Codex CLI 0.160.0
- Claude Code 2.1.286
- OpenCode 1.18.34 (V1 plugin API)

## Results

### Codex

Observed for manual `/compact`:

1. `PreCompact` with `trigger: "manual"`
2. `PostCompact` with `trigger: "manual"`
3. `SessionStart` with `source: "compact"`, immediately before the next model request

The next response returned `CODEX_SESSIONSTART_COMPACT_6C91E7`, a marker that
existed only in the compact-source SessionStart hook output.

Conclusion: inject persistent memory from `SessionStart(source=compact)`. Keep
the PostCompact marker fallback for older Codex versions and regressions; a
successful compact SessionStart clears it before UserPromptSubmit can duplicate
the full injection.

### Claude Code

Observed for manual `/compact`:

1. `PreCompact` with `trigger: "manual"`
2. `SessionStart` with `source: "compact"`
3. `PostCompact` with `trigger: "manual"` and a `compact_summary`

The next response returned `CLAUDE_SESSIONSTART_COMPACT_6C91E7`, a marker that
existed only in the compact-source SessionStart hook output.

Conclusion: inject persistent memory from `SessionStart(source=compact)`.
PostCompact is suitable for logging or external-state updates, but its output
cannot alter the compacted context and should not be the reinjection path.

### OpenCode

Observed for manual `/compact` with the V1 plugin API:

1. `experimental.session.compacting`
2. `experimental.chat.system.transform` for the compaction model request
3. public `session.compacted` event
4. `experimental.chat.system.transform` again for the next agent model request

The first post-compaction response returned
`OPENCODE_SYSTEM_REQUEST_4_6C91E7`, the marker created by the new system
transform invocation after compaction.

Conclusion: OpenCode does not need a SessionStart-style reinjection hook. The
system/context transform rebuilds external memory for each agent request. Do not
copy the complete memory index into the compaction checkpoint; that would make a
stale duplicate. Use the compaction hook only for transient work state that must
be represented in the generated checkpoint.

OpenCode V2 was not installed on this machine. Its adapter remains covered by
the automated callback test, and the documented V2 `context` hook runs before
agent model requests while `compaction` is a separate auxiliary-request hook.
