#!/usr/bin/env node
import { sessionStartContext, promptContext } from '../lib/memory.mjs'

async function main() {
  let raw = ''
  for await (const part of process.stdin) raw += part
  let input
  try { input = JSON.parse(raw) } catch { return }
  const event = input.hook_event_name
  const cwd = input.cwd || process.cwd()
  const context = event === 'SessionStart'
    ? sessionStartContext(cwd)
    : event === 'UserPromptSubmit'
      ? promptContext(cwd, input.prompt || '')
      : ''
  if (context) process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: context },
  }))
}

main().catch(() => {})
