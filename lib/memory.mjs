// Shared, tool-agnostic memory core. Both the Codex hook and the OpenCode plugin
// import this so recall/injection behaves identically across tools.
//
// It resolves the per-project Claude memory dir from a working directory, reads
// the MEMORY.md index, and (for per-turn recall) selects the facts whose index
// "hook" best matches the user's prompt — the same description-based signal
// Claude uses, implemented as dependency-free keyword overlap.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The standing memory protocol, injected once per session so the model knows it
// has a persistent memory and how to maintain it. Tool-neutral by design.
export const MEMORY_INSTRUCTIONS = `# Persistent memory

You maintain a persistent, file-based memory so context survives across sessions
and tools. The store for this project is shown below.

## Recall
- The memory index (MEMORY.md) is included below — one line per fact. Open a
  specific fact file (with your file-reading tool) only when it's relevant to the
  task; don't read them all. Relevant facts may also be injected automatically.
- Treat memory as point-in-time context. If a fact names a file, function, or
  flag, verify it still exists before relying on it.

## Write — proactively, without being asked
Save a memory the moment you learn something durable you'd want next time:
- user — who the user is (role, expertise, preferences)
- feedback — how the user wants you to work (a correction or a confirmed
  approach); include the why
- project — ongoing goals/constraints not derivable from code or git; use
  absolute dates
- reference — external resources (URLs, tickets, dashboards)

One file = one fact, kebab-case slug, with frontmatter (name / description /
metadata.type), then add a one-line pointer to MEMORY.md. Never put fact content
in the index. See PROTOCOL.md in the memory dir for the full schema.

## Maintain
Check for an existing file before saving — update, don't duplicate; delete wrong
ones. Don't save what the repo/git already records or what's only relevant to the
current conversation.`

// Claude encodes a project path by replacing every non-alphanumeric char with a
// dash, e.g. /opt/kernel_research -> -opt-kernel-research.
export function encodeProjectPath(projectPath) {
  return path.resolve(projectPath).replace(/[^a-zA-Z0-9]/g, '-')
}

export function memoryDirFor(projectPath) {
  return path.join(os.homedir(), '.claude', 'projects', encodeProjectPath(projectPath), 'memory')
}

// Walk up from cwd to the nearest ancestor that already has a memory store (a
// MEMORY.md), so a session opened in a subdirectory still finds the project's
// memory. Returns null when no store exists anywhere up the tree.
export function findMemoryDir(cwd) {
  let dir = path.resolve(cwd || process.cwd())
  const root = path.parse(dir).root
  for (;;) {
    if (fs.existsSync(path.join(memoryDirFor(dir), 'MEMORY.md'))) return memoryDirFor(dir)
    if (dir === root) break
    dir = path.dirname(dir)
  }
  return null
}

// Like findMemoryDir but falls back to cwd's own encoded dir (a sensible home
// for a first write) when no store exists yet.
export function resolveMemoryDir(cwd) {
  return findMemoryDir(cwd) || memoryDirFor(cwd || process.cwd())
}

export function readIndex(memoryDir) {
  try {
    return fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8').trim()
  } catch {
    return ''
  }
}

// Parse "- [Title](file.md) — hook" index lines (em-dash or hyphen separator).
export function parseIndex(indexText) {
  const entries = []
  for (const line of indexText.split('\n')) {
    const m = line.match(/^\s*-\s*\[([^\]]+)\]\(([^)]+)\)\s*(?:[—–-]+\s*)?(.*)$/)
    if (m) entries.push({ title: m[1], file: m[2], hook: m[3] || '' })
  }
  return entries
}

const STOPWORDS = new Set(
  ('the a an and or of to in on for is are be this that with you your our can do how what why when ' +
    'it its as at by we us me my from into about so if not no yes use using make made just like want')
    .split(' '),
)

function tokenize(text) {
  const out = new Set()
  for (const w of String(text).toLowerCase().match(/[a-z0-9]{3,}/g) || []) {
    if (!STOPWORDS.has(w)) out.add(w)
  }
  return out
}

// Tier-3 recall: rank index entries by keyword overlap with the prompt, return
// the top matches with their full fact bodies.
export function selectRelevant(memoryDir, prompt, { max = 3, minScore = 1 } = {}) {
  const entries = parseIndex(readIndex(memoryDir))
  if (!entries.length || !prompt) return []
  const terms = tokenize(prompt)
  if (!terms.size) return []
  return entries
    .map((e) => {
      const hay = tokenize(`${e.title} ${e.hook}`)
      let score = 0
      for (const t of terms) if (hay.has(t)) score++
      return { entry: e, score }
    })
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((s) => {
      let body = ''
      try {
        body = fs.readFileSync(path.join(memoryDir, s.entry.file), 'utf8').trim()
      } catch {
        /* fact file missing or moved — skip body */
      }
      return { ...s.entry, body }
    })
    .filter((h) => h.body)
}

// Set SHARED_MEMORY_ALWAYS=1 to inject the standing instructions even in projects
// that have no memory store yet (so the model is nudged to start one anywhere).
const ALWAYS = process.env.SHARED_MEMORY_ALWAYS === '1'

// Built once per session: standing instructions + the live index. Returns '' when
// the project has no memory store (unless SHARED_MEMORY_ALWAYS=1).
export function sessionStartContext(cwd) {
  const memoryDir = findMemoryDir(cwd)
  if (!memoryDir) {
    return ALWAYS ? MEMORY_INSTRUCTIONS : ''
  }
  const index = readIndex(memoryDir)
  const parts = [MEMORY_INSTRUCTIONS, `\nMemory store: ${memoryDir}`]
  parts.push(
    index
      ? `\n## Memory index (MEMORY.md)\n${index}`
      : '\n(The memory index is empty — create memories as you learn durable facts.)',
  )
  return parts.join('\n')
}

// Built per user turn: facts relevant to this prompt (empty string if none / no store).
export function promptContext(cwd, prompt, opts) {
  const memoryDir = findMemoryDir(cwd)
  if (!memoryDir) return ''
  const hits = selectRelevant(memoryDir, prompt, opts)
  if (!hits.length) return ''
  const blocks = hits.map((h) => `### ${h.title} (${h.file})\n${h.body}`)
  return `## Recalled memory (relevant to this request)\n\n${blocks.join('\n\n')}`
}
