#!/usr/bin/env node

// Codex lifecycle hook: injects persistent memory into the session context.
//
// Codex pipes the event JSON on stdin and reads our stdout back as developer
// context (via hookSpecificOutput.additionalContext). We handle two events:
//   SessionStart      -> standing memory instructions + the live MEMORY.md index
//   UserPromptSubmit  -> the facts most relevant to this prompt (auto-recall)
//
// Registered from ~/.codex/hooks.json (see codex/hooks.json). Trust it once via
// the /hooks TUI command, or run headless with --dangerously-bypass-hook-trust.

import { sessionStartContext, promptContext } from '../lib/memory.mjs'

async function readStdin() {
  let data = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) data += chunk
  return data
}

async function main() {
  let input = {}
  try {
    input = JSON.parse((await readStdin()) || '{}')
  } catch {
    process.exit(0) // malformed input: stay silent, don't disrupt the session
  }

  const event = input.hook_event_name
  const cwd = input.cwd || process.cwd()
  let context = ''

  if (event === 'SessionStart') {
    context = sessionStartContext(cwd)
  } else if (event === 'UserPromptSubmit') {
    context = promptContext(cwd, input.prompt || '')
  }

  if (process.env.SHARED_MEMORY_DEBUG) {
    try {
      const { appendFileSync } = await import('node:fs')
      appendFileSync(
        process.env.SHARED_MEMORY_DEBUG,
        `[fired] event=${event} cwd=${cwd} outputLen=${context.length}\n`,
      )
    } catch {
      /* debug logging best-effort */
    }
  }

  if (context) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: event, additionalContext: context },
      }),
    )
  }
  process.exit(0)
}

main().catch(() => process.exit(0))
