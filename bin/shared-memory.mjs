#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import {
  claudeLegacyDir,
  copyClaudeMemory,
  initGlobal,
  initProject,
  isStore,
  projectDir,
  projectRoot,
  status,
} from '../lib/memory.mjs'

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

async function chooseClaudeCopy(source) {
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new Error(`Claude memory found at ${source}; use --from-claude or --fresh`)
  const input = createInterface({ input: process.stdin, output: process.stderr })
  try {
    for (;;) {
      const answer = (await input.question(
        `Existing Claude memory found at ${source}. Copy it into project memory? [y/n] `,
      )).trim().toLowerCase()
      if (answer === 'y' || answer === 'yes') return true
      if (answer === 'n' || answer === 'no') return false
      process.stderr.write('Please answer y or n.\n')
    }
  } finally {
    input.close()
  }
}

async function main() {
  let result
  if (command === 'init' && target === 'global') result = initGlobal(options)
  else if (command === 'init' && target === 'project') {
    const fromClaude = argv.includes('--from-claude')
    const fresh = argv.includes('--fresh')
    if (fromClaude && fresh) throw new Error('Choose only one of --from-claude or --fresh')
    const root = projectRoot(cwd)
    const destination = projectDir(root)
    const source = claudeLegacyDir(root, options)
    let copy = fromClaude
    if (!fs.existsSync(destination) && !fromClaude && !fresh && isStore(source))
      copy = await chooseClaudeCopy(source)
    result = copy
      ? copyClaudeMemory(root, { ...options, exclude: !argv.includes('--no-exclude') })
      : initProject(root, { exclude: !argv.includes('--no-exclude') })
  }
  else if (command === 'status') result = status(cwd, options)
  else throw new Error(
    'Usage: shared-memory init global | init project [--project PATH] [--from-claude|--fresh] | status',
  )
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
}

main().catch((error) => {
  process.stderr.write(error.message + '\n')
  process.exitCode = 1
})
