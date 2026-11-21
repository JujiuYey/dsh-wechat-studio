// Expand test files ourselves: Windows cmd does not expand globs, and Node's
// directory discovery differs between supported Node releases.
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const files = readdirSync(new URL('../test/', import.meta.url))
  .filter(name => name.endsWith('.test.js'))
  .sort()
  .map(name => new URL(`../test/${name}`, import.meta.url))
const { fileURLToPath } = await import('node:url')
const result = spawnSync(process.execPath, ['--test', ...files.map(fileURLToPath), ...process.argv.slice(2)], { stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
