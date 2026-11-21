import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonSafe, writeJsonAtomic } from '../src/fs-json.js'

const dir = () => mkdtempSync(join(tmpdir(), 'ws-fsjson-'))

test('首次写入不生成 .bak，二次写入保留上一版为 .bak', async () => {
  const file = join(dir(), 'a.json')
  await writeJsonAtomic(file, { n: 1 })
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { n: 1 })
  assert.equal(existsSync(`${file}.bak`), false)
  await writeJsonAtomic(file, { n: 2 })
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { n: 2 })
  assert.deepEqual(JSON.parse(readFileSync(`${file}.bak`, 'utf8')), { n: 1 })
  assert.equal(readdirSync(join(file, '..')).some(name => name.endsWith('.tmp')), false)
})

test('主文件缺失时返回 missing', async () => {
  assert.deepEqual(await readJsonSafe(join(dir(), 'none.json')), { status: 'missing', value: undefined })
})

test('主文件损坏时回退到 .bak', async () => {
  const file = join(dir(), 'a.json')
  writeFileSync(file, '{broken')
  writeFileSync(`${file}.bak`, '{"n":1}')
  assert.deepEqual(await readJsonSafe(file), { status: 'backup', value: { n: 1 } })
})

test('主文件和备份都坏时隔离主文件，不删除', async () => {
  const root = dir()
  const file = join(root, 'a.json')
  writeFileSync(file, '{broken')
  const result = await readJsonSafe(file)
  assert.equal(result.status, 'corrupt')
  assert.equal(existsSync(file), false)
  const quarantined = readdirSync(root).find(name => name.startsWith('a.json.corrupt-'))
  assert.equal(readFileSync(join(root, quarantined), 'utf8'), '{broken')
})
