import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createArticle } from '../src/article.js'
import { route } from '../src/host.js'
import { updateSettings } from '../src/settings.js'
import { Store } from '../src/store.js'

async function setup() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'ws-derive-routes-')))
  const article = createArticle({
    markdown: '# 测试标题\n\n第一段包含 ==高亮重点== 和真实数据 1,200 人。\n\n第二段讲核心步骤。\n\n设为「星标」',
  })
  article.layoutPreferences = { style: 'neo', theme: 'blue' }
  await updateSettings(store.root, { fixedLines: ['设为「星标」'] })
  await store.update(state => { state.articles.push(article); state.currentId = article.id })

  const [b1, b2] = article.blocks
  let output = JSON.stringify({
    posts: [
      { text: '第一条钩子：增长 1,200 人的复盘', source: [b1.id] },
      { text: '第二条讲核心步骤', source: [b2.id] },
      { text: '第三条互动收尾', source: [] },
    ],
  })
  let beforeStream = null
  const llm = {
    prepareCall() {
      return {
        config: {},
        async *stream() {
          if (beforeStream) await beforeStream()
          yield { type: 'text-delta', text: output }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
  const services = { llm, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } }
  const deps = { ctx: { get: name => services[name] ?? null }, store, pipeline: { job: () => null } }
  const request = async (path, payload) => {
    const req = {
      url: `/wechat-studio/${path}`,
      method: payload ? 'POST' : 'GET',
      async *[Symbol.asyncIterator]() { if (payload) yield Buffer.from(JSON.stringify(payload)) },
    }
    let result
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(name, value) { this.headers[name] = value },
      end(value) { result = this.headers['content-type']?.startsWith('application/json') ? JSON.parse(value) : value },
    }
    try {
      await route(deps, req, res)
    } catch (error) {
      res.statusCode = error.status || 500
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: error.message, ...(error.code ? { code: error.code } : {}) }))
    }
    return { body: result, status: res.statusCode }
  }

  return {
    store,
    article,
    request,
    setOutput(value) { output = typeof value === 'string' ? value : JSON.stringify(value) },
    setBeforeStream(fn) { beforeStream = fn },
  }
}

test('GET derive/markdown 导出三个 target、校验非法参数并支持归档只读导出', async () => {
  const { store, article, request } = await setup()
  const zhihu = await request(`derive/markdown?id=${article.id}&target=zhihu`)
  assert.equal(zhihu.status, 200)
  assert.equal(zhihu.body.target, 'zhihu')
  assert.equal(zhihu.body.title, '测试标题')
  assert.ok(!zhihu.body.markdown.startsWith('# 测试标题'))
  assert.ok(zhihu.body.markdown.includes('**高亮重点**'))
  assert.ok(!zhihu.body.markdown.includes('设为「星标」'))

  const blog = await request(`derive/markdown?id=${article.id}&target=blog`)
  assert.equal(blog.status, 200)
  assert.ok(blog.body.markdown.startsWith('# 测试标题\n\n'))

  const bad = await request(`derive/markdown?id=${article.id}&target=weibo`)
  assert.equal(bad.status, 400)

  await store.update(state => { state.articles.find(a => a.id === article.id).archivedAt = new Date().toISOString() })
  const archivedExport = await request(`derive/markdown?id=${article.id}&target=juejin`)
  assert.equal(archivedExport.status, 200)
})

test('derive/generate、过期检测、手改覆盖保护、delete 与 xhsPalette 投影，且不触碰母稿 history', async () => {
  const { store, article, request } = await setup()
  const initialHistoryLen = (await store.read()).articles[0].history.length

  const gen = await request('derive/generate', { id: article.id, platform: 'thread', variant: 'jike' })
  assert.equal(gen.status, 200)
  assert.equal(gen.body.current.derivatives.length, 1)
  assert.equal(gen.body.current.derivatives[0].platform, 'thread')
  assert.equal(gen.body.current.derivatives[0].stale, false)
  assert.deepEqual(gen.body.current.xhsPalette, {
    main: '#2952B6',
    soft: '#F4F8FD',
    tint: '#DDE8FB',
    line: '#A6BBE2',
    mark: '#F9E8A7',
  })

  // 修改母稿一段 -> state 中 stale 变为 true
  const editedBlock = await request('block/update', {
    id: article.id,
    blockId: article.blocks[0].id,
    text: '第一段修改后内容，增长 2,000 人。',
  })
  assert.equal(editedBlock.status, 200)
  const stateAfterEdit = await request('state')
  assert.equal(stateAfterEdit.body.current.derivatives[0].stale, true)

  // 手改派生稿 -> 无 confirmOverwrite 再生成返回 409 + code='edited'
  const historyBeforeDeriveUpdate = (await store.read()).articles[0].history.length
  const upd = await request('derive/update', {
    id: article.id,
    platform: 'thread',
    payload: {
      posts: [
        { text: '手改第一条', source: [article.blocks[0].id] },
        { text: '手改第二条', source: [article.blocks[1].id] },
        { text: '手改第三条', source: [] },
      ],
    },
  })
  assert.equal(upd.status, 200)
  assert.ok(upd.body.current.derivatives[0].editedAt)

  const blocked = await request('derive/generate', { id: article.id, platform: 'thread', variant: 'x' })
  assert.equal(blocked.status, 409)
  assert.equal(blocked.body.code, 'edited')

  const confirmed = await request('derive/generate', {
    id: article.id,
    platform: 'thread',
    variant: 'x',
    confirmOverwrite: true,
  })
  assert.equal(confirmed.status, 200)
  assert.equal(confirmed.body.current.derivatives[0].editedAt, null)
  assert.equal(confirmed.body.current.derivatives[0].stale, false)

  // 删除派生稿
  const del = await request('derive/delete', { id: article.id, platform: 'thread' })
  assert.equal(del.status, 200)
  assert.deepEqual(del.body.current.derivatives, [])

  // derive/* 本身不新增 history（中间有一次 block/update 会增加 1）
  const finalHistoryLen = (await store.read()).articles[0].history.length
  assert.equal(initialHistoryLen + 1, historyBeforeDeriveUpdate)
  assert.equal(finalHistoryLen, historyBeforeDeriveUpdate)
})

test('derive/generate 并发互斥锁与归档稿件拒绝', async () => {
  const { store, article, request, setBeforeStream } = await setup()
  let releaseStream
  const entered = new Promise(resolve => {
    setBeforeStream(async () => {
      resolve()
      await new Promise(done => { releaseStream = done })
    })
  })

  const first = request('derive/generate', { id: article.id, platform: 'thread', variant: 'jike' })
  await entered
  const second = await request('derive/generate', { id: article.id, platform: 'thread', variant: 'jike' })
  assert.equal(second.status, 409)
  assert.match(second.body.error, /正在生成/)

  releaseStream()
  assert.equal((await first).status, 200)

  await store.update(state => { state.articles.find(a => a.id === article.id).archivedAt = new Date().toISOString() })
  const archivedGen = await request('derive/generate', { id: article.id, platform: 'thread', variant: 'jike' })
  assert.equal(archivedGen.status, 409)
})
