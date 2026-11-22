import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { crc32, createZip } from '../client/zip.js'

test('zip.js 纯函数且不含 node:* 或 DOM 全局对象', async () => {
  const src = await readFile(new URL('../client/zip.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /from\s+['"]node:/)
  assert.doesNotMatch(src, /\b(?:document|window)\b/)
})

test('crc32 符合标准 IEEE 802.3 校验值', () => {
  const bytes = new TextEncoder().encode('hello')
  assert.equal(crc32(bytes), 0x3610a686)
  assert.equal(crc32(new Uint8Array(0)), 0)
})

test('createZip 生成有效、可复现、支持 UTF-8 文件名的 STORE ZIP', () => {
  const f1 = { name: '01.png', data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) }
  const f2 = { name: '封面卡片-02.png', data: new TextEncoder().encode('fake-png-payload') }

  const zip1 = createZip([f1, f2])
  const zip2 = createZip([f1, f2])
  assert.deepEqual(zip1, zip2)

  // Local file header signature: PK\x03\x04
  assert.deepEqual([...zip1.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04])

  // Check UTF-8 flag bit 11 (0x0800) in first local header flags (offset 6..7)
  const view = new DataView(zip1.buffer, zip1.byteOffset, zip1.byteLength)
  assert.equal(view.getUint16(6, true) & 0x0800, 0x0800)

  // Count Central Directory headers (PK\x01\x02)
  let cdCount = 0
  for (let i = 0; i <= zip1.length - 4; i++) {
    if (zip1[i] === 0x50 && zip1[i + 1] === 0x4b && zip1[i + 2] === 0x01 && zip1[i + 3] === 0x02) {
      cdCount += 1
      assert.equal(view.getUint16(i + 8, true) & 0x0800, 0x0800)
    }
  }
  assert.equal(cdCount, 2)

  // End of Central Directory (PK\x05\x06) at end (22 bytes, empty comment)
  const eocdOffset = zip1.length - 22
  assert.deepEqual([...zip1.slice(eocdOffset, eocdOffset + 4)], [0x50, 0x4b, 0x05, 0x06])
  assert.equal(view.getUint16(eocdOffset + 8, true), 2)
  assert.equal(view.getUint16(eocdOffset + 10, true), 2)
})
