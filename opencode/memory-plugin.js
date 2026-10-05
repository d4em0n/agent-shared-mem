// OpenCode V1 adapter. OpenCode V2 uses opencode/memory-plugin-v2.js.
import { sessionStartContext, promptContext } from '../lib/memory.mjs'

function textOf(parts) {
  return (parts || []).filter((part) => part?.type === 'text')
    .map((part) => part.text || '').join(' ').trim()
}

export const MemoryPlugin = async ({ directory } = {}) => {
  const cwd = directory || process.cwd()
  const latest = new Map()
  const key = (id) => id || '*'
  return {
    'chat.message': async (input, output) => {
      const prompt = textOf(output?.parts)
      if (prompt) latest.set(key(input?.sessionID), prompt)
    },
    'experimental.chat.system.transform': async (input, output) => {
      if (!Array.isArray(output?.system)) return
      const base = sessionStartContext(cwd)
      const pointer = promptContext(cwd, latest.get(key(input?.sessionID)) || '')
      if (base) output.system.push(base)
      if (pointer) output.system.push(pointer)
    },
  }
}

export default MemoryPlugin
export const plugin = MemoryPlugin
