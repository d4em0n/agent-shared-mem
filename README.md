# shared-memory-runtime

Auto-inject Claude-style persistent memory into **Codex** (lifecycle hook) and
**OpenCode** (plugin), at session start and per turn — the runtime counterpart to
[`claude-to-codex-memory-sync`](../claude-to-codex-memory-sync) (which wires the
static `AGENTS.md`/store sharing).

Where the sync repo makes the three tools *share one memory store*, this repo
makes Codex and OpenCode *recall it automatically* — the equivalent of Claude's
SessionStart `MEMORY.md` injection plus relevance-based recall.

## What it injects

Two tiers, mirroring Claude:

1. **Session start** — standing memory instructions + the live `MEMORY.md` index.
2. **Per user turn** — the fact files whose index "hook" best matches the prompt
   (dependency-free keyword overlap over the same `description`/hook signal Claude
   ranks on).

Both read the per-project Claude store at
`~/.claude/projects/<encoded-cwd>/memory/` (walking up from cwd). If a project
has no store, nothing is injected (set `SHARED_MEMORY_ALWAYS=1` to inject the
standing instructions everywhere anyway).

## Layout

```
lib/memory.mjs            shared core (resolve store, read index, rank facts)
codex/inject-memory.mjs   Codex hook: reads event JSON on stdin, prints additionalContext
opencode/memory-plugin.js OpenCode plugin: pushes memory onto the system prompt
install.mjs               wires both tools (idempotent)
```

The Codex hook and OpenCode plugin both import `lib/memory.mjs`, so recall is
identical across tools.

## Install

```bash
node install.mjs            # both tools   (flags: --no-codex / --no-opencode)
```

This writes `~/.codex/hooks.json` (SessionStart + UserPromptSubmit → the hook) and
adds the plugin to `~/.config/opencode/opencode.json` (plus
`permission.external_directory: "allow"`, needed because the store lives outside
the project).

### Codex — REQUIRES a one-time `/hooks` enable ⚠️

Codex does **not** run a newly-added hook until you review and enable it
interactively:

1. Run `codex` in any project that has a memory store.
2. Type `/hooks`, select the `inject-memory` hook, and **enable + trust** it.

After that it fires on every session/turn. `--dangerously-bypass-hook-trust`
skips the trust *review* for headless `codex exec`, but does **not** substitute
for the one-time enable. (This bit us for a long time during development: the hook
config is correct, but the command silently never runs until enabled.)

### OpenCode — auto-loaded, watch for stray plugins

OpenCode auto-loads every `*.ts`/`*.js` in `~/.config/opencode/plugin/` **and**
the plugins listed in `opencode.json`'s `plugin` array. A single broken plugin in
that directory (e.g. one that pushes a message `part` with a non-`prt_` id) makes
the OpenCode server reject *every* plugin-loading run with
`invalid user part before save`. If OpenCode breaks after adding plugins, audit
`~/.config/opencode/plugin/` for debris. `opencode run --pure` disables all
plugins and is a good isolation test.

## Verify

In a project with a memory store, ask the agent something only present in memory,
with tools off — it should answer from the injected context:

```bash
# OpenCode (verified working):
opencode run "Without using tools, answer only from context: <a fact in memory>"
```

## Debug

Set `SHARED_MEMORY_DEBUG=/path/to/log` and both the hook and plugin append a line
per invocation (event, cwd, whether output was produced, throws). Invaluable for
confirming the tool is actually calling the hook/plugin.

## Status

Both verified end-to-end (injected memory reached the model with tools off):

- **OpenCode plugin** — works out of the box once installed.
- **Codex hook** — works after the one-time `/hooks` enable described above.
