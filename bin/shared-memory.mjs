#!/usr/bin/env node
import path from 'node:path'
import { initGlobal, initProject, importClaude, status } from '../lib/memory.mjs'

const argv = process.argv.slice(2)
const command = argv[0]
const target = argv[1]
const valueAfter = (flag) => {
  const index = argv.indexOf(flag)
  return index < 0 ? null : argv[index + 1]
}
const options = {}
if (valueAfter('--home')) options.home = path.resolve(valueAfter('--home'))
const cwd = path.resolve(valueAfter('--project') || process.cwd())

try {
  let result
  if (command === 'init' && target === 'global') result = initGlobal(options)
  else if (command === 'init' && target === 'project')
    result = initProject(cwd, { exclude: !argv.includes('--no-exclude') })
  else if (command === 'status') result = status(cwd, options)
  else if (command === 'import' && target === 'claude')
    result = importClaude(cwd, { ...options, source: valueAfter('--source') || undefined })
  else throw new Error(
    'Usage: shared-memory init global | init project [--project PATH] | status | import claude [--project PATH] [--source PATH]',
  )
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} catch (error) {
  process.stderr.write(error.message + '\n')
  process.exitCode = 1
}
