import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { deflateSync } from 'node:zlib'
import { createArticle } from '../src/article.js'
import {
  COVER_STYLE_TEST_JOB_TTL_MS,
  MAX_COVER_STYLE_TEST_JOB_HISTORY,
  pruneCoverStyleTestJobs,
  route,
} from '../src/host.js'
import { updateSettings } from '../src/settings.js'
import { Store } from '../src/store.js'

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
    for (let x = 0; x < width; x++) { const p = off + 1 + x * 3; raw[p] = 0x11; raw[p + 1] = 0x55; raw[p + 2] = 0x99 }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

async function createHost({ provider = 'ark', key = 'sk-ark', model, modalities = ['text', 'image'], llmReplies = [], fetchImpl, withArticle = true } = {}) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'ws-custom-cover-routes-')))
  let article = null
  if (withArticle) {
    article = createArticle({ markdown: '# 路由测试文章\n\n这是一篇用于测试自定义封面风格路由与历史回退的文章正文。' })
    await store.update(state => { state.articles.push(article); state.currentId = article.id })
  }
  const settings = { coverProvider: provider }
  if (provider === 'minimax') { settings.minimaxKey = key; if (model) settings.minimaxModel = model }
  else if (provider === 'bailian') { settings.bailianKey = key; if (model) settings.bailianModel = model }
  else { settings.arkKey = key; if (model) settings.arkModel = model }
  await updateSettings(store.root, settings)

  let replyIdx = 0
  const llm = {
    listModels: async () => [{ id: 'm', ...(modalities ? { inputModalities: modalities } : {}) }],
    prepareCall: async () => ({
      config: {},
      async *stream() {
        const next = llmReplies[Math.min(replyIdx++, Math.max(0, llmReplies.length - 1))]
        if (next instanceof Error) throw next
        const text = typeof next === 'string' ? next : JSON.stringify(next ?? { values: ['测试标题', '视觉元素'] })
        yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }),
  }
  const services = { llm, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } }
  const deps = { ctx: { get: name => services[name] ?? null }, store, pipeline: { job: () => null }, fetchImpl }

  const request = async (path, payload) => {
    const req = {
      url: '/wechat-studio/' + path,
      method: payload !== undefined ? 'POST' : 'GET',
      async *[Symbol.asyncIterator]() { if (payload !== undefined) yield Buffer.from(JSON.stringify(payload)) },
    }
    const headers = {}
    let status = 200
    let body
    try {
      await route(deps, req, {
        set statusCode(v) { status = v },
        get statusCode() { return status },
        setHeader(k, v) { headers[k.toLowerCase()] = v },
        end(v) { body = v },
      })
    } catch (err) {
      status = err.status || 500
      body = JSON.stringify({ error: err.message, ...(err.code ? { code: err.code } : {}) })
    }
    return { status, headers, json: () => JSON.parse(body), raw: body }
  }

  return { store, article, request }
}

async function waitTestJob(request, jobId) {
  for (let i = 0; i < 200; i++) {
    const res = await request(`cover-styles/test-status?jobId=${encodeURIComponent(jobId)}`)
    const data = res.json()
    if (data.status !== 'running') return data
    await new Promise(r => setTimeout(r, 10))
  }
  assert.fail('试生成任务超时未完成')
}

async function waitCover(request) {
  for (let i = 0; i < 200; i++) {
    const { current } = (await request('state')).json()
    const run = current.coverRuns?.at(-1)
    if (!current.coverJob && run && run.status !== 'running') return current
    await new Promise(r => setTimeout(r, 10))
  }
  assert.fail('正式封面生成未结束')
}

test('GET cover-styles：无文章时也可访问，返回 7 套内置、visionSupport 三态与 activeTestJob', async () => {
  for (const [modalities, expected] of [[['text', 'image'], true], [['text'], false], [null, null]]) {
    const { request } = await createHost({ modalities, withArticle: false })
    const res = await request('cover-styles')
    assert.equal(res.status, 200)
    const data = res.json()
    assert.equal(data.styles.length, 7)
    assert.deepEqual(data.warnings, [])
    assert.equal(data.visionSupport, expected)
    assert.equal(data.activeTestJob, null)
  }
})

test('自定义封面完整闭环：analyze -> test-generate 轮询 -> draft-preview -> save -> item & preview', async () => {
  const png = makePng(94, 40)
  const fetchImpl = async () => Response.json({ data: [{ b64_json: png.toString('base64') }] })
  const { request } = await createHost({
    fetchImpl,
    llmReplies: [
      {
        name: '黑金极客风',
        description: '深炭黑底与香槟金大标题，适合深度评测。',
        usePortrait: false,
        template: '21:9 深炭黑底（#141414），主标题 {{主标题}}，视觉 {{右侧物件}}',
        guidance: '标题限 10 字',
      },
      { values: ['AI 写作流', '极简终端'] },
    ],
  })

  const analyzed = await request('cover-styles/analyze', { requirement: '黑金极客风，不要真人' })
  assert.equal(analyzed.status, 200)
  const { draft } = analyzed.json()
  assert.equal(draft.name, '黑金极客风')

  const started = await request('cover-styles/test-generate', { draft, testTitle: '我的测试文章', resolution: '1K' })
  assert.equal(started.status, 200)
  const { jobId } = started.json()
  assert.ok(jobId)

  const finished = await waitTestJob(request, jobId)
  assert.equal(finished.status, 'succeeded')
  assert.ok(finished.result.draftToken)
  assert.match(finished.result.previewUrl, /cover-styles\/draft-preview\?token=/)
  assert.equal('path' in finished.result, false, '不得向前端暴露磁盘路径')

  const draftImg = await request(`cover-styles/draft-preview?token=${encodeURIComponent(finished.result.draftToken)}`)
  assert.equal(draftImg.status, 200)
  assert.equal(draftImg.headers['content-type'], 'image/png')
  assert.ok(Buffer.isBuffer(draftImg.raw))

  const saved = await request('cover-styles/save', {
    ...draft,
    userRequirement: '黑金极客风，不要真人',
    previewDraftToken: finished.result.draftToken,
  })
  assert.equal(saved.status, 200)
  const savedStyle = saved.json().style
  assert.equal(saved.json().styles.length, 8)
  assert.match(savedStyle.previewUrl, /cover-styles\/preview\?id=/)

  const item = await request(`cover-styles/item?id=${encodeURIComponent(savedStyle.id)}`)
  assert.equal(item.status, 200)
  assert.equal(item.json().style.template, draft.template)

  const previewImg = await request(`cover-styles/preview?id=${encodeURIComponent(savedStyle.id)}`)
  assert.equal(previewImg.status, 200)
  assert.equal(previewImg.headers['content-type'], 'image/png')

  // 非法 ID / token 路由返回 400 / 404
  assert.equal((await request('cover-styles/item?id=classic')).status, 400)
  assert.equal((await request('cover-styles/preview?id=../evil')).status, 400)
  assert.equal((await request('cover-styles/draft-preview?token=not-a-uuid')).status, 400)
})

test('单活并发锁与后台任务恢复：运行中重复提交返 409 + activeJobId，GET cover-styles 暴露活跃任务', async () => {
  const png = makePng(94, 40)
  let releaseFetch
  const fetchGate = new Promise(r => { releaseFetch = r })
  const fetchImpl = async () => {
    await fetchGate
    return Response.json({ data: [{ b64_json: png.toString('base64') }] })
  }
  const { request } = await createHost({
    fetchImpl,
    llmReplies: [{ values: ['标题A', '物件A'] }],
  })
  const draft = { name: '锁测试', template: '21:9 标题 {{主标题}}，视觉 {{视觉}}', guidance: '', usePortrait: false }

  const first = await request('cover-styles/test-generate', { draft, testTitle: 'T1', resolution: '1K' })
  assert.equal(first.status, 200)
  const { jobId } = first.json()

  // 重复提交立即返 409 并返回 activeJobId
  const dup = await request('cover-styles/test-generate', { draft, testTitle: 'T2', resolution: '1K' })
  assert.equal(dup.status, 409)
  assert.equal(dup.json().activeJobId, jobId)

  // GET cover-styles 暴露正在运行的 activeTestJob
  const listWhileRunning = (await request('cover-styles')).json()
  assert.equal(listWhileRunning.activeTestJob.jobId, jobId)
  assert.equal(listWhileRunning.activeTestJob.status, 'running')

  // 放行生图后恢复查询结果
  releaseFetch()
  const done = await waitTestJob(request, jobId)
  assert.equal(done.status, 'succeeded')
  const latestNoId = (await request('cover-styles/test-status')).json()
  assert.equal(latestNoId.jobId, jobId)
  assert.equal(latestNoId.status, 'succeeded')
})

test('试生成 MiniMax 超时：复用既有 600 秒计费提示文案且不自动重试，任务表 30 分钟 TTL 与上限 20 条', async () => {
  let fetchCalls = 0
  const fetchImpl = async () => {
    fetchCalls++
    throw new DOMException('timeout', 'TimeoutError')
  }
  const { store, request } = await createHost({
    provider: 'minimax',
    key: 'sk-mm',
    fetchImpl,
    llmReplies: [{ values: ['标题', '视觉'] }],
  })
  const draft = { name: '超时测试', template: '21:9 标题 {{主标题}}，视觉 {{视觉}}', guidance: '', usePortrait: false }
  const started = await request('cover-styles/test-generate', { draft, testTitle: '超时', resolution: '1K' })
  const finished = await waitTestJob(request, started.json().jobId)
  assert.equal(finished.status, 'failed')
  assert.match(finished.error, /600 秒.*计费/)
  assert.doesNotMatch(finished.error, /请重试/)
  assert.equal(fetchCalls, 1)

  // 验证 30 分钟 TTL 惰性清理
  assert.equal(COVER_STYLE_TEST_JOB_TTL_MS, 30 * 60 * 1000)
  assert.equal(MAX_COVER_STYLE_TEST_JOB_HISTORY, 20)
  const removed = pruneCoverStyleTestJobs(store, Date.now() + COVER_STYLE_TEST_JOB_TTL_MS + 1000)
  assert.equal(removed, 1)
  const afterPrune = await request(`cover-styles/test-status?jobId=${encodeURIComponent(started.json().jobId)}`)
  assert.equal(afterPrune.status, 404)
})

test('文章正式封面生成：自定义风格按 usePortrait 透传肖像，删除风格后历史记录/切换/下载仍保留 styleName', async () => {
  const png = makePng(94, 40)
  const fetchCalls = []
  const fetchImpl = async (url, init) => {
    fetchCalls.push(JSON.parse(init.body))
    return Response.json({ data: [{ b64_json: png.toString('base64') }] })
  }
  const { store, article, request } = await createHost({
    fetchImpl,
    llmReplies: [
      { values: ['真人风格标题', '界面卡片'] },
      { values: ['纯物件标题', '沙漏'] },
    ],
  })
  await updateSettings(store.root, { portraitUrl: 'https://example.com/me.png' })

  const s1 = (await request('cover-styles/save', {
    name: '博主出镜自定义',
    description: '带真人出镜。',
    usePortrait: true,
    template: '21:9 标题 {{主标题}}，视觉 {{视觉}}，人物 [[SUBJECT]] 穿 [[OUTFIT]]',
    guidance: '',
  })).json().style

  const s2 = (await request('cover-styles/save', {
    name: '纯静物自定义',
    description: '不带真人。',
    usePortrait: false,
    template: '21:9 标题 {{主标题}}，物件 {{物件}}',
    guidance: '',
  })).json().style

  // 用 s1 (usePortrait: true) 生成封面
  await request('cover/generate', { id: article.id, style: s1.id, resolution: '2K', count: 1, format: 'png' })
  const after1 = await waitCover(request)
  assert.equal(fetchCalls[0].image, 'https://example.com/me.png')
  assert.equal(after1.cover.style, s1.id)
  assert.equal(after1.cover.styleName, '博主出镜自定义')
  assert.equal(after1.coverRuns.at(-1).styleName, '博主出镜自定义')
  assert.equal('customStyle' in after1.coverRuns.at(-1), false, '不得把模板正文写进文章记录')

  // 用 s2 (usePortrait: false) 生成封面
  await request('cover/generate', { id: article.id, style: s2.id, resolution: '2K', count: 1, format: 'png' })
  const after2 = await waitCover(request)
  assert.equal(fetchCalls[1].image, undefined)
  assert.equal(after2.cover.styleName, '纯静物自定义')

  // 删除 s1 后，下载 s1 的历史封面与 cover/select 切换均保留 styleName
  const delRes = await request('cover-styles/delete', { id: s1.id })
  assert.equal(delRes.status, 200)
  const firstCoverId = after1.cover.id
  const dl = await request(`cover/image?id=${article.id}&asset=${firstCoverId}&download=1`)
  assert.equal(dl.status, 200)
  const filename = decodeURIComponent(dl.headers['content-disposition'].split("filename*=UTF-8''")[1])
  assert.match(filename, /博主出镜自定义/)

  const sel = await request('cover/select', { id: article.id, asset: firstCoverId })
  assert.equal(sel.status, 200)
  assert.equal(sel.json().current.cover.styleName, '博主出镜自定义')
})

test('修复回归：并发 TOCTOU 单活锁、多图 analyze 超 4MB、prompt 超时不误报 MiniMax 计费、20 条历史上限与 404/415 路由', async () => {
  const png = makePng(94, 40)
  let fetchCalls = 0
  let releaseFetch
  const fetchGate = new Promise(r => { releaseFetch = r })
  const fetchImpl = async () => {
    fetchCalls++
    await fetchGate
    return Response.json({ data: [{ b64_json: png.toString('base64') }] })
  }
  const { store, request } = await createHost({
    fetchImpl,
    llmReplies: [{ values: ['并发标题', '并发视觉'] }],
  })
  const draft = { name: '并发锁', template: '21:9 标题 {{主标题}}，视觉 {{视觉}}', guidance: '', usePortrait: false }

  // 1. Promise.all 并发发起两次 test-generate：必须 1 次 200 + 1 次 409，只触发 1 次生图
  const [r1, r2] = await Promise.all([
    request('cover-styles/test-generate', { draft, testTitle: 'C1', resolution: '1K' }),
    request('cover-styles/test-generate', { draft, testTitle: 'C2', resolution: '1K' }),
  ])
  const statuses = [r1.status, r2.status].sort((a, b) => a - b)
  assert.deepEqual(statuses, [200, 409])
  const okRes = r1.status === 200 ? r1 : r2
  const conflictRes = r1.status === 409 ? r1 : r2
  assert.equal(conflictRes.json().activeJobId, okRes.json().jobId)
  releaseFetch()
  const done = await waitTestJob(request, okRes.json().jobId)
  assert.equal(done.status, 'succeeded')
  assert.equal(fetchCalls, 1)

  // 保存消费 previewDraftToken 后，activeTestJob 自动清空为 null
  const saved = await request('cover-styles/save', {
    name: '消费草稿测试',
    description: '描',
    usePortrait: false,
    template: draft.template,
    previewDraftToken: done.result.draftToken,
  })
  assert.equal(saved.status, 200)
  assert.equal((await request('cover-styles')).json().activeTestJob, null)

  // 2. 404 / 415 / delete 400 & 404 路由覆盖
  assert.equal((await request('cover-styles/item?id=custom-notfound')).status, 404)
  assert.equal((await request('cover-styles/preview?id=custom-notfound')).status, 404)
  assert.equal((await request('cover-styles/draft-preview?token=00000000-0000-4000-8000-000000000000')).status, 404)
  assert.equal((await request('cover-styles/delete', { id: 'classic' })).status, 400)
  assert.equal((await request('cover-styles/delete', { id: 'custom-notfound' })).status, 404)
  const fs = await import('node:fs/promises')
  await fs.writeFile(join(store.root, 'cover-styles', saved.json().style.id, 'preview.png'), 'corrupt-text')
  assert.equal((await request(`cover-styles/preview?id=${saved.json().style.id}`)).status, 415)

  // 3. prompt 阶段 LLM TimeoutError 在 minimax 提供方下不得误报 600 秒计费警告
  const mmPromptTimeout = await createHost({
    provider: 'minimax',
    key: 'sk-mm',
    llmReplies: [new DOMException('prompt timeout', 'TimeoutError')],
    fetchImpl: async () => { assert.fail('prompt 阶段超时不应调 MiniMax 生图接口') },
  })
  const ptStart = await mmPromptTimeout.request('cover-styles/test-generate', { draft, testTitle: 'PT', resolution: '1K' })
  const ptEnd = await waitTestJob(mmPromptTimeout.request, ptStart.json().jobId)
  assert.equal(ptEnd.status, 'failed')
  assert.doesNotMatch(ptEnd.error, /600 秒|计费/)
  assert.match(ptEnd.error, /超时/)

  // 4. 超过 20 条已完成试生成任务时，最旧的任务被淘汰至 20 条
  const capHost = await createHost({
    fetchImpl: async () => Response.json({ data: [{ b64_json: png.toString('base64') }] }),
    llmReplies: Array.from({ length: 22 }, (_, i) => ({ values: [`标题${i}`, `视觉${i}`] })),
  })
  const jobIds = []
  for (let i = 0; i < 22; i++) {
    const st = await capHost.request('cover-styles/test-generate', { draft, testTitle: `J${i}`, resolution: '1K' })
    assert.equal(st.status, 200)
    const id = st.json().jobId
    jobIds.push(id)
    await waitTestJob(capHost.request, id)
  }
  assert.equal((await capHost.request(`cover-styles/test-status?jobId=${jobIds[0]}`)).status, 404, '第 1 条最旧任务应已被淘汰')
  assert.equal((await capHost.request(`cover-styles/test-status?jobId=${jobIds[1]}`)).status, 404, '第 2 条最旧任务应已被淘汰')
  assert.equal((await capHost.request(`cover-styles/test-status?jobId=${jobIds[21]}`)).status, 200, '最新任务应保留')

  // 5. 多张大图（合计 JSON > 4 MB 但单张解码 <= 2 MB）调用 POST cover-styles/analyze 不被 413 拦截
  const bigPng = Buffer.concat([makePng(94, 40), Buffer.alloc(1_600_000, 0x00)])
  const bigDataUrl = `data:image/png;base64,${bigPng.toString('base64')}`
  const bigHost = await createHost({
    llmReplies: [{
      name: '大图分析测试',
      description: '验证 3 张 1.6MB 图片 JSON 超过 4MB 时不被 413 拦截。',
      usePortrait: false,
      template: '21:9 大图测试 {{主标题}} 与 {{视觉主体}}',
      guidance: '',
    }],
  })
  const bigRes = await bigHost.request('cover-styles/analyze', { referenceImages: [bigDataUrl, bigDataUrl, bigDataUrl] })
  assert.equal(bigRes.status, 200)
  assert.equal(bigRes.json().draft.name, '大图分析测试')
})
