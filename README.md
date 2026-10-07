# shared-memory-runtime v2

A tool-neutral persistent-memory runtime for Codex, Claude Code, and OpenCode.

## Storage

Version 2 has exactly two scopes:

    ~/.local/share/agent-memory/global/  global preferences and machine facts
    <project>/.agent-memory/             repository-specific facts

Each store contains `MEMORY.md`, `PROTOCOL.md`, `SCOPE.md`, and one Markdown
file per fact. Project facts override same-title global facts. A store may use
`INDEX-<topic>.md` files to keep the root index small; prompt recall follows
those indexes recursively while SessionStart injects only `MEMORY.md`.

Index entries always point to fact files inside the memory store. A fact holds
the concise durable result and may link to authoritative project artifacts.
Updating another ledger or documentation tree does not replace shared-memory
maintenance, and agents do not need an explicit user request to update this
store when their work changes durable knowledge.

Project stores are added to `.git/info/exclude`, keeping them local without
editing the repository's committed `.gitignore`.

## Initialize

    shared-memory init global
    shared-memory init project --project /path/to/repo
    shared-memory status --project /path/to/repo

`status` reports root-index bytes, nested indexes, indexed facts, invalid or
duplicate pointers, and the estimated combined SessionStart context health.
The runtime prepends an index-maintenance notice before an oversized index, so
the notice remains visible even if a client truncates the index itself.

Default warning thresholds are 14 KiB per root index and 16 KiB for the
combined injected context. Index splitting is semantic and remains agent-led:
move coherent pointer lines into an `INDEX-<topic>.md`, leave one descriptive
root pointer, and never move or duplicate the underlying fact files. Thresholds
can be adjusted with:

    AGENT_MEMORY_INDEX_WARN_BYTES
    AGENT_MEMORY_INDEX_MAX_BYTES
    AGENT_MEMORY_CONTEXT_WARN_BYTES
    AGENT_MEMORY_CONTEXT_MAX_BYTES

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

Codex uses `SessionStart`, `UserPromptSubmit`, and a compaction marker fallback.
Claude Code uses `SessionStart` and `UserPromptSubmit`. OpenCode V1 and V2 have
separate adapters because their plugin APIs differ.

## Test in isolation

    npm test

Tests create temporary homes and repositories. They do not write user-level
Codex, Claude Code, or OpenCode configuration.
