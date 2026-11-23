import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { mkdir, readdir, readFile, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { deflateSync } from 'node:zlib'
import {
  CUSTOM_STYLE_PREVIEW_FILES,
  deleteCustomCoverStyle,
  detectImageContentType,
  listCoverStyles,
  pruneExpiredDrafts,
  readCustomCoverStyle,
  readCustomStylePreview,
  readDraftPreview,
  resolveCoverStyle,
  saveCustomCoverStyle,
  saveDraftPreview,
  validateCustomStyleInput,
} from '../src/custom-cover-styles.js'
import jpeg from 'jpeg-js'

const crcTable = (() => {
  const table = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
const crc32 = buf => {
  let crc = 0xffffffff
  for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function makePng(width = 94, height = 40) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const off = y * (width * 3 + 1)
    for (let x = 0; x < width; x++) { const p = off + 1 + x * 3; raw[p] = 0x22; raw[p + 1] = 0x44; raw[p + 2] = 0x88 }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
function makeJpeg(width = 94, height = 40) {
  const data = Buffer.alloc(width * height * 4, 0x80)
  return Buffer.from(jpeg.encode({ data, width, height }, 85).data)
}

const VALID_TEMPLATE = [
  '21:9 宽幅黑金科技杂志风封面，深炭黑底（#141414），香槟金强调色（#D4AF37）。',
  '主标题：{{主标题第一行}} / {{主标题第二行}}',
  '右侧视觉元素：{{右侧视觉元素}}',
  '```code-fence-inside-template',
  'keep verbatim',
  '```',
].join('\n')

test('CRUD 与排序：空目录返回 7 套内置，新建/读取/更新/删除完整落盘且反引号围栏无损', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-custom-style-crud-'))
  const initial = await listCoverStyles(root)
  assert.equal(initial.styles.length, 7)
  assert.deepEqual(initial.warnings, [])
  assert.ok(initial.styles.every(s => s.source === 'builtin'))

  const { draftToken } = await saveDraftPreview(root, makePng(94, 40), 'png')
  const first = await saveCustomCoverStyle(root, {
    name: '黑金杂志风',
    description: '深炭黑底与香槟金标题，适合深度评测。',
    usePortrait: false,
    userRequirement: '黑金杂志风，不要真人',
    template: VALID_TEMPLATE,
    guidance: '标题每行不超过 8 字',
    previewDraftToken: draftToken,
  })
  assert.match(first.style.id, /^custom-[a-f0-9]{8}$/)
  assert.equal(first.style.source, 'custom')
  assert.equal(first.style.previewFile, 'preview.png')
  assert.equal(first.styles.length, 8)

  // 确认磁盘结构为 meta.json + template.txt + guidance.txt + preview.png，且草稿图已被转正清理
  const styleDir = join(root, 'cover-styles', first.style.id)
  const files = (await readdir(styleDir)).sort()
  assert.deepEqual(files, ['guidance.txt', 'meta.json', 'preview.png', 'template.txt'])
  assert.equal(await readFile(join(styleDir, 'template.txt'), 'utf8'), VALID_TEMPLATE)
  await assert.rejects(readDraftPreview(root, draftToken))

  // 再建第 2 套，确保按 createdAt 升序排在内置 7 套之后
  await new Promise(r => setTimeout(r, 15))
  const second = await saveCustomCoverStyle(root, {
    name: '极简白纸风',
    description: '高留白纯文字封面，适合观点随笔。',
    usePortrait: true,
    template: '白纸底，标题 {{主标题}}，视觉 {{核心符号}}，人物 [[SUBJECT]] 穿 [[OUTFIT]]',
    guidance: '',
  })
  assert.equal(second.style.previewFile, null)
  const listed = await listCoverStyles(root)
  assert.equal(listed.styles.length, 9)
  assert.deepEqual(listed.styles.slice(7).map(s => s.id), [first.style.id, second.style.id])

  // 读取详情与 resolveCoverStyle
  const full = await readCustomCoverStyle(root, first.style.id)
  assert.equal(full.template, VALID_TEMPLATE)
  assert.equal(full.guidance, '标题每行不超过 8 字')
  assert.equal((await resolveCoverStyle(root, 'classic')).source, 'builtin')
  assert.equal((await resolveCoverStyle(root, first.style.id)).source, 'custom')

  // 更新保留 createdAt 与原预览图，更新 updatedAt
  await new Promise(r => setTimeout(r, 15))
  const updated = await saveCustomCoverStyle(root, {
    id: first.style.id,
    name: '黑金杂志风Pro',
    description: '升级版黑金杂志风。',
    usePortrait: false,
    userRequirement: '黑金杂志风升级',
    template: VALID_TEMPLATE + '\n补充一行',
    guidance: '新指引',
  })
  assert.equal(updated.style.createdAt, first.style.createdAt)
  assert.notEqual(updated.style.updatedAt, first.style.updatedAt)
  assert.equal(updated.style.previewFile, 'preview.png', '编辑未重试图且未换参考图时保留原预览')

  // 删除移除目录
  const afterDelete = await deleteCustomCoverStyle(root, first.style.id)
  assert.equal(afterDelete.styles.length, 8)
  assert.equal(await readCustomCoverStyle(root, first.style.id), null)
})

test('校验边界：字段长度、少于 2 个占位符、禁用词、30 套上限与禁止改删内置风格', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-custom-style-limits-'))
  assert.throws(() => validateCustomStyleInput({ name: '', description: 'x', template: VALID_TEMPLATE }, []), err => err.status === 400)
  assert.throws(() => validateCustomStyleInput({ name: '字'.repeat(17), description: 'x', template: VALID_TEMPLATE }, []), err => err.status === 400)
  assert.throws(() => validateCustomStyleInput({ name: '合法', description: '', template: VALID_TEMPLATE }, []), err => err.status === 400)
  assert.throws(() => validateCustomStyleInput({ name: '合法', description: '描'.repeat(81), template: VALID_TEMPLATE }, []), err => err.status === 400)
  assert.throws(() => validateCustomStyleInput({ name: '合法', description: '描', template: '只有 {{一个槽位}}' }, []), err => err.status === 400 && /2 个/.test(err.message))
  assert.throws(() => validateCustomStyleInput({ name: '合法', description: '描', template: '含禁用词 excited {{槽1}} {{槽2}}' }, ['excited']), err => err.status === 400 && /excited/.test(err.message))

  await assert.rejects(saveCustomCoverStyle(root, { id: 'classic', name: '改内置', description: '描', template: VALID_TEMPLATE }), err => err.status === 400)
  await assert.rejects(deleteCustomCoverStyle(root, 'classic'), err => err.status === 400)
  await assert.rejects(deleteCustomCoverStyle(root, '../escape'), err => err.status === 400)

  // 30 套上限
  for (let i = 0; i < 30; i++) {
    await saveCustomCoverStyle(root, { name: `风格${i + 1}`, description: '描述', template: VALID_TEMPLATE })
  }
  await assert.rejects(
    saveCustomCoverStyle(root, { name: '第31套', description: '描述', template: VALID_TEMPLATE }),
    err => err.status === 400 && /30/.test(err.message),
  )
})

test('两阶段原子落盘与失败恢复：新建不留脏目录、更新失败旧版无损、预览换扩展名清旧图、并发写安全', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-custom-style-atomic-'))

  // 1. 新建中途失败不留 .staging-* 或目标目录
  await assert.rejects(
    saveCustomCoverStyle(root, { name: '失败新建', description: '描', template: VALID_TEMPLATE }, { _testFailBeforeCommit: true }),
    /simulated/,
  )
  const afterFailedCreate = await readdir(join(root, 'cover-styles'))
  assert.equal(afterFailedCreate.filter(name => name !== '.lock').length, 0)

  // 2. 先成功创建带 .jpg 预览图的风格
  const { draftToken: jpgDraft } = await saveDraftPreview(root, makeJpeg(94, 40), 'jpeg')
  const created = await saveCustomCoverStyle(root, {
    name: '原子测试',
    description: '旧描述',
    usePortrait: false,
    template: VALID_TEMPLATE,
    guidance: '旧指引',
    previewDraftToken: jpgDraft,
  })
  assert.equal(created.style.previewFile, 'preview.jpg')
  const styleDir = join(root, 'cover-styles', created.style.id)

  // 3. 更新写完临时文件后模拟失败：旧文件毫发无损，无残留 .tmp
  const { draftToken: pngDraft } = await saveDraftPreview(root, makePng(94, 40), 'png')
  await assert.rejects(
    saveCustomCoverStyle(root, {
      id: created.style.id,
      name: '新名字不应生效',
      description: '新描述',
      usePortrait: true,
      template: '{{新槽1}} {{新槽2}}',
      guidance: '新指引',
      previewDraftToken: pngDraft,
    }, { _testFailBeforeCommit: true }),
    /simulated/,
  )
  const intact = await readCustomCoverStyle(root, created.style.id)
  assert.equal(intact.name, '原子测试')
  assert.equal(intact.template, VALID_TEMPLATE)
  assert.equal(intact.guidance, '旧指引')
  assert.equal(intact.previewFile, 'preview.jpg')
  const entriesAfterFail = await readdir(styleDir)
  assert.ok(!entriesAfterFail.some(n => n.endsWith('.tmp')), '失败后不应残留 .tmp 文件')

  // 4. 正常更新并把预览图从 .jpg 换为 .png：旧 preview.jpg 被清理
  const updated = await saveCustomCoverStyle(root, {
    id: created.style.id,
    name: '换图成功',
    description: '新描述',
    usePortrait: false,
    template: VALID_TEMPLATE,
    guidance: '新指引',
    previewDraftToken: pngDraft,
  })
  assert.equal(updated.style.previewFile, 'preview.png')
  const entriesAfterSwap = (await readdir(styleDir)).sort()
  assert.deepEqual(entriesAfterSwap, ['guidance.txt', 'meta.json', 'preview.png', 'template.txt'])

  // 5. 并发 5 次新建，全部成功无冲突
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) => saveCustomCoverStyle(root, {
      name: `并发风格${i}`,
      description: '并发写入测试',
      template: VALID_TEMPLATE,
    })),
  )
  assert.equal(new Set(results.map(r => r.style.id)).size, 5)
  assert.equal((await listCoverStyles(root)).styles.length, 7 + 1 + 5)
})

test('损坏目录隔离与隐藏/暂存目录忽略', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-custom-style-corrupt-'))
  const ok = await saveCustomCoverStyle(root, { name: '正常风格', description: '描', template: VALID_TEMPLATE })
  const stylesDir = join(root, 'cover-styles')
  await mkdir(join(stylesDir, 'custom-broken1'), { recursive: true })
  await writeFile(join(stylesDir, 'custom-broken1', 'meta.json'), '{bad json')
  await mkdir(join(stylesDir, 'custom-broken2'), { recursive: true })
  await writeFile(join(stylesDir, 'custom-broken2', 'meta.json'), JSON.stringify({ id: 'custom-broken2', name: '缺模板', description: '描' }))
  await mkdir(join(stylesDir, '.staging-leftover'), { recursive: true })
  await mkdir(join(stylesDir, '_drafts'), { recursive: true })

  const listed = await listCoverStyles(root)
  assert.equal(listed.styles.length, 8)
  assert.equal(listed.styles[7].id, ok.style.id)
  assert.equal(listed.warnings.length, 2)
})

test('路径安全、符号链接逃逸拦截、文件魔数校验与草稿图 24h TTL 清理', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-custom-style-sec-'))
  const outsidePng = join(root, 'outside-secret.png')
  await writeFile(outsidePng, makePng(94, 40))

  assert.deepEqual([...CUSTOM_STYLE_PREVIEW_FILES].sort(), ['preview.jpeg', 'preview.jpg', 'preview.png'])
  assert.equal(detectImageContentType(makePng(47, 20)), 'image/png')
  assert.equal(detectImageContentType(makeJpeg(47, 20)), 'image/jpeg')
  assert.equal(detectImageContentType(Buffer.from('not-an-image')), null)

  const { draftToken } = await saveDraftPreview(root, makePng(94, 40), 'png')
  const created = await saveCustomCoverStyle(root, {
    name: '安全测试',
    description: '描',
    template: VALID_TEMPLATE,
    previewDraftToken: draftToken,
  })
  const styleDir = join(root, 'cover-styles', created.style.id)
  const metaPath = join(styleDir, 'meta.json')

  // 正常读取返回正确魔数 Content-Type
  const good = await readCustomStylePreview(root, created.style.id)
  assert.equal(good.contentType, 'image/png')

  // 1. 篡改 meta.json 的 previewFile 为各种恶意值全部拒绝
  for (const malicious of ['../outside-secret.png', '/etc/passwd', 'other.png', 'sub/preview.png', '..\\x.png']) {
    const meta = JSON.parse(await readFile(metaPath, 'utf8'))
    meta.previewFile = malicious
    await writeFile(metaPath, JSON.stringify(meta))
    await assert.rejects(readCustomStylePreview(root, created.style.id), err => err.status === 400 || err.status === 404)
  }

  // 恢复合法 previewFile，将 JPEG 字节写入 preview.png -> 按魔数识别为 image/jpeg
  const meta = JSON.parse(await readFile(metaPath, 'utf8'))
  meta.previewFile = 'preview.png'
  await writeFile(metaPath, JSON.stringify(meta))
  await writeFile(join(styleDir, 'preview.png'), makeJpeg(94, 40))
  const mismatchedExt = await readCustomStylePreview(root, created.style.id)
  assert.equal(mismatchedExt.contentType, 'image/jpeg')

  // 伪装文本文件为 preview.png -> 拒绝
  await writeFile(join(styleDir, 'preview.png'), '<html>not an image</html>')
  await assert.rejects(readCustomStylePreview(root, created.style.id), err => err.status === 415 || err.status === 404)

  // 符号链接预览图指向外部真实 PNG -> 拒绝
  await import('node:fs/promises').then(fs => fs.unlink(join(styleDir, 'preview.png')))
  await symlink(outsidePng, join(styleDir, 'preview.png'))
  await assert.rejects(readCustomStylePreview(root, created.style.id), err => err.status === 400 || err.status === 404)

  // 符号链接风格目录 -> 拒绝读取且列表跳过
  const externalStyleDir = join(root, 'external-style')
  await mkdir(externalStyleDir, { recursive: true })
  await writeFile(join(externalStyleDir, 'meta.json'), JSON.stringify({ id: 'custom-symlink1', name: '坏', description: '坏', previewFile: 'preview.png' }))
  await writeFile(join(externalStyleDir, 'template.txt'), VALID_TEMPLATE)
  await writeFile(join(externalStyleDir, 'preview.png'), makePng(94, 40))
  await symlink(externalStyleDir, join(root, 'cover-styles', 'custom-symlink1'))
  assert.equal(await readCustomCoverStyle(root, 'custom-symlink1'), null)
  await assert.rejects(readCustomStylePreview(root, 'custom-symlink1'))

  // 非 UUID draftToken -> 拒绝
  for (const badToken of ['../outside-secret', 'not-a-uuid', '12345']) {
    await assert.rejects(readDraftPreview(root, badToken), err => err.status === 400)
  }

  // _drafts 24h TTL 清理
  const { draftToken: oldToken } = await saveDraftPreview(root, makePng(94, 40), 'png')
  const { draftToken: freshToken } = await saveDraftPreview(root, makePng(94, 40), 'png')
  const oldPath = join(root, 'cover-styles', '_drafts', `${oldToken}.png`)
  const past = new Date(Date.now() - 25 * 60 * 60 * 1000)
  await utimes(oldPath, past, past)
  const pruned = await pruneExpiredDrafts(root)
  assert.equal(pruned, 1)
  await assert.rejects(readDraftPreview(root, oldToken))
  assert.equal((await readDraftPreview(root, freshToken)).contentType, 'image/png')
})

test('兜底预览策略：新建带参考图裁切为 47:20，极端尺寸降级无图不阻断保存', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-custom-style-fallback-'))
  const refDataUrl = `data:image/png;base64,${makePng(100, 50).toString('base64')}`
  const withFallback = await saveCustomCoverStyle(root, {
    name: '参考图兜底',
    description: '跳过试生成用参考图裁切兜底。',
    template: VALID_TEMPLATE,
    fallbackReferenceImage: refDataUrl,
  })
  assert.equal(withFallback.style.previewFile, 'preview.png')
  const preview = await readCustomStylePreview(root, withFallback.style.id)
  assert.equal(preview.contentType, 'image/png')

  // 极端小尺寸（10x10 无法按 47:20 裁切）不阻断保存，降级 previewFile: null
  const tinyDataUrl = `data:image/png;base64,${makePng(10, 10).toString('base64')}`
  const degraded = await saveCustomCoverStyle(root, {
    name: '极小图降级',
    description: '极小图裁切失败降级无图。',
    template: VALID_TEMPLATE,
    fallbackReferenceImage: tinyDataUrl,
  })
  assert.equal(degraded.style.previewFile, null)
})
