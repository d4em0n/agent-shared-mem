// OpenCode V2 adapter. Uses the documented context hook and prompt admission.
import { sessionStartContext, promptContext } from '../lib/memory.mjs'

export default {
  id: 'agent-memory',
  async setup(ctx) {
    const cwd = ctx.location?.directory || process.cwd()
    const latest = new Map()
    await ctx.session.hook('prompt', (event) => {
      if (event.prompt?.text) latest.set(event.sessionID, event.prompt.text)
    })
    await ctx.session.hook('context', (event) => {
      if (!Array.isArray(event.system)) return
      const base = sessionStartContext(cwd)
      const pointer = promptContext(cwd, latest.get(event.sessionID) || '')
      if (base) event.system.push({ type: 'text', text: base })
      if (pointer) event.system.push({ type: 'text', text: pointer })
    })
  },
}
