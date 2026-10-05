#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
  const plugin = path.join(repo, 'opencode', useV2 ? 'memory-plugin-v2.js' : 'memory-plugin.js')
  const present = config[key].some((item) =>
    item === plugin || (item && typeof item === 'object' && item.package === plugin))
  if (!present) config[key].push(plugin)
  config.permission ||= {}
  const permissionChanged = config.permission.external_directory === undefined
  if (permissionChanged) config.permission.external_directory = 'allow'
  writeJson(file, config, dryRun)
  return { file, plugin, api: useV2 ? 'v2' : 'v1', changed: !present || permissionChanged, dryRun }
}

export function runInstaller(argv = process.argv.slice(2)) {
  const home = path.resolve(valueAfter(argv, '--home') || os.homedir())
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
  return result
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { process.stdout.write(JSON.stringify(runInstaller(), null, 2) + '\n') }
  catch (error) {
    process.stderr.write(error.message + '\n')
    process.exitCode = 1
  }
}
