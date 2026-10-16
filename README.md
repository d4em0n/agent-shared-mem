# shared-memory-runtime v2

A tool-neutral persistent-memory runtime for Codex, Claude Code, OpenCode, and
Hermes Agent.

## Storage

Version 2 has exactly two scopes:

    ~/.local/share/agent-memory/global/  global preferences and machine facts
    <project>/.agent-memory/             repository-specific facts

Each store contains `MEMORY.md`, `PROTOCOL.md`, `SCOPE.md`, and one Markdown
file per fact. Project facts override same-title global facts. `PROTOCOL.md`
is read on demand, not injected at every session. A store may use
`INDEX-<topic>.md` files to keep the root index small; prompt recall follows
those indexes recursively while SessionStart injects only concise runtime
instructions and `MEMORY.md`.

Index entries always point to fact files inside the memory store. A fact is a
recall map: it tells a future agent what matters, what is true, which
authoritative file to open, and where to continue. It is not another project
notebook. Project/reference facts list authoritative artifacts in YAML
`metadata.sources` and link them in the body. Agents update an existing topic
card before creating another one; a new fact is for a distinct recall trigger,
authority, or lifecycle, never a shard of one growing notebook.

Project stores are added to `.git/info/exclude`, keeping them local without
editing the repository's committed `.gitignore`.

## Initialize

    shared-memory init global
    shared-memory init project --project /path/to/repo
    shared-memory status --project /path/to/repo

`status` reports root-index bytes, nested indexes, indexed facts, invalid or
duplicate pointers, fact-size health, missing/broken canonical sources, and the
estimated combined SessionStart context health. The runtime prepends a
maintenance notice before oversized content, so the notice remains visible
even if a client truncates the index itself.

Default warning thresholds are 14 KiB per root index and 16 KiB for the
combined injected context. Facts warn at 6 KiB and require compaction at
10 KiB. Fact compaction keeps current truth, why/how, authority, continuation,
and canonical KB pointers; it does not split detail into near-duplicate facts.
Index splitting is semantic and remains agent-led:
move coherent pointer lines into an `INDEX-<topic>.md`, leave one descriptive
root pointer, and never move or duplicate the underlying fact files. Thresholds
can be adjusted with:

    AGENT_MEMORY_INDEX_WARN_BYTES
    AGENT_MEMORY_INDEX_MAX_BYTES
    AGENT_MEMORY_CONTEXT_WARN_BYTES
    AGENT_MEMORY_CONTEXT_MAX_BYTES
    AGENT_MEMORY_FACT_WARN_BYTES
    AGENT_MEMORY_FACT_MAX_BYTES

On the first project initialization, the CLI checks for an existing Claude Code
project-memory directory. If one exists, it asks whether to copy that directory
wholesale into `.agent-memory`. The source is preserved and merging is never
attempted. For non-interactive use, choose explicitly:

    shared-memory init project --project /path/to/repo --from-claude
    shared-memory init project --project /path/to/repo --fresh

## Install adapters

Review the proposed targets without writing:

    node install.mjs --dry-run

Install all three adapters:

    node install.mjs

Useful flags:

    --no-codex
    --no-claude
    --no-opencode
    --opencode-v2
    --disable-claude-auto-memory
    --home /isolated/test/home
    --repo /absolute/runtime/path

Hermes is opt-in so an existing Hermes profile is not created or changed merely
by installing the original three adapters:

    shared-memory-install --hermes --dry-run
    shared-memory-install --hermes

The Hermes installer writes only
`$HERMES_HOME/plugins/shared-memory/` (default
`~/.hermes/plugins/shared-memory/`). It does not edit `config.yaml` or any other
plugin. Activate it in the intended Hermes profile:

```yaml
memory:
  provider: shared-memory
  memory_enabled: false
  user_profile_enabled: false
```

Use `--hermes-home /path/to/profile/home` to install for a non-default profile
home. Do not disable the whole `memory` toolset: Hermes uses that broader gate
for external providers too.

Codex uses `SessionStart`, `UserPromptSubmit`, and a compaction marker fallback.
Claude Code uses `SessionStart` and `UserPromptSubmit`. OpenCode V1 and V2 have
separate adapters because their plugin APIs differ.

Hermes uses its native `MemoryProvider`: root indexes enter the stable system
prompt, prompt-specific nested-index pointers enter the current user turn, and
the root context is rebuilt at Hermes compression boundaries. The provider does
not ingest full transcripts or expose a competing generic memory tool.

## Test in isolation

    npm test

Tests create temporary homes and repositories. They do not write user-level
Codex, Claude Code, or OpenCode configuration.
