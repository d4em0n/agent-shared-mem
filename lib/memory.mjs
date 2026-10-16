import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export const PROTOCOL = `# Memory protocol

This store is proactive shared memory. A user does not need to explicitly ask
for a durable fact to be saved. When work establishes or changes reusable
knowledge, update memory before finishing the work.

## Files

- \`MEMORY.md\` is the root index and is loaded at session start.
- \`INDEX-<kebab-topic>.md\` is an optional nested topic index.
- \`<kebab-fact>.md\` contains one curated durable fact.

Indexes contain pointers only, using
\`- [Title](file.md) — relevance hook\`. Every fact is indexed exactly once,
and every index target must be a file inside this store. A fact body may link
to source code, databases, research ledgers, logs, or other authoritative
project artifacts. Updating one of those external artifacts does not replace
updating the shared-memory fact when the durable recall state changed.

Read the root index first and open only relevant facts. When working a topic,
open its nested index if useful. Verify drift-prone facts. Before writing, look
for an existing fact to update. Do not record temporary task state, secrets, or
information already available from source control.

Fact files use this frontmatter:

\`\`\`yaml
---
name: kebab-case-name
description: One-line relevance hook
metadata:
  type: project
  topics:
    - useful-search-term
  status: active
  updated: YYYY-MM-DD
  sources:
    - ../path/to/canonical-project-kb.md
---
\`\`\`

\`name\`, \`description\`, and \`metadata.type\` are required. Type is one of
\`user\`, \`feedback\`, \`project\`, or \`reference\`. Topics, status, and
updated are optional. \`metadata.sources\` lists canonical artifacts outside the
memory store; local paths are relative to the fact file. It is required when a
project or reference fact summarizes an existing project KB, and especially
before that fact reaches the size warning.

A fact is a routing card, not a second project notebook. Its job is to tell a
future agent what matters, what is currently true, which authoritative file to
open, and where to continue. Put that current truth, why/how, authority,
continuation boundary, and evidence links near the top. Keep detailed structs,
audit chronology, negative-result lists, raw evidence, and session narration in
the canonical project KB. Update that KB first, then update only the durable
summary or checkpoint here. Aim to keep each fact below 6 KiB; at 10 KiB it
requires compaction when that fact is next relevant or updated. Do not
mass-rewrite unrelated facts without checking their canonical evidence, and do
not split one KB topic into many memory facts merely to evade the budget.
Create a new fact only when it has a genuinely different recall trigger,
authority, or lifecycle; otherwise update the existing routing card. Never
delete unique knowledge merely to meet a budget: compact only after the detail
exists in a canonical artifact; if none exists, keep the warning until a safe
canonical home can be established. Do not copy an entire session log.

Keep user preferences, hard rules, current targets, active findings, and
cross-cutting workflows in MEMORY.md. When a coherent topic grows or MEMORY.md
approaches its context budget, move only that topic's pointer lines into an
\`INDEX-<kebab-topic>.md\` file and leave one descriptive pointer to the nested
index in MEMORY.md. Do not move or duplicate the fact files. Prefer one nesting
level, keep every fact indexed exactly once, and never delete information merely
to satisfy the size budget.
`

export const INSTRUCTIONS = `# Shared persistent memory

The active global and project stores are listed below. Read only fact files
relevant to this request. Treat memory as point-in-time context and verify
drift-prone facts. Project facts take precedence over conflicting global facts.

Memory maintenance is proactive. Save changed durable knowledge before
finishing, without waiting for an explicit request. Use global memory for
cross-project rules and project memory for repository-specific knowledge.

Facts are recall maps, not project notebooks: say what matters, what is true,
which authoritative file to open, and where to continue. Put detail in the
canonical project KB and link it in YAML \`metadata.sources\` and the body.
Search first; update the existing topic card. Create another fact only for a
distinct recall trigger, authority, or lifecycle. Compact an oversized fact
when it is relevant or updated; preserve unique knowledge and never shard one
growing notebook across near-duplicates.

Index each fact exactly once. New facts require YAML \`name\`, \`description\`,
and \`metadata.type\`; follow PROTOCOL.md. Do not save transient state, secrets,
or facts already in Git.
`

export const DEFAULT_INDEX_WARN_BYTES = 14 * 1024
export const DEFAULT_INDEX_MAX_BYTES = 17 * 1024
export const DEFAULT_CONTEXT_WARN_BYTES = 16 * 1024
export const DEFAULT_CONTEXT_MAX_BYTES = 19 * 1024
export const DEFAULT_FACT_WARN_BYTES = 6 * 1024
export const DEFAULT_FACT_MAX_BYTES = 10 * 1024

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

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : fallback
}

function limits(options = {}) {
  return {
    indexWarnBytes: positiveInteger(options.indexWarnBytes ??
      process.env.AGENT_MEMORY_INDEX_WARN_BYTES, DEFAULT_INDEX_WARN_BYTES),
    indexMaxBytes: positiveInteger(options.indexMaxBytes ??
      process.env.AGENT_MEMORY_INDEX_MAX_BYTES, DEFAULT_INDEX_MAX_BYTES),
    contextWarnBytes: positiveInteger(options.contextWarnBytes ??
      process.env.AGENT_MEMORY_CONTEXT_WARN_BYTES, DEFAULT_CONTEXT_WARN_BYTES),
    contextMaxBytes: positiveInteger(options.contextMaxBytes ??
      process.env.AGENT_MEMORY_CONTEXT_MAX_BYTES, DEFAULT_CONTEXT_MAX_BYTES),
    factWarnBytes: positiveInteger(options.factWarnBytes ??
      process.env.AGENT_MEMORY_FACT_WARN_BYTES, DEFAULT_FACT_WARN_BYTES),
    factMaxBytes: positiveInteger(options.factMaxBytes ??
      process.env.AGENT_MEMORY_FACT_MAX_BYTES, DEFAULT_FACT_MAX_BYTES),
  }
}

function resolveIndexTarget(store, indexFile, reference) {
  const base = path.resolve(store)
  const target = path.resolve(path.dirname(indexFile), reference)
  if (!target.startsWith(base + path.sep)) return { code: 'outside-store-target', target }
  try {
    const stat = fs.lstatSync(target)
    if (!stat.isFile() || stat.isSymbolicLink()) return { code: 'unsafe-target', target }
    return { target }
  } catch { return { code: 'missing-target', target } }
}

function nestedIndex(file) {
  return /^INDEX-[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/.test(path.basename(file))
}

function indexCatalog(scope) {
  const root = path.join(scope.dir, 'MEMORY.md')
  const visited = new Set()
  const facts = []
  const indexes = []
  const issues = []
  const factLocations = new Map()
  const titleLocations = new Map()
  let entries = 0

  function walk(indexFile, parents = [], stack = []) {
    const resolved = path.resolve(indexFile)
    if (stack.includes(resolved)) {
      issues.push({ code: 'index-cycle', file: resolved })
      return
    }
    if (visited.has(resolved)) {
      issues.push({ code: 'duplicate-index', file: resolved })
      return
    }
    visited.add(resolved)
    if (resolved !== root) indexes.push(resolved)
    let text
    try { text = fs.readFileSync(resolved, 'utf8') }
    catch {
      issues.push({ code: 'missing-index', file: resolved })
      return
    }
    for (const entry of parseIndex(text)) {
      entries += 1
      const result = resolveIndexTarget(scope.dir, resolved, entry.file)
      if (result.code) {
        issues.push({ code: result.code, file: resolved, reference: entry.file,
          target: result.target })
        continue
      }
      if (nestedIndex(result.target)) {
        walk(result.target, [...parents, entry], [...stack, resolved])
        continue
      }
      const titleKey = entry.title.trim().toLowerCase()
      const priorTitle = titleLocations.get(titleKey)
      if (priorTitle && priorTitle.target !== result.target) {
        issues.push({ code: 'duplicate-title', title: entry.title, file: resolved,
          reference: entry.file, target: result.target, firstIndex: priorTitle.indexFile,
          firstTarget: priorTitle.target })
        continue
      }
      const prior = factLocations.get(result.target)
      if (prior) {
        issues.push({ code: 'duplicate-fact', file: resolved, reference: entry.file,
          target: result.target, firstIndex: prior })
        continue
      }
      factLocations.set(result.target, resolved)
      titleLocations.set(titleKey, { target: result.target, indexFile: resolved })
      facts.push({ ...entry, fact: result.target, scope, indexFile: resolved,
        parentText: parents.map((parent) => `${parent.title} ${parent.hook}`).join(' ') })
    }
  }

  walk(root)

  function findUnindexed(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        issues.push({ code: 'unsafe-store-entry', file })
        continue
      }
      if (entry.isDirectory()) {
        findUnindexed(file)
        continue
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md') continue
      const resolved = path.resolve(file)
      if (resolved === root || ['PROTOCOL.md', 'SCOPE.md'].includes(entry.name)) continue
      if (nestedIndex(resolved)) {
        if (!visited.has(resolved)) issues.push({ code: 'unindexed-index', file: resolved })
      } else if (!factLocations.has(resolved)) {
        issues.push({ code: 'unindexed-fact', file: resolved })
      }
    }
  }

  findUnindexed(scope.dir)
  return { root, facts, indexes, issues, entries }
}

function factFrontmatter(text) {
  return String(text).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || ''
}

function unquoteYamlScalar(value) {
  const trimmed = String(value).trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
    return trimmed.slice(1, -1)
  return trimmed
}

function factMetadata(text) {
  const frontmatter = factFrontmatter(text)
  const lines = frontmatter.split(/\r?\n/)
  let inMetadata = false
  let inSources = false
  let name = ''
  let type = ''
  const sources = []
  for (const line of lines) {
    if (!line.trim()) continue
    const indent = line.match(/^\s*/)[0].length
    if (indent === 0) {
      const nameHit = line.match(/^name\s*:\s*(.*?)\s*$/)
      if (nameHit) name = unquoteYamlScalar(nameHit[1])
      inMetadata = /^metadata\s*:\s*$/.test(line.trim())
      inSources = false
      continue
    }
    if (!inMetadata) continue
    if (indent === 2) {
      const typeHit = line.match(/^\s{2}type\s*:\s*(.*?)\s*$/)
      if (typeHit) type = unquoteYamlScalar(typeHit[1])
      const sourceHit = line.match(/^\s{2}sources\s*:\s*(.*?)\s*$/)
      inSources = Boolean(sourceHit)
      if (sourceHit?.[1] && sourceHit[1] !== '[]') {
        for (const item of sourceHit[1].replace(/^\[/, '').replace(/\]$/, '').split(','))
          if (item.trim()) sources.push(unquoteYamlScalar(item))
      }
      continue
    }
    if (inSources && indent >= 4) {
      const item = line.match(/^\s*-\s*(.*?)\s*$/)
      if (item && item[1]) sources.push(unquoteYamlScalar(item[1]))
    }
  }
  return { name, type, sources }
}

function factSourceIssue(scope, fact, source) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return undefined
  const store = path.resolve(scope.dir)
  const target = path.resolve(path.dirname(fact), source)
  if (target === store || target.startsWith(store + path.sep))
    return { code: 'source-inside-memory-store', fact, source, target }
  try {
    const stat = fs.lstatSync(target)
    if (!stat.isFile() || stat.isSymbolicLink())
      return { code: 'unsafe-source', fact, source, target }
  } catch {
    return { code: 'missing-source', fact, source, target }
  }
  return undefined
}

function factsHealth(scope, catalog, policy) {
  const oversized = []
  const missingSources = []
  const sourceIssues = []
  const duplicateNames = []
  const names = new Map()
  for (const entry of catalog.facts) {
    const text = fs.readFileSync(entry.fact, 'utf8')
    const bytes = Buffer.byteLength(text)
    const metadata = factMetadata(text)
    if (metadata.name) {
      const first = names.get(metadata.name)
      if (first)
        duplicateNames.push({ name: metadata.name, first, file: entry.fact })
      else
        names.set(metadata.name, entry.fact)
    }
    if (bytes >= policy.factWarnBytes) {
      oversized.push({
        file: entry.fact,
        bytes,
        type: metadata.type || null,
        sources: metadata.sources,
        level: bytes >= policy.factMaxBytes ? 'compaction-required' : 'warning',
      })
      if (['project', 'reference'].includes(metadata.type) && !metadata.sources.length)
        missingSources.push({ file: entry.fact, bytes, type: metadata.type })
    }
    for (const source of metadata.sources) {
      const issue = factSourceIssue(scope, entry.fact, source)
      if (issue) sourceIssues.push(issue)
    }
  }
  oversized.sort((a, b) => b.bytes - a.bytes || a.file.localeCompare(b.file))
  let health = 'ok'
  if (oversized.some((fact) => fact.level === 'compaction-required'))
    health = 'compaction-required'
  else if (oversized.length || missingSources.length || sourceIssues.length ||
      duplicateNames.length)
    health = 'warning'
  return {
    health,
    warnBytes: policy.factWarnBytes,
    maxBytes: policy.factMaxBytes,
    oversized,
    missingSources,
    sourceIssues,
    duplicateNames,
  }
}

function storeHealth(scope, options = {}) {
  const policy = limits(options)
  const catalog = indexCatalog(scope)
  const bytes = fs.statSync(catalog.root).size
  let health = 'ok'
  if (bytes >= policy.indexMaxBytes) health = 'compaction-required'
  else if (bytes >= policy.indexWarnBytes || catalog.issues.length) health = 'warning'
  return {
    bytes,
    health,
    entries: catalog.entries,
    facts: catalog.facts.length,
    nestedIndexes: catalog.indexes.length,
    issues: catalog.issues,
    limits: { warnBytes: policy.indexWarnBytes, maxBytes: policy.indexMaxBytes },
    factHealth: factsHealth(scope, catalog, policy),
  }
}

function indexSections(active) {
  return active.map((scope) =>
    `\n## ${scope.name} memory: ${scope.dir}\n${readIndex(scope.dir) || '(Empty index)'}`)
}

function contextHealth(bytes, options = {}) {
  const policy = limits(options)
  return {
    bytes,
    health: bytes >= policy.contextMaxBytes ? 'compaction-required'
      : bytes >= policy.contextWarnBytes ? 'warning' : 'ok',
    warnBytes: policy.contextWarnBytes,
    maxBytes: policy.contextMaxBytes,
  }
}

function maintenanceNotice(active, options = {}, { contextBytes, hardOnly = false } = {}) {
  const lines = []
  for (const scope of active) {
    const health = storeHealth(scope, options)
    const items = []
    if (health.health === 'compaction-required' || (!hardOnly && health.health === 'warning')) {
      items.push(`MEMORY.md ${health.bytes}/${health.limits.maxBytes} bytes`)
    }
    if (!hardOnly && health.issues.length)
      items.push(`${health.issues.length} index pointer issue(s)`)
    const factHealth = health.factHealth
    const reportFacts = hardOnly
      ? factHealth.oversized.filter((fact) => fact.level === 'compaction-required')
      : factHealth.oversized
    if (reportFacts.length) {
      const largest = reportFacts[0]
      items.push(`${reportFacts.length} oversized fact(s); largest ${path.basename(largest.file)} ${largest.bytes} bytes`)
    }
    if (!hardOnly && factHealth.missingSources.length)
      items.push(`${factHealth.missingSources.length} oversized project/reference fact(s) without metadata.sources`)
    if (!hardOnly && factHealth.sourceIssues.length)
      items.push(`${factHealth.sourceIssues.length} canonical source issue(s)`)
    if (!hardOnly && factHealth.duplicateNames.length)
      items.push(`${factHealth.duplicateNames.length} duplicate fact name(s)`)
    if (items.length) lines.push(`- ${scope.name}: ${items.join('; ')}.`)
  }
  if (contextBytes !== undefined) {
    const health = contextHealth(contextBytes, options)
    if (health.health === 'compaction-required' || (!hardOnly && health.health === 'warning'))
      lines.push(`- Combined session-start memory context: ${contextBytes}/${health.maxBytes} bytes.`)
  }
  if (!lines.length) return ''
  return `## Shared-memory maintenance required

${lines.join('\n')}

Move root pointer groups into \`INDEX-<topic>.md\`. As relevant facts are
touched, compact them into recall maps only after preserving detail in the KB;
update the existing topic card instead of sharding it.`
}

const STOP = new Set('the a an and or of to in on for is are be this that with you your our can do how what why when it its as at by we us me my from into about so if not no yes use using make made just like want'.split(' '))
function tokens(value) {
  return new Set((String(value).toLowerCase().match(/[a-z0-9]{3,}/g) || [])
    .filter((term) => !STOP.has(term)))
}

function entriesFor(active) {
  const titles = new Map()
  for (const scope of active) {
    for (const entry of indexCatalog(scope).facts)
      titles.set(entry.title.toLowerCase(), entry)
  }
  return [...titles.values()]
}

export function selectRelevant(active, prompt, { max = 2, minScore = 1.5 } = {}) {
  const entries = entriesFor(active)
  const query = tokens(prompt)
  if (!entries.length || !query.size) return []
  const counts = new Map()
  const allTokens = entries.map((entry) => {
    const set = tokens(`${entry.title} ${entry.hook} ${entry.parentText}`)
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
  const sections = indexSections(active)
  const base = [INSTRUCTIONS, ...sections].join('\n')
  const notice = maintenanceNotice(active, options, {
    contextBytes: Buffer.byteLength(base),
  })
  return [INSTRUCTIONS, notice, ...sections].filter(Boolean).join('\n')
}

export function promptContext(cwd, prompt, options = {}) {
  const active = scopes(cwd, options)
  const hits = selectRelevant(active, prompt, options)
  const notice = maintenanceNotice(active, options, { hardOnly: true })
  const recall = hits.length
    ? '## Possibly relevant memory\nOpen only if useful to this request:\n' +
      hits.map((hit) => `- [${hit.scope.name}] ${hit.title} — ${hit.hook} → ${hit.fact}`).join('\n') +
      '\n\nShared-memory maintenance is proactive and does not require an explicit user request.'
    : ''
  return [notice, recall].filter(Boolean).join('\n\n')
}

export function status(cwd, options = {}) {
  const root = projectRoot(cwd)
  const global = globalDir(options)
  const project = path.join(root, '.agent-memory')
  const active = scopes(cwd, options)
  const sections = indexSections(active)
  const base = active.length ? [INSTRUCTIONS, ...sections].join('\n') : ''
  const describe = (name, dir) => {
    const initialized = isStore(dir)
    if (!initialized) return { dir, initialized }
    const health = storeHealth({ name, dir }, options)
    const { factHealth: facts, ...index } = health
    return { dir, initialized, index, facts }
  }
  return {
    root,
    context: contextHealth(Buffer.byteLength(base), options),
    global: describe('global', global),
    project: describe('project', project),
  }
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
