import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createArticle } from '../src/article.js'
import { readCover } from '../src/cover.js'
import { createHandler } from '../src/host.js'
import { readInlineImage, saveInlineImage } from '../src/inline-assets.js'
import { Store } from '../src/store.js'

const PNG = Buffer.from('89504e470d0a1a0a00000000', 'hex')

async function setup(source, root = mkdtempSync(join(tmpdir(), 'ws-duplicate-'))) {
  const store = new Store(root)
  await store.update(state => { state.articles.push(source); state.currentId = source.archivedAt ? null : source.id })
  const handler = createHandler({ get: name => ({ connection: { requestRejection: () => undefined } })[name] }, { store })
  const request = async (path, post) => {
    const req = {
      url: `/wechat-studio/${path}`, method: post ? 'POST' : 'GET',
      async *[Symbol.asyncIterator]() { if (post) yield Buffer.from(JSON.stringify(post)) },
    }
    let status = 200, body
    const res = {
      setHeader() {},
      end(value) { body = JSON.parse(value) },
    }
    await handler(req, res)
    return { status: res.statusCode ?? status, body }
  }
  return { store, request }
}

test('创建完整副本：内容、配置和资源独立，工作及发布状态重置', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-duplicate-full-'))
  const source = createArticle({ topic: '原选题', markdown: '# 原稿\n\n第一段。\n\n![插图](https://cdn.example.com/inline.png)' })
  const coverId = randomUUID(), legacyCoverId = randomUUID(), runId = randomUUID(), legacyRunId = randomUUID()
  await mkdir(join(root, 'covers'), { recursive: true })
  await writeFile(join(root, 'covers', `${coverId}.png`), Buffer.from('cover'))
  await writeFile(join(root, 'covers', `${legacyCoverId}.jpeg`), Buffer.from('legacy-cover'))
  const assetId = await saveInlineImage(root, PNG)
  Object.assign(source, {
    front: '---\ntitle: 原稿\n---', titles: [{ text: '候选标题', hook: 'A' }], summary: '原摘要', hook: 'A',
    chat: [{ role: 'user', text: '改一段' }], zhuque: { round: 2, lastAt: '2026-11-01T00:00:00.000Z' },
    layoutPreferences: { style: 'neo', theme: 'blue' }, followCard: true,
    bannerStyle: 'poster', banners: { poster: { spec: { style: 'poster' }, warnings: [], at: '2026-11-01T00:00:00.000Z' } },
    coverRuns: [
      { id: runId, format: 'png', images: [{ id: coverId }], status: 'succeeded', errors: [] },
      { id: legacyRunId, format: 'jpeg', images: [{ id: legacyCoverId }], status: 'partial', errors: ['旧错误'] },
    ],
    cover: { id: legacyCoverId, format: 'jpeg', title: '原稿', style: 'classic' },
    inlineDiagrams: [{
      id: randomUUID(), anchorId: source.blocks[0].id, insertedBlockId: source.blocks[1].id,
      kind: 'concept', title: '插图', brief: '说明', status: 'inserted', assetId, format: 'png', publicUrl: 'https://cdn.example.com/inline.png',
    }],
    scheduledFor: '2026-11-20T10:00:00.000+08:00', publishedAt: '2026-11-18T10:00:00.000+08:00',
    publishMarkedAt: '2026-11-18T10:01:00.000+08:00', archivedAt: '2026-11-18T11:00:00.000+08:00',
    imageImport: { remaining: 1 }, notice: { text: '旧提示' }, inlineMessage: { text: '旧插图提示' }, coverError: '旧封面错误',
    derivatives: { thread: { platform: 'thread', variant: 'jike', sourceHash: 'abc', createdAt: '2026-11-01T00:00:00.000Z', editedAt: null, payload: { variant: 'jike', posts: [] }, warnings: [] } },
  })
  source.blocks[0].check = { status: 'flag', score: 0.9 }
  source.blocks[0].prev = '旧第一段。'
  source.history = [{ label: '手动改稿', at: '2026-11-01T00:00:00.000Z', title: '旧标题', titles: [], blocks: structuredClone(source.blocks) }]
  const { store, request } = await setup(source, root)
  const response = await request('articles/duplicate', { id: source.id })
  assert.equal(response.status, 200, response.body.error)
  assert.equal(response.body.articles.length, 2)
  assert.equal(response.body.current.title, '原稿（副本）')

  const state = await store.read()
  const copy = state.articles.find(article => article.id === state.currentId)
  assert.ok(copy && copy.id !== source.id)
  assert.equal(copy.topic, source.topic)
  assert.equal(copy.front, source.front)
  assert.deepEqual(copy.titles, source.titles)
  assert.equal(copy.summary, source.summary)
  assert.equal(copy.hook, null)
  assert.deepEqual(copy.layoutPreferences, source.layoutPreferences)
  assert.deepEqual(copy.banners, source.banners)
  assert.equal(copy.bannerStyle, source.bannerStyle)
  assert.equal(copy.followCard, true)
  assert.equal(copy.lastView, 'paper')
  assert.deepEqual(copy.chat, [])
  assert.deepEqual(copy.history, [])
  assert.deepEqual(copy.zhuque, { round: 0, lastAt: null })
  assert.deepEqual(copy.derivatives, {})
  for (const key of ['archivedAt', 'scheduledFor', 'publishedAt', 'publishMarkedAt', 'imageImport', 'notice', 'inlineMessage', 'coverError']) assert.equal(copy[key], undefined)
  assert.equal(copy.blocks.length, source.blocks.length)
  copy.blocks.forEach((block, index) => {
    assert.notEqual(block.id, source.blocks[index].id)
    assert.equal(block.text, source.blocks[index].text)
    assert.equal(block.check, null)
    assert.equal(block.prev, undefined)
  })
  assert.notEqual(copy.coverRuns[0].id, runId)
  assert.notEqual(copy.coverRuns[1].id, legacyRunId)
  assert.notEqual(copy.coverRuns[0].images[0].id, coverId)
  assert.notEqual(copy.coverRuns[1].images[0].id, legacyCoverId)
  assert.equal(copy.cover.id, copy.coverRuns[1].images[0].id)
  const diagram = copy.inlineDiagrams[0]
  assert.notEqual(diagram.id, source.inlineDiagrams[0].id)
  assert.equal(diagram.anchorId, copy.blocks[0].id)
  assert.equal(diagram.insertedBlockId, copy.blocks[1].id)
  assert.notEqual(diagram.assetId, assetId)
  assert.equal(diagram.publicUrl, source.inlineDiagrams[0].publicUrl)
  assert.equal(source.cover.id, legacyCoverId)
  assert.equal(source.inlineDiagrams[0].assetId, assetId)

  await rm(join(root, 'covers', `${coverId}.png`))
  await rm(join(root, 'covers', `${legacyCoverId}.jpeg`))
  await rm(join(root, 'inline-images', `${assetId}.png`))
  assert.deepEqual(await readCover(root, copy.coverRuns[0].images[0].id, 'png'), Buffer.from('cover'))
  assert.deepEqual(await readCover(root, copy.cover.id, 'jpeg'), Buffer.from('legacy-cover'))
  assert.deepEqual(await readInlineImage(root, diagram.assetId), PNG)
})

test('资源复制失败：不创建稿件并清理已经复制的文件', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-duplicate-failure-'))
  const source = createArticle({ markdown: '# 原稿\n\n正文' })
  const existingId = randomUUID(), missingId = randomUUID()
  await mkdir(join(root, 'covers'), { recursive: true })
  await writeFile(join(root, 'covers', `${existingId}.png`), Buffer.from('existing'))
  source.coverRuns = [
    { id: randomUUID(), format: 'png', images: [{ id: existingId }], status: 'succeeded' },
    { id: randomUUID(), format: 'png', images: [{ id: missingId }], status: 'succeeded' },
  ]
  source.cover = { id: existingId, format: 'png' }
  const { store, request } = await setup(source, root)
  const response = await request('articles/duplicate', { id: source.id })
  assert.equal(response.status, 409)
  assert.match(response.body.error, /资源文件缺失/)
  const state = await store.read()
  assert.equal(state.articles.length, 1)
  assert.equal(state.currentId, source.id)
  assert.deepEqual(await readdir(join(root, 'covers')), [`${existingId}.png`])
})

test('保留未转存飞书图片提醒、无标题保持为空、未登记封面置空', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-duplicate-edge-'))
  const feishuUrl = 'https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=demo'
  const source = createArticle({ topic: '原选题', markdown: '第一段。\n\n!' + '[飞书图](' + feishuUrl + ')' })
  const { id: sourceId } = source
  source.title = '   '
  source.coverRuns = []
  source.cover = { id: randomUUID(), format: 'png' }
  source.svgCardInsertions = [{ operationId: 'op-12345678', cardBlockId: source.blocks[0]['id'], createdAt: '2026-11-01T00:00:00.000Z' }]
  const { store, request } = await setup(source, root)
  const response = await request('articles/duplicate', { id: sourceId })
  assert.equal(response.status, 200, response.body.error)

  const state = await store['read']()
  const copy = state.articles.find(({ id }) => id === state.currentId)
  assert.equal(copy.title, '')
  assert.equal(copy.cover, null)
  assert.equal(copy.svgCardInsertions, undefined)
  assert.equal(copy.imageImport?.remaining, 1)
  assert.match(copy.imageImport?.error ?? '', /飞书图片/)
})

test('含 emoji 超长标题按 UTF-16 长度截断且不拆分代理对', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-duplicate-title-'))
  const source = createArticle({ markdown: `# ${'🚀'.repeat(45)}\n\n正文` })
  const { id: sourceId } = source
  const { store, request } = await setup(source, root)
  const response = await request('articles/duplicate', { id: sourceId })
  assert.equal(response.status, 200, response.body.error)

  const state = await store['read']()
  const copy = state.articles.find(({ id }) => id === state.currentId)
  assert.ok(copy.title.endsWith('（副本）'))
  assert.ok(copy.title.length <= 80)
  assert.equal(copy.title.isWellFormed(), true)
})

test('资源记录无效或插图格式非法时返回 409', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-duplicate-invalid-'))
  const source = createArticle({ markdown: '# 原稿\n\n正文' })
  const { id: sourceId } = source
  source.inlineDiagrams = [{ id: randomUUID(), anchorId: source.blocks[0]['id'], assetId: randomUUID(), format: 'jpeg', status: 'generated' }]
  const { request } = await setup(source, root)
  const response = await request('articles/duplicate', { id: sourceId })
  assert.equal(response.status, 409)
  assert.match(response.body.error, /无效的资源记录/)
})

test('落盘失败时回滚内存状态并清理已复制的封面和插图文件', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-duplicate-persist-fail-'))
  const source = createArticle({ markdown: '# 原稿\n\n正文' })
  const { id: sourceId } = source
  const coverId = randomUUID()
  await mkdir(join(root, 'covers'), { recursive: true })
  await writeFile(join(root, 'covers', `${coverId}.png`), Buffer.from('cover'))
  const assetId = await saveInlineImage(root, PNG)
  source.coverRuns = [{ id: randomUUID(), format: 'png', images: [{ id: coverId }], status: 'succeeded' }]
  source.cover = { id: coverId, format: 'png' }
  source.inlineDiagrams = [{ id: randomUUID(), anchorId: source.blocks[0]['id'], assetId, format: 'png', status: 'generated' }]
  const { store, request } = await setup(source, root)

  const originalUpdate = store.update.bind(store)
  store.update = fn => originalUpdate(async state => {
    await fn(state)
    throw new Error('模拟落盘失败')
  })

  const response = await request('articles/duplicate', { id: sourceId })
  assert.equal(response.status, 500)
  assert.match(response.body.error, /模拟落盘失败/)

  const state = await store['read']()
  assert.equal(state.articles.length, 1)
  assert.equal(state.currentId, sourceId)
  assert.deepEqual(await readdir(join(root, 'covers')), [`${coverId}.png`])
  assert.deepEqual(await readdir(join(root, 'inline-images')), [`${assetId}.png`])
})
