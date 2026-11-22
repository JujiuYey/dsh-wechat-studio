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
  let modalities = ['text', 'image']
  const seenContents = []
  const llm = {
    async listModels() {
      return [{ id: 'm', name: 'M', inputModalities: modalities }]
    },
    prepareCall() {
      return {
        config: {},
        async *stream({ messages }) {
          seenContents.push(messages[0].content)
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
    seenContents,
    setModalities(list) { modalities = list },
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

test('state 透出 fixedLines 并在 settings 更新后同步反映到 Markdown 导出', async () => {
  const { article, request } = await setup()
  const initialState = await request('state')
  assert.equal(initialState.status, 200)
  assert.deepEqual(initialState.body.fixedLines, ['设为「星标」'])

  const updSettings = await request('settings', { fixedLines: ['设为「星标」', '第二段讲核心步骤。'] })
  assert.equal(updSettings.status, 200)

  const nextState = await request('state')
  assert.deepEqual(nextState.body.fixedLines, ['设为「星标」', '第二段讲核心步骤。'])

  const exported = await request(`derive/markdown?id=${article.id}&target=blog`)
  assert.equal(exported.status, 200)
  assert.ok(!exported.body.markdown.includes('第二段讲核心步骤'))
})

test('state view 透出 articleImages 供小红书卡片配图使用', async () => {
  const { store, article, request } = await setup()
  await store.update(state => {
    const target = state.articles.find(a => a.id === article.id)
    target.blocks.push({
      id: 'b_img',
      text: '![架构图](https://cdn.example.com/arch.png)',
      check: null,
    })
  })
  const res = await request('state')
  assert.equal(res.status, 200)
  assert.ok(Array.isArray(res.body.current.articleImages))
  assert.ok(res.body.current.articleImages.some(i => i.url === 'https://cdn.example.com/arch.png' && i.caption === '架构图'))
})

test('POST derive/redesign-card 透传 cardPrompt、执行单页并发锁与 baseCardHash 409 校验', async () => {
  const { article, request, setOutput } = await setup()
  const [b1, b2] = article.blocks

  setOutput({
    title: '增长 1200 人实操',
    body: '这是一段符合一百字要求的测试小红书正文内容，重点记录我们在做公众号拆解和最小可用版本验证时的真实心得体会。'.repeat(2),
    tags: ['实操复盘', '最小版本', '个人经验'],
    cards: [
      { kind: 'cover', heading: '增长 1200 人', lines: ['核心步骤'], source: [b1.id] },
      { kind: 'compare', heading: '对比页', lines: ['以前 | 手动', '现在 | 自动'], source: [b1.id] },
      { kind: 'steps', heading: '步骤页', lines: ['第一步 | 跑通', '第二步 | 校验', '第三步 | 导出'], source: [b2.id] },
      { kind: 'grid', heading: '矩阵页', lines: ['模块一 | 清晰', '模块二 | 稳定'], source: [b2.id] },
      { kind: 'end', heading: '收尾', lines: ['先收藏'], source: [] },
    ],
  })
  const gen = await request('derive/generate', { id: article.id, platform: 'xhs' })
  assert.equal(gen.status, 200)

  setOutput('<xhs-page-style page="2">.cmp-box { border: 2px solid var(--xhs-accent); }</xhs-page-style><xhs-card page="2"><div class="cmp-box"><h2>重设计后的对比页</h2></div></xhs-card>')
  const redesigned = await request('derive/redesign-card', {
    id: article.id,
    cardIndex: 1,
    cardPrompt: '改用杂志双栏卡片风格',
  })
  assert.equal(redesigned.status, 200)
  const xhsRec = redesigned.body.current.derivatives.find(d => d.platform === 'xhs')
  assert.ok(xhsRec.payload.cards[1].html.includes('cmp-box'))
  assert.ok(xhsRec.payload.cards[1].pageCss.includes('.xhs-artboard .cmp-box'))

  // 传入不匹配的 baseCardHash -> 409 + code='card_conflict'
  const conflict = await request('derive/redesign-card', {
    id: article.id,
    cardIndex: 1,
    cardPrompt: '再换风格',
    baseCardHash: 'stale-hash-0000',
  })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.code, 'card_conflict')
})

test('POST derive/generate 支持小红书 async=true 后台渐进式生成并透出 xhsJob 进度', async () => {
  const { article, request, setOutput, setBeforeStream } = await setup()
  const [b1, b2] = article.blocks

  setOutput({
    title: '异步渐进式小红书',
    body: '这是一段符合一百字要求的测试小红书正文内容，重点记录我们在做公众号拆解和最小可用版本验证时的真实心得体会。'.repeat(2),
    tags: ['实操复盘', '最小版本', '个人经验'],
    cards: [
      { kind: 'cover', heading: '增长 1200 人', lines: ['核心步骤'], source: [b1.id] },
      { kind: 'compare', heading: '对比页', lines: ['以前 | 手动', '现在 | 自动'], source: [b1.id] },
      { kind: 'steps', heading: '步骤页', lines: ['第一步 | 跑通', '第二步 | 校验', '第三步 | 导出'], source: [b2.id] },
      { kind: 'grid', heading: '矩阵页', lines: ['模块一 | 清晰', '模块二 | 稳定'], source: [b2.id] },
      { kind: 'end', heading: '收尾', lines: ['先收藏'], source: [] },
    ],
  })

  let releaseStream
  const entered = new Promise(resolve => {
    setBeforeStream(async () => {
      resolve()
      await new Promise(done => { releaseStream = done })
    })
  })

  const started = await request('derive/generate', { id: article.id, platform: 'xhs', async: true })
  assert.equal(started.status, 200)
  assert.ok(started.body.current.xhsJob, 'async=true 应立刻返回运行中的 xhsJob')
  assert.equal(started.body.current.xhsJob.stage, 'planning')

  await entered
  // 进行中重复点击返回 409
  const dup = await request('derive/generate', { id: article.id, platform: 'xhs', async: true })
  assert.equal(dup.status, 409)

  releaseStream()
  // 等待后台任务结束
  for (let i = 0; i < 40; i++) {
    const polled = await request('state')
    if (!polled.body.current.xhsJob) {
      assert.equal(polled.body.current.xhsError, null)
      assert.ok(polled.body.current.derivatives.some(d => d.platform === 'xhs'))
      return
    }
    await new Promise(r => setTimeout(r, 30))
  }
  assert.fail('xhsJob 未在预期时间内完成')
})

test('GET state 透出 modelSupportsImages，且 derive/generate 与 derive/redesign-card 透传 referenceImages', async () => {
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  const { article, request, setOutput, seenContents, setModalities } = await setup()
  const [b1, b2] = article.blocks

  const st1 = await request('state')
  assert.equal(st1.status, 200)
  assert.equal(st1.body.modelSupportsImages, true)

  setModalities(['text'])
  const st2 = await request('state')
  assert.equal(st2.status, 200)
  assert.equal(st2.body.modelSupportsImages, false)

  setModalities(['text', 'image'])
  setOutput({
    title: '参考图路由测试',
    body: '这是一段符合一百字要求的测试小红书正文内容，重点记录我们在做公众号拆解和最小可用版本验证时的真实心得体会。'.repeat(2),
    tags: ['实操复盘', '最小版本', '个人经验'],
    cards: [
      { kind: 'cover', heading: '增长 1200 人', lines: ['核心步骤'], html: '<div class="c1"><h1>封面</h1></div>', source: [b1.id] },
      { kind: 'compare', heading: '对比页', lines: ['以前 | 手动', '现在 | 自动'], html: '<div class="c2"><h2>对比</h2></div>', source: [b1.id] },
      { kind: 'steps', heading: '步骤页', lines: ['第一步 | 跑通', '第二步 | 校验', '第三步 | 导出'], html: '<div class="c3"><ol><li>步骤</li></ol></div>', source: [b2.id] },
      { kind: 'grid', heading: '矩阵页', lines: ['模块一 | 清晰', '模块二 | 稳定'], html: '<div class="c4"><table><tr><td>矩阵</td></tr></table></div>', source: [b2.id] },
      { kind: 'end', heading: '收尾', lines: ['先收藏'], html: '<div class="c5"><h2>收尾</h2></div>', source: [] },
    ],
  })

  const gen = await request('derive/generate', {
    id: article.id,
    platform: 'xhs',
    referenceImages: [tinyPng],
  })
  assert.equal(gen.status, 200)
  assert.ok(seenContents[0].some(p => p.type === 'image' && p.mediaType === 'image/png'))

  setOutput('<xhs-card page="2"><div class="ref-redesign"><h2>按参考图重设计</h2></div></xhs-card>')
  const rd = await request('derive/redesign-card', {
    id: article.id,
    cardIndex: 1,
    cardPrompt: '参考这张图的布局',
    referenceImages: [tinyPng],
  })
  assert.equal(rd.status, 200)
  assert.ok(seenContents.at(-1).some(p => p.type === 'image' && p.mediaType === 'image/png'))
})
