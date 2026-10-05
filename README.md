# shared-memory-runtime v2

A tool-neutral persistent-memory runtime for Codex, Claude Code, and OpenCode.

## Storage

Version 2 has exactly two scopes:

    ~/.local/share/agent-memory/global/  global preferences and machine facts
    <project>/.agent-memory/             repository-specific facts

Each store contains `MEMORY.md`, `PROTOCOL.md`, `SCOPE.md`, and one Markdown
file per fact. Project facts override same-title global facts. Nested memory
stores are not loaded.

Project stores are added to `.git/info/exclude`, keeping them local without
editing the repository's committed `.gitignore`.

## Initialize

    node bin/shared-memory.mjs init global
    node bin/shared-memory.mjs init project --project /path/to/repo
    node bin/shared-memory.mjs status --project /path/to/repo

Import an existing Claude Code project-memory store non-destructively:

    node bin/shared-memory.mjs import claude --project /path/to/repo

The importer copies indexed facts, preserves the source, and aborts before
writing if it finds conflicting titles or file contents.

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
