// OpenCode plugin: injects persistent memory into the model context, mirroring
// the Codex hook. Uses the shared core so recall behaves identically.
//
// Injection strategy (string-only — never constructs Part/Message objects):
//   experimental.chat.system.transform  -> push standing instructions + the live
//                                           MEMORY.md index onto output.system,
//                                           plus the facts relevant to the latest
//                                           user prompt (tier-3 recall).
//   chat.message                         -> capture the latest user prompt text so
//                                           system.transform can compute relevance.
//
// Register globally in ~/.config/opencode/opencode.json:
//   { "plugin": ["/home/work/shared-memory-runtime/opencode/memory-plugin.js"] }
// (opencode loads the file in place, so the relative import below resolves.)

import { sessionStartContext, promptContext } from '../lib/memory.mjs'

function dbg(msg) {
  if (!process.env.SHARED_MEMORY_DEBUG) return
  try {
    // eslint-disable-next-line no-undef
    require('node:fs').appendFileSync(process.env.SHARED_MEMORY_DEBUG, msg + '\n')
  } catch {
    import('node:fs').then((fs) => fs.appendFileSync(process.env.SHARED_MEMORY_DEBUG, msg + '\n')).catch(() => {})
  }
}

function extractText(parts) {
  return (parts || [])
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join(' ')
    .trim()
}

export const MemoryPlugin = async ({ directory } = {}) => {
  const cwd = directory || process.cwd()
  dbg(`[init] directory=${directory} cwd=${cwd}`)
  // sessionID -> latest user prompt text, so the system transform can rank facts.
  const lastPrompt = new Map()
  const keyOf = (sessionID) => sessionID || '*'

  return {
    // Fires when a user message arrives — stash its text for relevance ranking.
    'chat.message': async (input, output) => {
      try {
        const text = extractText(output && output.parts)
        dbg(`[chat.message] sessionID=${input && input.sessionID} textLen=${(text || '').length}`)
        if (text) lastPrompt.set(keyOf(input && input.sessionID), text)
      } catch (e) {
        dbg(`[chat.message] THREW ${e && e.stack}`)
        throw e
      }
    },

    // Fires when building the request to the model — append memory to the system
    // prompt. output.system is a string[]; we only push strings.
    'experimental.chat.system.transform': async (input, output) => {
      try {
        dbg(`[system.transform] sessionID=${input && input.sessionID} systemIsArray=${Array.isArray(output && output.system)}`)
        if (!output || !Array.isArray(output.system)) return
        const base = sessionStartContext(cwd) // instructions + index (tier 2)
        if (base) output.system.push(base)
        const prompt = lastPrompt.get(keyOf(input && input.sessionID))
        const recalled = prompt ? promptContext(cwd, prompt) : '' // relevant facts (tier 3)
        if (recalled) output.system.push(recalled)
        dbg(`[system.transform] pushed; system.length now=${output.system.length}`)
      } catch (e) {
        dbg(`[system.transform] THREW ${e && e.stack}`)
        throw e
      }
    },
  }
}

// Export under a couple of names so either loader convention picks it up.
export default MemoryPlugin
export const plugin = MemoryPlugin
