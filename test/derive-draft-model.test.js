import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  buildMarkdownRefreshKey,
  canExportMarkdown,
  deriveDraftKey,
  hasUnsavedDeriveDrafts,
  recordVersion,
  resolveThreadEditorState,
  resolveXhsEditorState,
  shouldConfirmDeriveAction,
  summarizeCardPreviews,
} from '../client/derive-draft-model.js'

test('derive-draft-model.js 不含 node:* 或 DOM 全局对象引用', async () => {
  const src = await readFile(new URL('../client/derive-draft-model.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /from\s+['"]node:/)
  assert.doesNotMatch(src, /\b(?:document|window)\b/)
})

test('Bug 1: 跨标签/跨视图保留未保存串推与小红书草稿，并在重新生成或删除时要求确认', () => {
  const threadRecord = {
    platform: 'thread',
    variant: 'jike',
    createdAt: '2026-11-22T10:00:00.000Z',
    editedAt: null,
    payload: { variant: 'jike', posts: [{ text: '服务端原内容', source: [] }] },
  }
  const key = deriveDraftKey('a1', 'thread')
  assert.equal(key, 'a1:thread')

  // 无本地草稿时直接取服务端记录
  const cleanState = resolveThreadEditorState(threadRecord, null)
  assert.equal(cleanState.dirty, false)
  assert.equal(cleanState.baseChanged, false)
  assert.equal(cleanState.posts[0].text, '服务端原内容')

  // 存在本地未保存草稿时即使面板重挂载仍恢复手改内容
  const draftEntry = {
    baseVersion: recordVersion(threadRecord),
    variant: 'x',
    payload: { posts: [{ text: '这是我尚未保存的手改内容', source: [] }] },
  }
  const dirtyState = resolveThreadEditorState(threadRecord, draftEntry)
  assert.equal(dirtyState.dirty, true)
  assert.equal(dirtyState.baseChanged, false)
  assert.equal(dirtyState.variant, 'x')
  assert.equal(dirtyState.posts[0].text, '这是我尚未保存的手改内容')

  // 若后台派生被他人/CLI更新，baseChanged 为 true
  const updatedRecord = { ...threadRecord, createdAt: '2026-11-22T10:05:00.000Z' }
  assert.equal(resolveThreadEditorState(updatedRecord, draftEntry).baseChanged, true)

  // 小红书草稿同样保留
  const xhsRecord = {
    platform: 'xhs',
    createdAt: '2026-11-22T10:00:00.000Z',
    editedAt: null,
    payload: { title: '原标题', body: '正文'.repeat(60), tags: ['a', 'b', 'c'], cards: [] },
  }
  const xhsDirty = resolveXhsEditorState(xhsRecord, {
    baseVersion: recordVersion(xhsRecord),
    payload: { ...xhsRecord.payload, title: '未保存标题' },
  })
  assert.equal(xhsDirty.dirty, true)
  assert.equal(xhsDirty.draft.title, '未保存标题')

  // 文章级未保存标记
  assert.equal(hasUnsavedDeriveDrafts('a1', { [key]: draftEntry }), true)
  assert.equal(hasUnsavedDeriveDrafts('a2', { [key]: draftEntry }), false)

  // 本地 dirty 时，即使服务端 editedAt === null，重新生成和删除也必须二次确认
  assert.deepEqual(
    shouldConfirmDeriveAction({ action: 'generate', dirty: true, record: threadRecord }),
    { confirm: true, reason: 'unsaved' },
  )
  assert.deepEqual(
    shouldConfirmDeriveAction({ action: 'delete', dirty: true, record: threadRecord }),
    { confirm: true, reason: 'unsaved' },
  )
  // 无本地 dirty 但服务端有 editedAt 时同样需确认
  assert.deepEqual(
    shouldConfirmDeriveAction({ action: 'generate', dirty: false, record: { ...threadRecord, editedAt: '2026-11-22T10:01:00.000Z' } }),
    { confirm: true, reason: 'edited' },
  )
  assert.deepEqual(
    shouldConfirmDeriveAction({ action: 'generate', dirty: false, record: threadRecord }),
    { confirm: false, reason: null },
  )
})

test('Bug 2: fixedLines 改动会改变 Markdown 刷新签名', () => {
  const article = { id: 'a1', title: '标题', blocks: [{ id: 'b1', text: '正文' }] }
  const k1 = buildMarkdownRefreshKey({ article, target: 'blog', fixedLines: ['设为「星标」'] })
  const k2 = buildMarkdownRefreshKey({ article, target: 'blog', fixedLines: ['设为「星标」', '关注我'] })
  const k3 = buildMarkdownRefreshKey({ article, target: 'zhihu', fixedLines: ['设为「星标」', '关注我'] })
  assert.notEqual(k1, k2)
  assert.notEqual(k2, k3)
})

test('Bug 3: 存在加载错误或正在加载时禁用 Markdown 复制与下载', () => {
  assert.equal(canExportMarkdown({ loading: false, error: null, result: { markdown: '# ok' } }), true)
  assert.equal(canExportMarkdown({ loading: true, error: null, result: { markdown: '# stale' } }), false)
  assert.equal(canExportMarkdown({ loading: false, error: '请求失败', result: { markdown: '# stale' } }), false)
  assert.equal(canExportMarkdown({ loading: false, error: null, result: { markdown: '' } }), false)
})

test('Bug 4: summarizeCardPreviews 明确区分全部成功、部分失败和全部失败', () => {
  const allOk = summarizeCardPreviews([
    { status: 'fulfilled', value: { url: 'blob:1', overflow: false } },
    { status: 'fulfilled', value: { url: 'blob:2', overflow: true } },
  ])
  assert.equal(allOk.status, 'ready')
  assert.equal(allOk.failedCount, 0)
  assert.equal(allOk.error, null)
  assert.equal(allOk.items[1].overflow, true)

  const partial = summarizeCardPreviews([
    { status: 'fulfilled', value: { url: 'blob:1', overflow: false } },
    { status: 'rejected', reason: new Error('Canvas 不可用') },
  ])
  assert.equal(partial.status, 'ready')
  assert.equal(partial.failedCount, 1)
  assert.match(partial.error, /1 张/)
  assert.equal(partial.items[0].status, 'ok')
  assert.equal(partial.items[1].status, 'error')
  assert.equal(partial.items[1].error, 'Canvas 不可用')

  const allFail = summarizeCardPreviews([
    { status: 'rejected', reason: new Error('无 Canvas 上下文') },
    { status: 'rejected', reason: new Error('无 Canvas 上下文') },
  ])
  assert.equal(allFail.status, 'error')
  assert.equal(allFail.failedCount, 2)
  assert.equal(allFail.error, '无 Canvas 上下文')
})
