#!/usr/bin/env node
import { promptContext, sessionStartContext } from '../lib/memory.mjs'

async function readInput() {
  let raw = ''
  for await (const part of process.stdin) raw += part
  if (!raw.trim()) throw new Error('Expected a JSON request on stdin')
  return JSON.parse(raw)
}

async function main() {
  const input = await readInput()
  const action = input.action
  const cwd = input.cwd || process.cwd()
  const options = input.options && typeof input.options === 'object' ? input.options : {}
  let context
  if (action === 'session-start') context = sessionStartContext(cwd, options)
  else if (action === 'prompt') context = promptContext(cwd, input.prompt || '', options)
  else throw new Error(`Unknown context action: ${action}`)
  process.stdout.write(JSON.stringify({ ok: true, action, context }) + '\n')
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n')
  process.exitCode = 1
})
