#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_REPO = path.dirname(fileURLToPath(import.meta.url))

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag)
  return index < 0 ? null : argv[index + 1]
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return structuredClone(fallback)
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) }
  catch (error) { throw new Error(`Refusing to overwrite invalid JSON at ${file}: ${error.message}`) }
}

function writeJson(file, value, dryRun) {
  if (dryRun) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

function writeText(file, value, dryRun) {
  if (dryRun) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value)
}

function sameText(file, value) {
  try { return fs.readFileSync(file, 'utf8') === value }
  catch { return false }
}

function hasCommand(groups, command) {
  return groups.some((group) => (group.hooks || []).some((hook) => hook.command === command))
}

function addCommand(groups, command, options = {}) {
  if (hasCommand(groups, command)) return false
  const hook = { type: 'command', command, timeout: 30 }
  if (options.statusMessage) hook.statusMessage = options.statusMessage
  if (options.additionalContextLimit) hook.additionalContextLimit = options.additionalContextLimit
  const group = { hooks: [hook] }
  if (options.matcher) group.matcher = options.matcher
  groups.push(group)
  return true
}

export function installCodex({ home, repo, dryRun }) {
  const file = path.join(home, '.codex', 'hooks.json')
  const config = readJson(file, {})
  config.hooks ||= {}
  config.hooks.SessionStart ||= []
  config.hooks.UserPromptSubmit ||= []
  config.hooks.PostCompact ||= []
  const command = `node ${shellQuote(path.join(repo, 'codex', 'inject-memory.mjs'))}`
  let changed = false
  changed = addCommand(config.hooks.SessionStart, command, {
    matcher: 'startup|resume|clear|compact',
    statusMessage: 'Loading shared memory',
    additionalContextLimit: 5000,
  }) || changed
  changed = addCommand(config.hooks.UserPromptSubmit, command, {
    additionalContextLimit: 2500,
  }) || changed
  changed = addCommand(config.hooks.PostCompact, command) || changed
  writeJson(file, config, dryRun)
  return { file, command, changed, dryRun }
}

export function installClaude({ home, repo, dryRun, disableClaudeAutoMemory }) {
  const file = path.join(home, '.claude', 'settings.json')
  const config = readJson(file, {})
  config.hooks ||= {}
  config.hooks.SessionStart ||= []
  config.hooks.UserPromptSubmit ||= []
  const command = `node ${shellQuote(path.join(repo, 'claude', 'inject-memory.mjs'))}`
  let changed = false
  changed = addCommand(config.hooks.SessionStart, command, {
    matcher: 'startup|resume|clear|compact|fork',
    statusMessage: 'Loading shared memory',
  }) || changed
  changed = addCommand(config.hooks.UserPromptSubmit, command) || changed
  if (disableClaudeAutoMemory) {
    config.env ||= {}
    if (config.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY !== '1') {
      config.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
      changed = true
    }
  }
  writeJson(file, config, dryRun)
  return { file, command, changed, dryRun, disableClaudeAutoMemory }
}

export function installOpenCode({ home, repo, dryRun, openCodeV2 }) {
  const file = path.join(home, '.config', 'opencode', 'opencode.json')
  const config = readJson(file, { $schema: 'https://opencode.ai/config.json' })
  config.$schema ||= 'https://opencode.ai/config.json'
  const useV2 = openCodeV2 || Array.isArray(config.plugins)
  const key = useV2 ? 'plugins' : 'plugin'
  config[key] = Array.isArray(config[key]) ? config[key] : []
  // OpenCode V2 only accepts package or directory plugin paths; a bare .js file
  // path is rejected at every server start ("configured plugin path must be a
  // directory"), so the v2 adapter is wired through the package directory.
  const packageDir = path.join(repo, 'opencode')
  const legacyV2File = path.join(repo, 'opencode', 'memory-plugin-v2.js')
  const plugin = useV2 ? packageDir : path.join(repo, 'opencode', 'memory-plugin.js')
  let removedLegacy = 0
  if (useV2) {
    const before = config[key].length
    config[key] = config[key].filter((item) => {
      const pkg = item && typeof item === 'object' ? item.package : item
      return pkg !== legacyV2File
    })
    removedLegacy = before - config[key].length
  }
  const present = config[key].some((item) =>
    item === plugin || (item && typeof item === 'object' && item.package === plugin))
  if (!present) config[key].push(plugin)
  config.permission ||= {}
  const permissionChanged = config.permission.external_directory === undefined
  if (permissionChanged) config.permission.external_directory = 'allow'
  writeJson(file, config, dryRun)
  return { file, plugin, api: useV2 ? 'v2' : 'v1', changed: !present || permissionChanged || removedLegacy > 0, removedLegacy, dryRun }
}

export function installHermes({ hermesHome, repo, dryRun, node = process.execPath }) {
  const source = path.join(repo, 'hermes', 'provider')
  const bridge = path.join(repo, 'hermes', 'context.mjs')
  const target = path.join(hermesHome, 'plugins', 'shared-memory')
  if (!fs.existsSync(path.join(source, '__init__.py')) || !fs.existsSync(bridge))
    throw new Error(`Hermes adapter source is incomplete under ${path.join(repo, 'hermes')}`)
  if (fs.existsSync(target)) {
    if (!fs.statSync(target).isDirectory())
      throw new Error(`Refusing to replace non-directory Hermes plugin target ${target}`)
    const manifest = path.join(target, 'plugin.yaml')
    const managed = fs.existsSync(manifest) &&
      /^name:\s*shared-memory\s*$/m.test(fs.readFileSync(manifest, 'utf8'))
    if (!managed)
      throw new Error(`Refusing to overwrite unmanaged Hermes plugin directory ${target}`)
  }

  const contents = new Map()
  for (const name of ['__init__.py', 'plugin.yaml', 'README.md'])
    contents.set(path.join(target, name), fs.readFileSync(path.join(source, name), 'utf8'))
  contents.set(path.join(target, 'runtime.json'), JSON.stringify({
    node: path.resolve(node),
    bridge: path.resolve(bridge),
  }, null, 2) + '\n')
  const changedEntries = [...contents].filter(([file, value]) => !sameText(file, value))
  const changedFiles = changedEntries.map(([file]) => file)
  for (const [file, value] of changedEntries) writeText(file, value, dryRun)
  return {
    directory: target,
    changed: changedFiles.length > 0,
    changedFiles,
    dryRun,
    configuration: {
      memory: {
        provider: 'shared-memory',
        memory_enabled: false,
        user_profile_enabled: false,
      },
    },
  }
}

export function runInstaller(argv = process.argv.slice(2)) {
  const explicitHome = valueAfter(argv, '--home')
  const home = path.resolve(explicitHome || os.homedir())
  const repo = path.resolve(valueAfter(argv, '--repo') || DEFAULT_REPO)
  const dryRun = argv.includes('--dry-run')
  const common = { home, repo, dryRun }
  const result = { home, repo, dryRun }
  if (!argv.includes('--no-codex')) result.codex = installCodex(common)
  if (!argv.includes('--no-claude')) result.claude = installClaude({
    ...common,
    disableClaudeAutoMemory: argv.includes('--disable-claude-auto-memory'),
  })
  if (!argv.includes('--no-opencode')) result.opencode = installOpenCode({
    ...common,
    openCodeV2: argv.includes('--opencode-v2'),
  })
  if (argv.includes('--hermes')) {
    const configuredHermesHome = valueAfter(argv, '--hermes-home') ||
      (!explicitHome ? process.env.HERMES_HOME : null)
    result.hermes = installHermes({
      hermesHome: path.resolve(configuredHermesHome || path.join(home, '.hermes')),
      repo,
      dryRun,
    })
  }
  return result
}

function isMain() {
  if (!process.argv[1]) return false
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1])
  } catch {
    return false
  }
}

if (isMain()) {
  try { process.stdout.write(JSON.stringify(runInstaller(), null, 2) + '\n') }
  catch (error) {
    process.stderr.write(error.message + '\n')
    process.exitCode = 1
  }
}
