import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  globalDir,
  copyClaudeMemory,
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
  const projectStatus = status(nested, { home: fx.home, dataHome: fx.dataHome }).project
  assert.equal(projectStatus.dir, project.dir)
  assert.equal(projectStatus.initialized, true)
  assert.equal(projectStatus.index.health, 'ok')
  assert.equal(projectStatus.index.facts, 1)
})

test('nested indexes are searchable while only the root index is loaded at session start', () => {
  const fx = fixture()
  const project = initProject(fx.repo)
  fs.appendFileSync(path.join(project.dir, 'MEMORY.md'),
    '- [Mali recovery index](INDEX-mali-re.md) — pixel mali reverse engineering and BNDB recovery\n')
  fs.writeFileSync(path.join(project.dir, 'INDEX-mali-re.md'),
    '# Mali recovery\n\n- [Dependency event model](mali-deps.md) — cdeps and cmar event structures\n')
  fs.writeFileSync(path.join(project.dir, 'mali-deps.md'), [
    '---',
    'name: mali-deps',
    'description: Recovered Mali dependency and event structures.',
    'metadata:',
    '  type: project',
    '---',
    '',
    'Durable summary with a link to detailed project evidence.',
    '',
  ].join('\n'))

  const session = sessionStartContext(fx.repo, { home: fx.home, dataHome: fx.dataHome })
  assert.match(session, /Mali recovery index/)
  assert.doesNotMatch(session, /Dependency event model/)
  assert.match(session, /does not require an explicit user\s+request/)

  const recall = promptContext(fx.repo, 'continue the cdeps cmar event recovery', {
    home: fx.home, dataHome: fx.dataHome,
  })
  assert.match(recall, /Dependency event model/)
  assert.match(recall, /mali-deps\.md/)
  assert.match(recall, /maintenance is proactive/)

  const projectStatus = status(fx.repo, { home: fx.home, dataHome: fx.dataHome }).project
  assert.equal(projectStatus.index.nestedIndexes, 1)
  assert.equal(projectStatus.index.facts, 1)
  assert.deepEqual(projectStatus.index.issues, [])
})

test('index health warns before oversized content and rejects external index targets', () => {
  const fx = fixture()
  const project = initProject(fx.repo)
  fs.appendFileSync(path.join(project.dir, 'MEMORY.md'), [
    '- [External detail](../.gpu-brain/detail.md) — invalid direct external pointer',
    '- [Long topic](long.md) — ' + 'durable '.repeat(20),
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(project.dir, 'long.md'), 'fact body\n')
  fs.writeFileSync(path.join(project.dir, 'orphan.md'), 'unindexed fact\n')
  const thresholds = {
    home: fx.home,
    dataHome: fx.dataHome,
    indexWarnBytes: 64,
    indexMaxBytes: 96,
    contextWarnBytes: 128,
    contextMaxBytes: 160,
  }

  const session = sessionStartContext(fx.repo, thresholds)
  const warningAt = session.indexOf('## Shared-memory index maintenance required')
  const indexAt = session.indexOf('## project memory:')
  assert.ok(warningAt >= 0 && warningAt < indexAt)
  assert.match(session, /Combined session-start memory context/)

  const result = status(fx.repo, thresholds)
  assert.equal(result.project.index.health, 'compaction-required')
  assert.deepEqual(result.project.index.issues.map((issue) => issue.code),
    ['outside-store-target', 'unindexed-fact'])
  assert.equal(result.context.health, 'compaction-required')

  const recall = promptContext(fx.repo, 'external detail', thresholds)
  assert.match(recall, /Shared-memory index maintenance required/)
  assert.doesNotMatch(recall, /Possibly relevant memory/)
})

test('Claude bootstrap copies the whole store once and preserves the source', () => {
  const fx = fixture()
  const encoded = path.resolve(fx.repo).replace(/[^a-zA-Z0-9]/g, '-')
  const source = path.join(fx.home, '.claude', 'projects', encoded, 'memory')
  fs.mkdirSync(path.join(source, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(source, 'MEMORY.md'), [
    '- [Legacy fact](legacy.md) — imported legacy target',
    '- [Project reference](.gpu-brain/finding.md) — external project reference',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(source, 'legacy.md'), 'legacy remains here\n')
  fs.writeFileSync(path.join(source, 'unindexed.md'), 'copy this too\n')
  fs.writeFileSync(path.join(source, 'nested', 'note.md'), 'nested fact\n')
  const result = copyClaudeMemory(fx.repo, { home: fx.home })
  assert.equal(result.copied, 4)
  assert.equal(fs.readFileSync(path.join(result.destination, 'legacy.md'), 'utf8'), 'legacy remains here\n')
  assert.equal(fs.readFileSync(path.join(result.destination, 'unindexed.md'), 'utf8'), 'copy this too\n')
  assert.equal(fs.readFileSync(path.join(result.destination, 'nested', 'note.md'), 'utf8'), 'nested fact\n')
  assert.equal(fs.readFileSync(path.join(result.destination, 'MEMORY.md'), 'utf8'),
    fs.readFileSync(path.join(source, 'MEMORY.md'), 'utf8'))
  assert.equal(fs.readFileSync(path.join(source, 'legacy.md'), 'utf8'), 'legacy remains here\n')
  assert.throws(() => copyClaudeMemory(fx.repo, { home: fx.home }), /refusing to merge/)
})

test('project init CLI requires an explicit choice without a TTY', () => {
  const fx = fixture()
  const encoded = path.resolve(fx.repo).replace(/[^a-zA-Z0-9]/g, '-')
  const source = path.join(fx.home, '.claude', 'projects', encoded, 'memory')
  fs.mkdirSync(source, { recursive: true })
  fs.writeFileSync(path.join(source, 'MEMORY.md'), '# Legacy memory\n')
  fs.writeFileSync(path.join(source, 'unindexed.md'), 'whole-store copy\n')
  const cli = path.join(runtime, 'bin', 'shared-memory.mjs')

  const undecided = spawnSync(process.execPath,
    [cli, 'init', 'project', '--project', fx.repo, '--home', fx.home], { encoding: 'utf8' })
  assert.equal(undecided.status, 1)
  assert.match(undecided.stderr, /use --from-claude or --fresh/)
  assert.equal(fs.existsSync(path.join(fx.repo, '.agent-memory')), false)

  const copied = spawnSync(process.execPath,
    [cli, 'init', 'project', '--project', fx.repo, '--home', fx.home, '--from-claude'],
    { encoding: 'utf8' })
  assert.equal(copied.status, 0)
  assert.equal(fs.readFileSync(path.join(fx.repo, '.agent-memory', 'unindexed.md'), 'utf8'),
    'whole-store copy\n')
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

test('Hermes JSON bridge and MemoryProvider expose the shared core', () => {
  const fx = fixture()
  const project = initProject(fx.repo)
  addFact(project.dir, 'Hermes target', 'hermes-target.md',
    'hermes adapter target identity', 'Hermes shared-memory fact')
  const env = { ...process.env, AGENT_MEMORY_HOME: fx.home, AGENT_MEMORY_DATA_HOME: fx.dataHome }
  const bridge = path.join(runtime, 'hermes', 'context.mjs')

  const bridgeRun = spawnSync(process.execPath, [bridge], {
    input: JSON.stringify({
      action: 'prompt', cwd: fx.repo, prompt: 'verify hermes adapter target identity',
    }),
    encoding: 'utf8',
    env,
  })
  assert.equal(bridgeRun.status, 0)
  assert.match(JSON.parse(bridgeRun.stdout).context, /hermes-target\.md/)

  const installArgs = [
    '--home', fx.home,
    '--repo', runtime,
    '--hermes',
    '--no-codex',
    '--no-claude',
    '--no-opencode',
  ]
  const first = runInstaller(installArgs)
  assert.equal(first.hermes.changed, true)
  const second = runInstaller(installArgs)
  assert.equal(second.hermes.changed, false)
  const providerDir = path.join(fx.home, '.hermes', 'plugins', 'shared-memory')
  const runtimeConfig = JSON.parse(fs.readFileSync(path.join(providerDir, 'runtime.json')))
  assert.equal(runtimeConfig.bridge, bridge)
  assert.equal(runtimeConfig.node, process.execPath)

  const harness = [
    'import importlib.util, json, sys, types',
    'plugin, cwd = sys.argv[1], sys.argv[2]',
    'agent = types.ModuleType("agent")',
    'memory_provider = types.ModuleType("agent.memory_provider")',
    'class MemoryProvider: pass',
    'class RecallStatus:',
    '    def __init__(self, provider_label, count, glyph="brain"):',
    '        self.provider_label, self.count, self.glyph = provider_label, count, glyph',
    'memory_provider.MemoryProvider = MemoryProvider',
    'memory_provider.RecallStatus = RecallStatus',
    'sys.modules["agent"] = agent',
    'sys.modules["agent.memory_provider"] = memory_provider',
    'spec = importlib.util.spec_from_file_location("shared_memory_provider", plugin + "/__init__.py")',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'provider = module.SharedMemoryProvider()',
    'provider.initialize("test-session", cwd=cwd)',
    'start = provider.system_prompt_block()',
    'recall = provider.prefetch("verify hermes adapter target identity")',
    'status = provider.recall_status()',
    'print(json.dumps({"available": provider.is_available(), "start": start, "recall": recall,',
    '                  "count": status.count if status else 0, "compress": provider.on_pre_compress([])}))',
  ].join('\n')
  const providerRun = spawnSync('python3', ['-c', harness, providerDir, fx.repo], {
    encoding: 'utf8',
    env,
  })
  assert.equal(providerRun.status, 0, providerRun.stderr)
  const provider = JSON.parse(providerRun.stdout)
  assert.equal(provider.available, true)
  assert.match(provider.start, /Hermes target/)
  assert.match(provider.recall, /hermes-target\.md/)
  assert.equal(provider.count, 1)
  assert.match(provider.compress, /Do not claim a fact was saved/)
})

test('Hermes install dry-run is isolated and refuses an unmanaged target', () => {
  const fx = fixture()
  const hermesHome = path.join(fx.base, 'dry-hermes')
  const args = [
    '--home', fx.home,
    '--repo', runtime,
    '--hermes-home', hermesHome,
    '--hermes',
    '--no-codex',
    '--no-claude',
    '--no-opencode',
    '--dry-run',
  ]
  const result = runInstaller(args)
  assert.equal(result.hermes.changed, true)
  assert.equal(fs.existsSync(hermesHome), false)

  const target = path.join(hermesHome, 'plugins', 'shared-memory')
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, 'plugin.yaml'), 'name: somebody-else\n')
  assert.throws(() => runInstaller(args), /Refusing to overwrite unmanaged Hermes plugin/)
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
