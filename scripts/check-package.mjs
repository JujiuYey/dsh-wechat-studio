import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
assert.equal(lock.name, pkg.name)
assert.equal(lock.version, pkg.version)
assert.equal(lock.packages[''].version, pkg.version)
for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
  assert.equal(Object.keys(pkg[field] || {}).length, 0, `${field} breaks the zero-dependency contract`)
}
if (process.env.GITHUB_REF_TYPE === 'tag') {
  assert.equal(process.env.GITHUB_REF_NAME, `v${pkg.version}`, 'Tag must exactly match package.json version')
}
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
for (const file of files) {
  const content = readFileSync(file)
  if (!content.includes(0)) {
    assert.doesNotMatch(content.toString('utf8'), /^(?:<{7}(?: |$)|={7}$|>{7}(?: |$))/m, `Conflict marker in ${file}`)
  }
}
console.log(`Package metadata and ${files.length} tracked files checked`)
