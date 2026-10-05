#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sessionStartContext, promptContext } from '../lib/memory.mjs'

function markerPath(id) {
  return path.join(os.tmpdir(), `agent-memory-compact-${String(id).replace(/[^a-zA-Z0-9_-]/g, '_')}`)
}

async function main() {
  let raw = ''
  for await (const part of process.stdin) raw += part
  let input
  try { input = JSON.parse(raw) } catch { return }
  const event = input.hook_event_name
  const cwd = input.cwd || process.cwd()
  const marker = markerPath(input.session_id || cwd)
  let context = ''
  if (event === 'PostCompact') {
    fs.writeFileSync(marker, '1')
    return
  }
  if (event === 'SessionStart') {
    context = sessionStartContext(cwd)
    if (input.source === 'compact' && fs.existsSync(marker)) fs.unlinkSync(marker)
  }
  if (event === 'UserPromptSubmit') {
    const pointer = promptContext(cwd, input.prompt || '')
    if (fs.existsSync(marker)) {
      fs.unlinkSync(marker)
      const base = sessionStartContext(cwd)
      context = [base, pointer].filter(Boolean).join('\n\n')
    } else context = pointer
  }
  if (context) process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: context },
  }))
}

main().catch(() => {})
