#!/usr/bin/env node

// Wire the shared-memory runtime into Codex and OpenCode, globally & idempotently.
//
//   Codex     -> ~/.codex/hooks.json : SessionStart + UserPromptSubmit run the
//                Codex hook (node codex/inject-memory.mjs).
//   OpenCode  -> ~/.config/opencode/opencode.json : add the plugin to "plugin"
//                and ensure permission.external_directory = "allow" (so it can
//                read the memory store, which lives under ~/.claude).
//
// Flags: --no-codex  --no-opencode
//
// After install: in Codex, run the `/hooks` TUI once to TRUST the hook (or pass
// --dangerously-bypass-hook-trust for headless `codex exec`).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.dirname(fileURLToPath(import.meta.url))
const CODEX_HOOK = path.join(REPO, 'codex', 'inject-memory.mjs')
const OPENCODE_PLUGIN = path.join(REPO, 'opencode', 'memory-plugin.js')
const CODEX_CMD = `node ${CODEX_HOOK}`

const has = (flag) => process.argv.includes(flag)
const home = os.homedir()

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function ensureCodexHandler(eventArr) {
  // eventArr is an array of matcher-groups. Skip if our command is already there.
  const already = eventArr.some((g) =>
    (g.hooks || []).some((h) => h && h.command === CODEX_CMD),
  )
  if (already) return false
  eventArr.push({ hooks: [{ type: 'command', command: CODEX_CMD, timeout: 30 }] })
  return true
}

function installCodex() {
  const file = path.join(home, '.codex', 'hooks.json')
  const cfg = readJson(file) || {}
  cfg.hooks = cfg.hooks || {}
  cfg.hooks.SessionStart = cfg.hooks.SessionStart || []
  cfg.hooks.UserPromptSubmit = cfg.hooks.UserPromptSubmit || []

  // SessionStart wants a source matcher; add it only if our command is absent.
  const ssAlready = cfg.hooks.SessionStart.some((g) =>
    (g.hooks || []).some((h) => h && h.command === CODEX_CMD),
  )
  let changed = false
  if (!ssAlready) {
    cfg.hooks.SessionStart.push({
      matcher: 'startup|resume|clear',
      hooks: [
        { type: 'command', command: CODEX_CMD, statusMessage: 'Loading persistent memory', timeout: 30 },
      ],
    })
    changed = true
  }
  changed = ensureCodexHandler(cfg.hooks.UserPromptSubmit) || changed

  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n')
  return { file, changed, command: CODEX_CMD, note: 'trust once via the /hooks TUI in Codex' }
}

function installOpencode() {
  const file = path.join(home, '.config', 'opencode', 'opencode.json')
  const cfg = readJson(file) || { $schema: 'https://opencode.ai/config.json' }
  cfg.$schema = cfg.$schema || 'https://opencode.ai/config.json'

  cfg.plugin = Array.isArray(cfg.plugin) ? cfg.plugin : []
  const pluginListed = cfg.plugin.some((p) => p === OPENCODE_PLUGIN || (Array.isArray(p) && p[0] === OPENCODE_PLUGIN))
  if (!pluginListed) cfg.plugin.push(OPENCODE_PLUGIN)

  cfg.permission = cfg.permission || {}
  if (cfg.permission.external_directory === undefined) cfg.permission.external_directory = 'allow'

  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n')
  return { file, plugin: OPENCODE_PLUGIN, externalDirectory: cfg.permission.external_directory }
}

const result = { repo: REPO }
if (!has('--no-codex')) result.codex = installCodex()
if (!has('--no-opencode')) result.opencode = installOpencode()
process.stdout.write(JSON.stringify(result, null, 2) + '\n')
