// Package entrypoint for the OpenCode V2 plugin. Re-exported through
// package.json (exports "./server" and "main") so OpenCode can resolve the
// adapter regardless of which loading strategy it uses.
export { default } from './memory-plugin-v2.js'
