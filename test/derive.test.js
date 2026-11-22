import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadSkill, skillSources } from '../src/ai.js'
import { createArticle } from '../src/article.js'
import {
  articleSourceHash,
  buildDerivePrompt,
  deleteDerivative,
  derivativesView,
  generateDerivative,
  prepareDerivePrompt,
  updateDerivative,
} from '../src/derive.js'
import { portableBlocks } from '../src/derive-markdown.js'
import { updateSettings } from '../src/settings.js'
import { Store } from '../src/store.js'

function setupStore(markdown = '# 实操复盘\n\n第一段核心结论，增长 1,200 人。\n\n第二段具体步骤，先做最小版本再收集反馈。\n\n设为「星标」') {
  const root = mkdtempSync(join(tmpdir(), 'ws-derive-'))
  const store = new Store(root)
  const article = createArticle({ markdown })
  return { root, store, article }
}

function makeFakeCtx(outputs) {
  const queue = Array.isArray(outputs) ? [...outputs] : [outputs]
  const calls = []
  let beforeStream = null
  const llm = {
    prepareCall() {
      return {
        config: {},
        async *stream(request) {
          calls.push(request)
          if (beforeStream) await beforeStream()
          const next = queue.length > 1 ? queue.shift() : queue[0]
          const text = typeof next === 'function' ? next(request) : typeof next === 'string' ? next : JSON.stringify(next)
          yield { type: 'text-delta', text }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
  const services = { llm, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } }
  return {
    ctx: { get: name => services[name] ?? null },
    calls,
    setBeforeStream(fn) { beforeStream = fn },
    setOutputs(list) { queue.splice(0, queue.length, ...(Array.isArray(list) ? list : [list])) },
  }
}

test('articleSourceHash 对正文和标题敏感，对质检标记不敏感', () => {
  const { article } = setupStore()
  const h1 = articleSourceHash(article)
  article.blocks[0].check = { status: 'flag', level: 'ai', score: 0.9 }
  assert.equal(articleSourceHash(article), h1)
  article.blocks[0].text += ' 加字'
  assert.notEqual(articleSourceHash(article), h1)
})

test('buildDerivePrompt 按段过滤 fixedLines 并按需注入个人声音与 30000 字截断', () => {
  const { article } = setupStore()
  const { blocks } = portableBlocks(article, { fixedLines: ['设为「星标」'] })
  assert.equal(blocks.length, 2)

  const withProfile = buildDerivePrompt({
    article,
    platform: 'thread',
    variant: 'jike',
    blocks,
    profile: {
      voice: ['老程序员口吻，直接讲重点'],
      phrases: ['说白了'],
      taboos: ['赋能', '抓手'],
    },
    skill: '平台技能说明',
  })
  assert.match(withProfile.system, /个人声音/)
  assert.match(withProfile.system, /老程序员口吻/)
  assert.match(withProfile.system, /禁止使用.*赋能/)
  const parsedUser = JSON.parse(withProfile.user)
  assert.equal(parsedUser.blocks.length, 2)

  const withoutProfile = buildDerivePrompt({
    article,
    platform: 'xhs',
    blocks,
    profile: null,
    skill: '小红书技能',
  })
  assert.doesNotMatch(withoutProfile.system, /个人声音/)

  const hugeBlocks = Array.from({ length: 10 }, (_, i) => ({
    id: `b${i}`,
    text: '甲'.repeat(5000),
  }))
  const truncated = buildDerivePrompt({
    article,
    platform: 'thread',
    variant: 'x',
    blocks: hugeBlocks,
    profile: null,
    skill: '技能',
  })
  const parsedHuge = JSON.parse(truncated.user)
  assert.equal(parsedHuge.blocks.length, 6)
  assert.ok(parsedHuge.blocks.reduce((s, b) => s + b.text.length, 0) <= 30000)
})

test('generateDerivative 正常生成、失败带错误反馈重试一次、两次失败报 502', async () => {
  const { root, store, article } = setupStore()
  await updateSettings(root, { fixedLines: ['设为「星标」'] })
  await store.update(state => { state.articles.push(article); state.currentId = article.id })
  const [b1, b2] = article.blocks

  const validThread = {
    posts: [
      { text: '第一条钩子：增长 1,200 人的复盘', source: [b1.id] },
      { text: '第二条：先做最小可用版本再收集反馈，新增一个 99% 数字', source: [b2.id] },
      { text: '第三条收尾互动', source: [] },
    ],
  }

  // 首次返回非法 JSON，第二次返回合法 JSON
  const fake = makeFakeCtx(['不是JSON', validThread])
  const record = await generateDerivative(fake.ctx, store, { id: article.id, platform: 'thread', variant: 'jike' })
  assert.equal(fake.calls.length, 2)
  const retryReq = JSON.parse(fake.calls[1].messages[0].content[0].text)
  assert.ok(typeof retryReq.previousError === 'string' && retryReq.previousError.length > 0)
  assert.equal(record.platform, 'thread')
  assert.equal(record.variant, 'jike')
  assert.equal(record.editedAt, null)
  assert.ok(record.warnings.some(w => w.includes('99%')))

  // 两次都失败（例如只有 1 条）-> 502
  fake.setOutputs([{ posts: [{ text: '太少' }] }, { posts: [{ text: '还是太少' }] }])
  await assert.rejects(
    () => generateDerivative(fake.ctx, store, { id: article.id, platform: 'thread', variant: 'x', confirmOverwrite: true }),
    err => err.status === 502 && /至少.*3 条/.test(err.message),
  )
})

test('手改覆盖保护、生成期间母稿修改标 stale、归档 409 与空正文 400', async () => {
  const { store, article } = setupStore()
  await store.update(state => { state.articles.push(article); state.currentId = article.id })
  const [b1, b2] = article.blocks

  const validXhs = {
    title: '增长 1200 人实操',
    body: '这是一段符合一百字要求的测试小红书正文内容，重点记录我们在做公众号拆解和最小可用版本验证时的真实心得体会。'.repeat(2),
    tags: ['实操复盘', '最小版本', '个人经验'],
    cards: [
      { kind: 'cover', heading: '增长 1200 人复盘', lines: ['先做最小版本'], source: [b1.id] },
      { kind: 'quote', heading: '核心方法', lines: ['第一段核心结论，增长 1,200 人。'], source: [b1.id] },
      { kind: 'list', heading: '执行步骤', lines: ['先做最小版本', '再收集真实反馈'], source: [b2.id] },
      { kind: 'quote', heading: '', lines: ['第二段具体步骤，先做最小版本再收集反馈。'], source: [b2.id] },
      { kind: 'end', heading: '点个收藏', lines: ['欢迎评论区交流'], source: [] },
    ],
  }

  const fake = makeFakeCtx(validXhs)
  await generateDerivative(fake.ctx, store, { id: article.id, platform: 'xhs' })

  // 手改后不带 confirmOverwrite 被拒绝 409 code='edited'
  await updateDerivative(store, {
    id: article.id,
    platform: 'xhs',
    payload: { ...validXhs, title: '手改过的标题' },
  })
  await assert.rejects(
    () => generateDerivative(fake.ctx, store, { id: article.id, platform: 'xhs' }),
    err => err.status === 409 && err.code === 'edited',
  )

  // 生成期间母稿被改 -> 落盘后立刻判定为 stale === true
  fake.setBeforeStream(async () => {
    await store.update(state => {
      const target = state.articles.find(a => a.id === article.id)
      target.blocks[0].text = '生成期间改写了第一段，增长 2,500 人。'
    })
  })
  await generateDerivative(fake.ctx, store, { id: article.id, platform: 'xhs', confirmOverwrite: true })
  const latest = (await store.read()).articles.find(a => a.id === article.id)
  const viewList = derivativesView(latest)
  assert.equal(viewList.length, 1)
  assert.equal(viewList[0].stale, true)

  // updateDerivative 非法返回 400
  await assert.rejects(
    () => updateDerivative(store, { id: article.id, platform: 'xhs', payload: { ...validXhs, title: '字'.repeat(25) } }),
    err => err.status === 400,
  )

  // deleteDerivative 删除与幂等
  await deleteDerivative(store, { id: article.id, platform: 'xhs' })
  await deleteDerivative(store, { id: article.id, platform: 'xhs' })
  const afterDelete = (await store.read()).articles.find(a => a.id === article.id)
  assert.deepEqual(derivativesView(afterDelete), [])

  // 归档拒绝
  await store.update(state => { state.articles.find(a => a.id === article.id).archivedAt = new Date().toISOString() })
  await assert.rejects(
    () => generateDerivative(fake.ctx, store, { id: article.id, platform: 'thread' }),
    err => err.status === 409,
  )
  await assert.rejects(
    () => deleteDerivative(store, { id: article.id, platform: 'thread' }),
    err => err.status === 409,
  )

  // 空正文拒绝 400
  const empty = createArticle({ markdown: '# 只有标题\n\n设为「星标」' })
  await updateSettings(store.root, { fixedLines: ['设为「星标」'] })
  await store.update(state => { state.articles.push(empty) })
  await assert.rejects(
    () => prepareDerivePrompt(empty, { platform: 'thread', root: store.root }),
    err => err.status === 400 && /正文为空/.test(err.message),
  )
})

test('内置 repurpose-thread 与 repurpose-xhs skill 可读取且进入 skillSources', async () => {
  const threadSkill = await loadSkill('repurpose-thread')
  const xhsSkill = await loadSkill('repurpose-xhs')
  assert.match(threadSkill, /串推/)
  assert.match(xhsSkill, /小红书/)

  const sources = await skillSources()
  assert.ok(sources.some(s => s.name === 'repurpose-thread' && s.source === 'bundled'))
  assert.ok(sources.some(s => s.name === 'repurpose-xhs' && s.source === 'bundled'))
})
