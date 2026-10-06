import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export const PROTOCOL = `# Memory protocol

Each durable fact lives in one Markdown file. MEMORY.md is an index containing
one line per fact: \`- [Title](file.md) — relevance hook\`.

Read the index first; open only relevant fact files. Verify facts that may have
changed. Before writing, look for an existing fact to update. Do not record
temporary task state or information already available in the repository.

Fact files use this frontmatter:

\`\`\`yaml
---
name: kebab-case-name
description: One-line relevance hook
metadata:
  type: user | feedback | project | reference
---
\`\`\`

After adding a fact file, add one pointer to MEMORY.md.
`

export const INSTRUCTIONS = `# Shared persistent memory

The active global and project stores are listed below. Read only fact files
relevant to this request. Treat memory as point-in-time context and verify
drift-prone facts. Project facts take precedence over conflicting global facts.

Write durable cross-project preferences and machine-wide workflows to global
memory. Write repository-specific goals, constraints, architecture, and
workflows to project memory. If uncertain, choose project. Write a fact to one
scope only. Check for an existing fact before adding one, and follow that
store's PROTOCOL.md. Do not save transient task state or facts already in Git.
`

function homeOf(options = {}) {
  return path.resolve(options.home || process.env.AGENT_MEMORY_HOME || os.homedir())
}

export function globalDir(options = {}) {
  const home = homeOf(options)
  const data = options.dataHome || process.env.AGENT_MEMORY_DATA_HOME ||
    (options.home ? null : process.env.XDG_DATA_HOME) || path.join(home, '.local', 'share')
  return path.join(path.resolve(data), 'agent-memory', 'global')
}

function ancestors(start) {
  const list = []
  let current = path.resolve(start || process.cwd())
  for (;;) {
    list.push(current)
    if (current === path.parse(current).root) return list
    current = path.dirname(current)
  }
}

function plainDirectory(file) {
  try {
    const stat = fs.lstatSync(file)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch { return false }
}

export function isStore(dir) {
  if (!plainDirectory(dir)) return false
  try {
    const stat = fs.lstatSync(path.join(dir, 'MEMORY.md'))
    return stat.isFile() && !stat.isSymbolicLink()
  } catch { return false }
}

export function projectRoot(cwd) {
  const lineage = ancestors(cwd)
  const git = lineage.find((dir) => fs.existsSync(path.join(dir, '.git')))
  if (git) return git
  return lineage.find((dir) => isStore(path.join(dir, '.agent-memory'))) || lineage[0]
}

export function projectDir(cwd) {
  return path.join(projectRoot(cwd), '.agent-memory')
}

export function scopes(cwd, options = {}) {
  const found = []
  const global = globalDir(options)
  if (isStore(global)) found.push({ name: 'global', dir: global, priority: 0 })
  const project = projectDir(cwd)
  if (isStore(project)) found.push({ name: 'project', dir: project, priority: 1 })
  return found
}

function writeNew(file, text) {
  try {
    fs.writeFileSync(file, text, { flag: 'wx' })
    return true
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  }
}

function initStore(dir, scope, root) {
  if (fs.existsSync(dir) && !plainDirectory(dir))
    throw new Error(`Refusing symlinked or non-directory store: ${dir}`)
  fs.mkdirSync(dir, { recursive: true })
  const created = []
  if (writeNew(path.join(dir, 'MEMORY.md'), '# Memory index\n')) created.push('MEMORY.md')
  if (writeNew(path.join(dir, 'PROTOCOL.md'), PROTOCOL)) created.push('PROTOCOL.md')
  const scopeText = scope === 'global'
    ? '# Global scope\n\nStore cross-project user preferences and machine-wide facts here.\n'
    : `# Project scope\n\nApplies to ${root}. Store repository-specific facts here.\n`
  if (writeNew(path.join(dir, 'SCOPE.md'), scopeText)) created.push('SCOPE.md')
  return { scope, dir, created }
}

export function initGlobal(options = {}) {
  return initStore(globalDir(options), 'global')
}

function excludeProjectStore(root) {
  if (!fs.existsSync(path.join(root, '.git'))) return undefined
  const file = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute',
    '--git-path', 'info/exclude'], { encoding: 'utf8' }).trim()
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  if (original.split(/\r?\n/).includes('/.agent-memory/')) return undefined
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${original && !original.endsWith('\n') ? '\n' : ''}/.agent-memory/\n`)
  return file
}

export function initProject(cwd, { exclude = true } = {}) {
  const root = projectRoot(cwd)
  const result = initStore(path.join(root, '.agent-memory'), 'project', root)
  if (exclude) result.excludeFile = excludeProjectStore(root)
  return { ...result, root }
}

export function readIndex(dir) {
  try { return fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8').trim() }
  catch { return '' }
}

export function parseIndex(text) {
  const entries = []
  for (const line of String(text || '').split('\n')) {
    const hit = line.match(/^\s*-\s*\[([^\]]+)\]\(([^)]+)\)\s*(?:[—–-]+\s*)?(.*)$/)
    if (hit) entries.push({ title: hit[1], file: hit[2], hook: hit[3] })
  }
  return entries
}

function safeFile(dir, file, exists = true) {
  const base = path.resolve(dir)
  const target = path.resolve(base, file)
  if (!target.startsWith(base + path.sep)) return null
  if (!exists) return target
  try {
    const stat = fs.lstatSync(target)
    return stat.isFile() && !stat.isSymbolicLink() ? target : null
  } catch { return null }
}

const STOP = new Set('the a an and or of to in on for is are be this that with you your our can do how what why when it its as at by we us me my from into about so if not no yes use using make made just like want'.split(' '))
function tokens(value) {
  return new Set((String(value).toLowerCase().match(/[a-z0-9]{3,}/g) || [])
    .filter((term) => !STOP.has(term)))
}

function entriesFor(active) {
  const titles = new Map()
  for (const scope of active) {
    for (const entry of parseIndex(readIndex(scope.dir))) {
      const fact = safeFile(scope.dir, entry.file)
      if (fact) titles.set(entry.title.toLowerCase(), { ...entry, fact, scope })
    }
  }
  return [...titles.values()]
}

export function selectRelevant(active, prompt, { max = 2, minScore = 1.5 } = {}) {
  const entries = entriesFor(active)
  const query = tokens(prompt)
  if (!entries.length || !query.size) return []
  const counts = new Map()
  const allTokens = entries.map((entry) => {
    const set = tokens(`${entry.title} ${entry.hook}`)
    for (const token of set) counts.set(token, (counts.get(token) || 0) + 1)
    return set
  })
  const limit = Math.max(3, entries.length * 0.4)
  const weighted = entries.map((entry, i) => {
    let score = 0
    for (const token of allTokens[i]) {
      const count = counts.get(token)
      if (query.has(token) && count <= limit)
        score += Math.log((entries.length + 1) / (count + 1)) + 1
    }
    return { ...entry, score }
  }).filter((entry) => entry.score >= minScore)
    .sort((a, b) => b.score - a.score || b.scope.priority - a.scope.priority)
  if (!weighted.length) return []
  return weighted.filter((entry) => entry.score >= weighted[0].score * 0.6)
    .slice(0, max)
}

export function sessionStartContext(cwd, options = {}) {
  const active = scopes(cwd, options)
  if (!active.length) return ''
  const parts = [INSTRUCTIONS]
  for (const scope of active) {
    parts.push(`\n## ${scope.name} memory: ${scope.dir}\n${readIndex(scope.dir) || '(Empty index)'}`)
  }
  return parts.join('\n')
}

export function promptContext(cwd, prompt, options = {}) {
  const hits = selectRelevant(scopes(cwd, options), prompt, options)
  if (!hits.length) return ''
  return '## Possibly relevant memory\nOpen only if useful to this request:\n' +
    hits.map((hit) => `- [${hit.scope.name}] ${hit.title} — ${hit.hook} → ${hit.fact}`).join('\n')
}

export function status(cwd, options = {}) {
  const root = projectRoot(cwd)
  const global = globalDir(options)
  const project = path.join(root, '.agent-memory')
  return { root, global: { dir: global, initialized: isStore(global) },
    project: { dir: project, initialized: isStore(project) } }
}

export function claudeLegacyDir(root, options = {}) {
  const encoded = path.resolve(root).replace(/[^a-zA-Z0-9]/g, '-')
  return path.join(homeOf(options), '.claude', 'projects', encoded, 'memory')
}

function countFiles(dir) {
  let count = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) count += countFiles(file)
    else count += 1
  }
  return count
}

export function copyClaudeMemory(project, options = {}) {
  const root = projectRoot(project)
  const source = path.resolve(options.source || claudeLegacyDir(root, options))
  if (!isStore(source)) throw new Error(`Claude store not found: ${source}`)
  const destination = path.resolve(options.destination || path.join(root, '.agent-memory'))
  if (fs.existsSync(destination))
    throw new Error(`Project memory already exists; refusing to merge: ${destination}`)
  const copied = countFiles(source)
  fs.cpSync(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
  })
  const initialized = initStore(destination, 'project', root)
  if (options.exclude !== false) initialized.excludeFile = excludeProjectStore(root)
  return { source, destination, copied, created: initialized.created, root }
}
