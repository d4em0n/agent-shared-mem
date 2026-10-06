import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  globalDir,
  importClaude,
  initGlobal,
  initProject,
  promptContext,
  scopes,
  sessionStartContext,
  status,
} from '../lib/memory.mjs'
import { runInstaller } from '../install.mjs'
import OpenCodeV1 from '../opencode/memory-plugin.js'
import OpenCodeV2 from '../opencode/memory-plugin-v2.js'

const runtime = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-test-'))
  const home = path.join(base, 'home')
  const repo = path.join(base, 'repo')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q', repo])
  return { base, home, repo, dataHome: path.join(home, '.local', 'share') }
}

function addFact(dir, title, file, hook, body) {
  fs.writeFileSync(path.join(dir, file), body + '\n')
  fs.appendFileSync(path.join(dir, 'MEMORY.md'), `- [${title}](${file}) — ${hook}\n`)
}

test('global and project scopes initialize, resolve, and prefer project facts', () => {
  const fx = fixture()
  const global = initGlobal({ home: fx.home, dataHome: fx.dataHome })
  const project = initProject(fx.repo)
  assert.equal(global.dir, path.join(fx.dataHome, 'agent-memory', 'global'))
  assert.equal(project.dir, path.join(fx.repo, '.agent-memory'))
  assert.match(fs.readFileSync(project.excludeFile, 'utf8'), /\.agent-memory/)

  addFact(global.dir, 'Build workflow', 'build.md', 'shared build workflow tools', 'global version')
  addFact(project.dir, 'Build workflow', 'build.md', 'project cargo build workflow', 'project version')
  addFact(global.dir, 'User editor', 'editor.md', 'preferred editor settings', 'vim')

  const nested = path.join(fx.repo, 'src', 'nested')
  fs.mkdirSync(path.join(nested, '.agent-memory'), { recursive: true })
  fs.writeFileSync(path.join(nested, '.agent-memory', 'MEMORY.md'), '# ignored nested store\n')

  const active = scopes(nested, { home: fx.home, dataHome: fx.dataHome })
  assert.deepEqual(active.map((scope) => scope.name), ['global', 'project'])
  assert.equal(active[1].dir, project.dir)
  const session = sessionStartContext(nested, { home: fx.home, dataHome: fx.dataHome })
  assert.match(session, /global memory/)
  assert.match(session, /project memory/)
  const recall = promptContext(nested, 'check the cargo build workflow', {
    home: fx.home, dataHome: fx.dataHome,
  })
  assert.match(recall, /\[project\] Build workflow/)
  assert.doesNotMatch(recall, /\[global\] Build workflow/)
  assert.deepEqual(status(nested, { home: fx.home, dataHome: fx.dataHome }).project,
    { dir: project.dir, initialized: true })
})

test('Claude import copies indexed facts and preserves the source', () => {
  const fx = fixture()
  const encoded = path.resolve(fx.repo).replace(/[^a-zA-Z0-9]/g, '-')
  const source = path.join(fx.home, '.claude', 'projects', encoded, 'memory')
  fs.mkdirSync(source, { recursive: true })
  fs.writeFileSync(path.join(source, 'MEMORY.md'), '- [Legacy fact](legacy.md) — imported legacy target\n')
  fs.writeFileSync(path.join(source, 'legacy.md'), 'legacy remains here\n')
  const result = importClaude(fx.repo, { home: fx.home })
  assert.equal(result.copied, 1)
  assert.equal(fs.readFileSync(path.join(result.destination, 'legacy.md'), 'utf8'), 'legacy remains here\n')
  assert.equal(fs.readFileSync(path.join(source, 'legacy.md'), 'utf8'), 'legacy remains here\n')
})

test('Codex and Claude scripts return model-visible context from isolated stores', () => {
  const fx = fixture()
  const project = initProject(fx.repo)
  addFact(project.dir, 'Target device', 'target.md', 'pixel target device identity', 'pixel test target')
  const env = { ...process.env, AGENT_MEMORY_HOME: fx.home, AGENT_MEMORY_DATA_HOME: fx.dataHome }
  const sessionEvent = JSON.stringify({
    hook_event_name: 'SessionStart', source: 'startup', cwd: fx.repo, session_id: 'isolated-session',
  })
  for (const adapter of ['codex', 'claude']) {
    const run = spawnSync(process.execPath, [path.join(runtime, adapter, 'inject-memory.mjs')], {
      input: sessionEvent, encoding: 'utf8', env,
    })
    assert.equal(run.status, 0)
    const output = JSON.parse(run.stdout)
    assert.match(output.hookSpecificOutput.additionalContext, /Target device/)
  }
  const promptEvent = JSON.stringify({
    hook_event_name: 'UserPromptSubmit', prompt: 'verify pixel target device identity',
    cwd: fx.repo, session_id: 'isolated-prompt',
  })
  const promptRun = spawnSync(process.execPath, [path.join(runtime, 'codex', 'inject-memory.mjs')], {
    input: promptEvent, encoding: 'utf8', env,
  })
  assert.match(JSON.parse(promptRun.stdout).hookSpecificOutput.additionalContext, /target\.md/)

  const compactSession = `isolated-compact-${process.pid}-${Date.now()}`
  const compactRun = spawnSync(process.execPath, [path.join(runtime, 'codex', 'inject-memory.mjs')], {
    input: JSON.stringify({ hook_event_name: 'PostCompact', cwd: fx.repo, session_id: compactSession }),
    encoding: 'utf8', env,
  })
  assert.equal(compactRun.status, 0)
  const afterCompact = spawnSync(process.execPath, [path.join(runtime, 'codex', 'inject-memory.mjs')], {
    input: JSON.stringify({ ...JSON.parse(promptEvent), session_id: compactSession }),
    encoding: 'utf8', env,
  })
  assert.match(JSON.parse(afterCompact.stdout).hookSpecificOutput.additionalContext,
    /# Shared persistent memory/)
})

test('OpenCode V1 and V2 adapters inject the same isolated memory', async () => {
  const fx = fixture()
  process.env.AGENT_MEMORY_HOME = fx.home
  process.env.AGENT_MEMORY_DATA_HOME = fx.dataHome
  const project = initProject(fx.repo)
  addFact(project.dir, 'Browser target', 'browser.md', 'browser webgl target reachability', 'browser fact')

  const v1 = await OpenCodeV1({ directory: fx.repo })
  await v1['chat.message']({ sessionID: 'v1' }, {
    parts: [{ type: 'text', text: 'browser webgl target reachability' }],
  })
  const v1Output = { system: [] }
  await v1['experimental.chat.system.transform']({ sessionID: 'v1' }, v1Output)
  assert.match(v1Output.system.join('\n'), /browser\.md/)

  const handlers = new Map()
  const fake = {
    location: { directory: fx.repo },
    session: { hook: async (name, callback) => handlers.set(name, callback) },
  }
  await OpenCodeV2.setup(fake)
  await handlers.get('prompt')({ sessionID: 'v2', prompt: { text: 'browser webgl target reachability' } })
  const v2Event = { sessionID: 'v2', system: [] }
  await handlers.get('context')(v2Event)
  assert.match(v2Event.system.map((part) => part.text).join('\n'), /browser\.md/)
})

test('installer is idempotent and writes only to an explicit fake home', () => {
  const fx = fixture()
  fs.mkdirSync(path.join(fx.home, '.codex'), { recursive: true })
  fs.writeFileSync(path.join(fx.home, '.codex', 'hooks.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'existing-hook' }] }] },
  }))
  fs.mkdirSync(path.join(fx.home, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(fx.home, '.claude', 'settings.json'), JSON.stringify({ model: 'keep-me' }))
  fs.mkdirSync(path.join(fx.home, '.config', 'opencode'), { recursive: true })
  fs.writeFileSync(path.join(fx.home, '.config', 'opencode', 'opencode.json'), JSON.stringify({
    plugin: ['existing-plugin'], provider: { keep: true },
  }))

  const args = ['--home', fx.home, '--repo', runtime, '--disable-claude-auto-memory']
  const first = runInstaller(args)
  assert.equal(first.codex.changed, true)
  assert.equal(first.opencode.api, 'v1')
  const second = runInstaller(args)
  assert.equal(second.codex.changed, false)
  assert.equal(second.claude.changed, false)
  assert.equal(second.opencode.changed, false)

  const codex = JSON.parse(fs.readFileSync(path.join(fx.home, '.codex', 'hooks.json')))
  assert.equal(codex.hooks.SessionStart[0].hooks[0].command, 'existing-hook')
  const claude = JSON.parse(fs.readFileSync(path.join(fx.home, '.claude', 'settings.json')))
  assert.equal(claude.model, 'keep-me')
  assert.equal(claude.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1')
  const openCode = JSON.parse(fs.readFileSync(path.join(fx.home, '.config', 'opencode', 'opencode.json')))
  assert.deepEqual(openCode.provider, { keep: true })
  assert.equal(openCode.plugin[0], 'existing-plugin')

  const dryHome = path.join(fx.base, 'dry-home')
  runInstaller(['--home', dryHome, '--repo', runtime, '--dry-run'])
  assert.equal(fs.existsSync(dryHome), false)

  const binDir = path.join(fx.base, 'bin')
  fs.mkdirSync(binDir)
  const linkedInstaller = path.join(binDir, 'shared-memory-install')
  fs.symlinkSync(path.join(runtime, 'install.mjs'), linkedInstaller)
  const linkedRun = spawnSync(linkedInstaller,
    ['--home', dryHome, '--repo', runtime, '--dry-run'], { encoding: 'utf8' })
  assert.equal(linkedRun.status, 0)
  assert.equal(JSON.parse(linkedRun.stdout).dryRun, true)
  assert.equal(fs.existsSync(dryHome), false)
})
