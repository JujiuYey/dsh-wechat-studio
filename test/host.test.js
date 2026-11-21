import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { cleanMarkdown, extractJson, listModels, loadSkill, modelInfo, setModelOverride } from '../src/ai.js'
import { applyOps, blockKind, createArticle, fixGroups, fixPlan, isCheckable, revisionChanges, snapshot, splitMarkdown, toMarkdown, undo } from '../src/article.js'
import { checkBanner, detectionText, renderLayout } from '../src/layout.js'
import { bannerGuide, normalizeSpec } from '../src/banner.js'
import { applyReport, markBlocks, parseReportSegments, pdfToText, reportOverall } from '../src/report.js'
import { Pipeline } from '../src/pipeline.js'
import { readInlineImage, saveInlineImage } from '../src/inline-assets.js'
import { Store } from '../src/store.js'
import { publicSettings, readSettings, updateSettings } from '../src/settings.js'
import { DEFAULT_ENDPOINT, detect, mapSegments } from '../src/zhuque.js'

const MD = `---
slug: demo
---

# 标题在这里

第一段，写得足够长，才会参加检测，所以这里多写几个字凑够二十个字。

## 小节

\`\`\`bash
echo one

echo two
\`\`\`

第二段同样要够长，朱雀按片段打分，太短的段落不参加质检流程。

- 列表一
- 列表二
`

test('改稿对比：对齐增删后的段落，按次显示标题和正文，撤销后移除该次改动', () => {
  const article = createArticle({ markdown: '# 旧标题\n\n原段落\n\n删掉我\n\n保留段落' })
  snapshot(article, '改正文')
  applyOps(article, [
    { op: 'insert_after', block: 0, text: '新开头' },
    { op: 'rewrite', block: 1, text: '改后段落' },
    { op: 'delete', block: 2 },
  ])
  snapshot(article, '换标题')
  article.title = '新标题'
  const [latest, earlier] = revisionChanges(article)
  assert.deepEqual(latest.rows, [{ kind: 'title', before: { text: '旧标题' }, after: { text: '新标题' } }])
  assert.deepEqual(earlier.rows, [
    { kind: 'insert', before: null, after: { text: '新开头', number: 1 } },
    { kind: 'rewrite', before: { text: '原段落', number: 1 }, after: { text: '改后段落', number: 2 } },
    { kind: 'delete', before: { text: '删掉我', number: 2 }, after: null },
  ])
  undo(article)
  assert.deepEqual(revisionChanges(article), [earlier])
})

test('切分：front matter、标题单独取出，代码块里的空行不切', () => {
  const { front, title, blocks } = splitMarkdown(MD)
  assert.match(front, /slug: demo/)
  assert.equal(title, '标题在这里')
  assert.equal(blocks.length, 5)
  assert.equal(blockKind(blocks[2]), 'code')
  assert.match(blocks[2], /echo one\n\necho two/)
  assert.deepEqual(blocks.map(blockKind), ['para', 'heading', 'code', 'para', 'list'])
})

test('切分再拼回去，内容不丢', () => {
  const article = createArticle({ markdown: MD })
  assert.equal(toMarkdown(article).trim(), MD.trim())
})

test('只有成段的文字参加质检', () => {
  const { blocks } = splitMarkdown(MD)
  assert.deepEqual(blocks.map(isCheckable), [true, false, false, true, false])
})

test('applyOps：只动点名的段，段号指修改前的位置，越界和未知操作丢弃', () => {
  const article = createArticle({ markdown: MD })
  const before = article.blocks.map(b => b.text)
  const { receipts, changed } = applyOps(article, [
    { op: 'delete', block: 2 },
    { op: 'rewrite', block: 4, text: '改过的第二段' },
    { op: 'rewrite', block: 99, text: '越界' },
    { op: 'drop_table', block: 1 },
    { op: 'title', text: '新标题' },
  ])
  assert.deepEqual(changed, [4])
  assert.equal(receipts.length, 3)
  assert.equal(article.title, '新标题')
  assert.deepEqual(article.blocks.map(b => b.text), [before[0], before[2], '改过的第二段', before[4]])
})

test('撤销回到改动前', () => {
  const article = createArticle({ markdown: MD })
  const before = toMarkdown(article)
  snapshot(article, '测试')
  applyOps(article, [{ op: 'rewrite', block: 1, text: '变了' }, { op: 'title', text: '也变了' }])
  assert.notEqual(toMarkdown(article), before)
  assert.equal(undo(article), '测试')
  assert.equal(toMarkdown(article), before)
  assert.equal(undo(article), null)
})

test('extractJson 容忍代码块和前后说明', () => {
  assert.deepEqual(extractJson('好的：\n```json\n{"a":1}\n```\n完毕'), { a: 1 })
  assert.deepEqual(extractJson('结果是 {"ops":[{"op":"delete","block":1}]} 就这些'), { ops: [{ op: 'delete', block: 1 }] })
  assert.equal(extractJson('没有 JSON'), null)
  assert.equal(cleanMarkdown('```markdown\n# 标题\n\n正文\n```'), '# 标题\n\n正文')
})

test('四份 skill 都能读到，front matter 已去掉', async () => {
  for (const name of ['writer', 'headline', 'humanizer', 'zhuque', 'banner']) {
    const text = await loadSkill(name)
    assert.ok(text.length > 500, name)
    assert.ok(!text.startsWith('---'), name)
  }
  await assert.rejects(loadSkill('../package'))
})

test('loadSkill 去除 LF 和 CRLF front matter，也支持文件末尾结束标记', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-skill-newlines-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const newline of ['\n', '\r\n']) {
    for (const body of ['', `${newline}正文内容${newline}`]) {
      writeFileSync(join(dir, 'writer.md'), `---${newline}name: writer${newline}---${body}`)
      assert.equal(await loadSkill('writer', dir), body.trim())
    }
  }
})

test('打包的 PDF 引擎无需 Chrome 或 pdftotext 即可提取文字', async () => {
  const buffer = readFileSync(new URL('./fixtures/report.pdf', import.meta.url))
  const { extractText, getDocumentProxy } = await import('../dist/unpdf.mjs')
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  try {
    const { text } = await extractText(pdf, { mergePages: true })
    assert.match(text, /AIGC 0\.93 fragment one/)
  } finally {
    await pdf.destroy()
  }
})

test('朱雀结果落到段落：标红、通过、噪声带和「越改越差」', () => {
  const article = createArticle({ markdown: MD })
  const first = markBlocks(article, { overall: { human: 60, suspect: 40, ai: null }, segments: [{ block: 1, score: 0.93 }, { block: 3, score: 1 }, { block: 9, score: 0.9 }, { block: 4, score: 0.2 }] })
  assert.deepEqual(first, { flagged: 1, passed: 1, unmatched: 0, overall: { human: 60, suspect: 40, ai: null } })
  assert.equal(article.blocks[0].check.status, 'flag')
  assert.equal(article.blocks[0].check.level, 'suspect')
  assert.equal(article.blocks[2].check, null, '代码块不参加质检')
  assert.equal(article.blocks[3].check.status, 'pass')
  assert.equal(article.zhuque.round, 1)

  article.blocks[0].prev = article.blocks[0].text
  article.blocks[0].check = { status: 'fixed', score: 0.93, round: 1, fixes: 1 }
  markBlocks(article, { segments: [{ block: 1, score: 0.99 }] })
  assert.equal(article.blocks[0].check.worse, true)
  assert.equal(article.blocks[0].check.level, 'ai')
  assert.equal(article.blocks[0].check.fixes, 1)
  assert.equal(article.zhuque.round, 2)
})

test('排版脚本能跑，检测文本去掉了记号和固定句', async () => {
  const { html, report } = await renderLayout(MD, { style: 'neo', theme: 'navy' })
  assert.match(html, /<html/i)
  assert.match(report, /统计/)
  const plain = await detectionText(`${MD}\n关注「某某」设为「星标」\n`, ['设为「星标」'])
  assert.ok(!plain.includes('#') && !plain.includes('slug:') && !plain.includes('星标'))
  assert.match(plain, /第一段/)
})

test('PDF 取文字：pdftotext 和打包的 unpdf 都走得通', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-test-'))
  const html = join(dir, 'r.html')
  const pdf = join(dir, 'r.pdf')
  writeFileSync(html, '<meta charset=utf-8><p>AIGC 0.93 fragment one</p>')
  try {
    execFileSync('google-chrome', ['--headless', '--no-sandbox', '--disable-gpu', `--print-to-pdf=${pdf}`, html], { stdio: 'ignore' })
  } catch {
    return // 没有 Chrome 的机器上跳过
  }
  const buffer = readFileSync(pdf)
  assert.match(await pdfToText(buffer), /0\.93/)
  const { extractText, getDocumentProxy } = await import('../dist/unpdf.mjs')
  const { text } = await extractText(await getDocumentProxy(new Uint8Array(buffer)), { mergePages: true })
  assert.match(text, /0\.93/)
  await assert.rejects(pdfToText(Buffer.from('not a pdf')), /不是 PDF/)
})

const REPORT_SUMMARY = `序号 片段 占全文比例 占字符数 AIGC值
1 片段1 50% 100 0.8233
2 片段2 50% 100 0.9970`

const REPORT_PDF_LAYOUT = `                 序号                  片段            占全文比例                      占字符数                AIGC值
                 1                   片段1           28.16%                     1407                0.8233
                 2                   片段2           12.11%                     605                 0.9970
                 3                   片段3           15.81%                     790                 0.9698
                 4                   片段4           43.93%                     2195                0.9988

                  检测片段详情
                     NO. 1 片段1 AIGC值 0.8233`

const REPORT_PDF_UNPDF = `序号 ⽚段 占全⽂⽐例 占字符数 AIGC值
1 ⽚段1 28.16% 1407 0.8233
2 ⽚段2 12.11% 605 0.9970
3 ⽚段3 15.81% 790 0.9698
4 ⽚段4 43.93% 2195 0.9988`

test('PDF 总体占比：按片段比例和 AIGC 阈值确定性汇总', () => {
  assert.deepEqual(reportOverall(REPORT_PDF_LAYOUT), { human: 0, suspect: 44, ai: 56 })
})

test('PDF 总体占比：unpdf 的康熙部首字符归一化后同样可算', () => {
  assert.deepEqual(reportOverall(REPORT_PDF_UNPDF), { human: 0, suspect: 44, ai: 56 })
})

test('PDF 总体占比：表格不完整时不猜，分类边界与报告一致', () => {
  assert.equal(reportOverall('1 片段1 28.16% 1407 0.8233'), null)
  assert.deepEqual(reportOverall(`1 片段1 50% 100 0.5
2 片段2 50% 100 0.99`), { human: 0, suspect: 50, ai: 50 })
  assert.equal(reportOverall('没有片段汇总表'), null)
})

function reportContext(reply) {
  const llm = { prepareCall: async () => ({ config: {}, async *stream({ messages }) { yield { type: 'text-delta', text: reply(messages[0].content[0].text) }; yield { type: 'finish', reason: { kind: 'stop' } } } }) }
  const services = { llm, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } }
  return { get: name => services[name] }
}

function reportArticle() {
  return createArticle({ markdown: Array.from({ length: 45 }, (_, index) => `第 ${index + 1} 段正文，写得足够长，用来验证长报告的段落映射。`).join('\n\n') })
}

test('PDF 段落映射：从片段详情直接匹配原文，不调用模型', async () => {
  const first = 'Claude Code 靠 CLAUDE.md 存规则，这段正文写得足够长，用来验证报告匹配。'
  const second = '我第一反应是这和我每天处理的问题一样，这段正文同样足够长。'
  const report = `${REPORT_SUMMARY}
NO. 1 片段1 AIGC值 0.4780
${first.replace('CLAUDE.md', 'CLAUDE\\.md')}
11/18/26, 10:14 AM 朱雀AI生成检测报告单_1794968059828
https://matrix.tencent.com/ai-detect/ai_gen_txt 1/8
NO. 2 片段2 AIGC值 0.7707
${second}`
  const segments = parseReportSegments(report)
  assert.equal(segments.length, 2)
  assert.deepEqual(segments.map(segment => segment.label), [0, 2])
  const article = createArticle({ markdown: `${first}\n\n${second}` })
  const result = await applyReport(reportContext(() => { throw new Error('标准 PDF 不应调用模型') }), article, report)
  assert.equal(result.flagged, 1)
  assert.equal(result.passed, 1)
  assert.equal(article.blocks[0].check.status, 'pass')
  assert.equal(article.blocks[1].check.score, 0.77)
})

test('PDF 段落映射：完整输出无效时按 20 段分批重试并合并结果', async () => {
  let calls = 0
  const ctx = reportContext(user => {
    calls += 1
    if (calls === 1) return '{"overall":null,"segments":['
    const block = Number(user.match(/【(\d+)】/)?.[1])
    return JSON.stringify({ overall: null, segments: [{ block, score: 0.97 }] })
  })
  const article = reportArticle()
  const result = await applyReport(ctx, article, REPORT_SUMMARY)
  assert.equal(calls, 4)
  assert.equal(result.flagged, 3)
  assert.equal(result.passed, 42)
  assert.deepEqual(article.blocks.filter(block => block.check?.status === 'flag').map(block => article.blocks.indexOf(block) + 1), [1, 21, 41])
  assert.deepEqual(article.zhuque.overall, { human: 0, suspect: 50, ai: 50 })
})

test('PDF 段落映射：分批仍无效时明确报模型错误且不写入检测结果', async () => {
  let calls = 0
  const ctx = reportContext(user => {
    calls += 1
    if (calls === 2) return JSON.stringify({ overall: null, segments: [{ block: 1, score: 0.97 }] })
    return '{"overall":null,"segments":['
  })
  const article = reportArticle()
  await assert.rejects(applyReport(ctx, article, REPORT_SUMMARY), error => error.status === 422 && /第 2\/3 批/.test(error.message) && /模型/.test(error.message))
  assert.equal(calls, 3)
  assert.equal(article.zhuque.round, 0)
  assert.ok(article.blocks.every(block => block.check === null))
})

test('流水线：写正文 → 出标题 → 对话改稿 → 读报告 → 改标红段', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'ws-store-')))
  const answers = {
    draft: '# 草稿标题\n\n第一段，写得足够长，才会参加检测，所以这里多写几个字凑够二十个字。\n\n第二段同样要够长，朱雀按片段打分，太短的段落不参加质检流程。',
    titles: '{"titles":["标题甲","标题乙"],"summary":"摘要"}',
    chat: '{"reply":"改了","ops":[{"op":"rewrite","block":2,"text":"第二段被对话改过了，这里也要写够二十个字才算数的。"}]}',
    report: '{"overall":null,"segments":[{"block":1,"score":0.97}]}',
    fix: '第一段改写后的样子。',
  }
  const llm = { prepareCall: async () => ({ config: {}, async *stream({ messages }) { yield { type: 'text-delta', text: answers[messages[0].source.task] }; yield { type: 'finish', reason: { kind: 'stop' } } } }) }
  const services = { llm, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } }
  const pipeline = new Pipeline({ ctx: { get: name => services[name] }, store })
  const article = createArticle({ topic: '选题' })
  const obsoleteAsset = await saveInlineImage(store.root, Buffer.from('89504e470d0a1a0a00000000', 'hex'))
  article.inlineDiagrams = [{ id: 'obsolete', anchorId: 'old-block', status: 'generated', assetId: obsoleteAsset, format: 'png' }]
  await store.update(state => { state.articles.push(article); state.currentId = article.id })

  await pipeline.draft(article.id)
  let saved = (await store.read()).articles[0]
  assert.equal(saved.title, '草稿标题')
  assert.equal(saved.blocks.length, 2)
  assert.deepEqual(saved.inlineDiagrams, [])
  await assert.rejects(readInlineImage(store.root, obsoleteAsset), { code: 'ENOENT' })
  assert.deepEqual(saved.titles.map(t => t.text), ['标题甲', '标题乙'])

  const untouched = saved.blocks[0].text
  await pipeline.chat(article.id, '第 2 段改一下')
  saved = (await store.read()).articles[0]
  assert.equal(saved.blocks[0].text, untouched)
  assert.match(saved.blocks[1].text, /对话改过/)
  assert.deepEqual(saved.chat.at(-1).receipts, ['改写第 2 段'])

  await pipeline.report(article.id, REPORT_SUMMARY)
  saved = (await store.read()).articles[0]
  assert.deepEqual(saved.zhuque.overall, { human: 0, suspect: 50, ai: 50 })
  assert.equal(saved.zhuque.overallDerived, true)
  assert.equal(saved.blocks[0].check.status, 'flag')
  assert.equal(saved.blocks[1].check.status, 'pass')

  await pipeline.fix(article.id, saved.blocks[0].id)
  saved = (await store.read()).articles[0]
  assert.equal(saved.blocks[0].text, '第一段改写后的样子。')
  assert.equal(saved.blocks[0].prev, untouched)
  assert.equal(saved.blocks[0].check.status, 'fixed')
  assert.equal(saved.notice ?? null, saved.notice?.error ? 'error' : saved.notice ?? null)
  assert.ok(!saved.notice?.error, saved.notice?.text)
  assert.equal(pipeline.job(article.id), null)
})

const POSTER = { slug: 'x', title: 't', style: 'poster', poster: { eyebrow: 'AI 实测', title1: '排版这件事', title2: '交给流程', right: 'flow', ask: '帮我排好', result: '排好了', tags: ['一', '二', '三'], big: 'AI' } }

test('横幅规则：每种风格只取自己那一节', async () => {
  const skill = await loadSkill('banner')
  const poster = bannerGuide(skill, 'poster')
  assert.match(poster, /大字海报/)
  assert.doesNotMatch(poster, /十种场景模板/)
  assert.match(bannerGuide(skill, 'card'), /右栏 12 种版式/)
  assert.match(bannerGuide(skill, 'scene'), /pipeline/)
  assert.throws(() => bannerGuide(skill, 'nope'))
})

test('横幅规格：风格由我们定，theme 去掉，结构不对返回 null', () => {
  const spec = normalizeSpec({ ...POSTER, style: 'card', poster: { ...POSTER.poster, theme: 'blue' } }, 'poster')
  assert.equal(spec.style, 'poster')
  assert.equal(spec.poster.theme, undefined)
  assert.equal(normalizeSpec({ card: {} }, 'poster'), null)
  assert.equal(normalizeSpec({ scene: { items: [] } }, 'scene'), null)
  assert.equal(normalizeSpec('x', 'poster'), null)
  assert.equal(normalizeSpec({ scene: { layout: 'path' }, caption: 'c' }, 'scene').style, undefined)
})

test('横幅检查和排版：超字数会被查出来，合格的规格画进页面', async () => {
  assert.deepEqual(await checkBanner(POSTER), [])
  const long = await checkBanner({ ...POSTER, poster: { ...POSTER.poster, title1: '这一行标题明显写得太长了吧' } })
  assert.equal(long.length, 1)
  assert.match(long[0], /标题第一行/)
  const broken = await checkBanner({ style: 'poster', poster: null })
  assert.ok(broken.length >= 1)
  const { html } = await renderLayout(MD, { banner: POSTER })
  assert.match(html, /"banner": \{"orange": "<svg/, '每种配色都有一份横幅')
  assert.match(html, /"banner_neo": \{"orange": "<svg/, '正文切到质感时有质感版横幅')
  const { html: plain } = await renderLayout(MD)
  assert.match(plain, /"banner":\s*null/)
})

test('流水线：横幅超字数时让模型照着问题改一次', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'ws-banner-')))
  const calls = []
  const bad = { ...POSTER, poster: { ...POSTER.poster, title1: '这一行标题明显写得太长了吧' } }
  const llm = { prepareCall: async () => ({ config: {}, async *stream({ messages }) { calls.push(messages[0].content[0].text); yield { type: 'text-delta', text: JSON.stringify(calls.length === 1 ? bad : POSTER) }; yield { type: 'finish', reason: { kind: 'stop' } } } }) }
  const services = { llm, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } }
  const pipeline = new Pipeline({ ctx: { get: name => services[name] }, store })
  const article = createArticle({ markdown: MD })
  await store.update(state => { state.articles.push(article) })
  await pipeline.banner(article.id)
  const saved = (await store.read()).articles[0]
  assert.equal(calls.length, 2)
  assert.match(calls[1], /标题第一行/)
  assert.deepEqual(saved.banners.poster.warnings, [])
  assert.equal(saved.banners.poster.spec.poster.title1, '排版这件事')
})

const reply = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) })

test('朱雀 API：请求格式、结果整理和各种报错', async () => {
  let sent
  const fetchImpl = async (url, init) => {
    sent = { url, init }
    return reply(200, { status: 'success', labels_ratio: { 0: 0.6, 1: 0.1, 2: 0.3 }, makers_models_usage: { total_tokens: 321 },
      segment_labels: [{ text: '第二', label: 2, conf: 0.7, order: 2 }, { text: '第一', label: 0, conf: 0.9, order: 1 }, { nope: true }] })()
  }
  const result = await detect('正文', { key: 'k-123', fetchImpl })
  assert.equal(sent.url, DEFAULT_ENDPOINT)
  assert.equal(sent.init.headers.authorization, 'Bearer k-123')
  assert.deepEqual(JSON.parse(sent.init.body), { text: '正文', is_merge: false })
  assert.deepEqual(result.overall, { human: 60, ai: 10, suspect: 30 })
  assert.deepEqual(result.segments.map(seg => seg.text), ['第一', '第二'])
  assert.equal(result.tokens, 321)

  await assert.rejects(detect('正文', { key: '' }), /还没有设置/)
  await assert.rejects(detect('  ', { key: 'k' }), /没有可以检测/)
  await assert.rejects(detect('正文', { key: 'k', endpoint: 'http://example.com/x' }), /https/)
  await assert.rejects(detect('正文', { key: 'k', fetchImpl: reply(401, { error: { message: 'bad key' } }) }), /无效或没有权限/)
  await assert.rejects(detect('正文', { key: 'k', fetchImpl: reply(429, { msg: 'quota' }) }), /限流或额度.*quota/)
  await assert.rejects(detect('正文', { key: 'k', fetchImpl: reply(500, 'oops') }), /500.*oops/)
  await assert.rejects(detect('正文', { key: 'k', fetchImpl: reply(200, { status: 'failed', msg: '内容不过审' }) }), /内容不过审/)
  await assert.rejects(detect('正文', { key: 'k', fetchImpl: async () => { throw new Error('ECONNRESET') } }), /连不上/)
})

test('朱雀片段按文字对回段落：切分不对齐也能对上，对不上的不下结论', () => {
  const article = createArticle({ markdown: MD })
  const [first, , , second] = article.blocks.map(b => b.text)
  const { segments, covered } = mapSegments(article, [
    { text: `标题在这里\n${first.slice(0, 20)}`, label: 0, conf: 0.8 },
    { text: `${first.slice(20)} 小节`, label: 2, conf: 0.66 },
    { text: '完全无关的一段话，文章里没有。', label: 1, conf: 0.99 },
  ])
  assert.deepEqual(segments, [{ block: 1, level: 'suspect', score: 0.66 }])
  assert.deepEqual([...covered], [0])
  const result = markBlocks(article, { segments, covered }, 'api')
  assert.deepEqual([result.flagged, result.passed, result.unmatched], [1, 0, 1])
  assert.equal(article.blocks[0].check.source, 'api')
  assert.equal(article.blocks[3].check, null, `没对上的段不标通过：${second.slice(0, 6)}`)
})

test('设置：密钥不回传明文，接口地址只收 https', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-settings-'))
  assert.equal(publicSettings(await readSettings(root)).zhuqueKeySet, false)
  const saved = publicSettings(await updateSettings(root, { zhuqueKey: '  sk-abcdef1234  ', fixedLines: ['一句', ' ', 3], nope: 1 }))
  assert.deepEqual([saved.zhuqueKeySet, saved.zhuqueKeyTail, saved.fixedLines], [true, '1234', ['一句']])
  assert.ok(!JSON.stringify(saved).includes('abcdef'))
  assert.equal((await readSettings(root)).zhuqueKey, 'sk-abcdef1234')
  await assert.rejects(updateSettings(root, { zhuqueEndpoint: 'http://evil.example/x' }), /https/)
  assert.equal((await updateSettings(root, { zhuqueEndpoint: '' })).zhuqueEndpoint, DEFAULT_ENDPOINT)
  assert.equal(publicSettings(await updateSettings(root, { zhuqueKey: '' })).zhuqueKeySet, false)
})

test('流水线：API 检测把结果写回段落，并报出用量', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'ws-detect-')))
  const article = createArticle({ markdown: MD })
  await store.update(state => { state.articles.push(article) })
  let body
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body)
    const lines = body.text.split('\n').filter(Boolean)
    return reply(200, { status: 'success', makers_models_usage: { total_tokens: 88 }, segment_labels: lines.map((text, i) => ({ text, order: i, label: text.startsWith('第一段') ? 1 : 0, conf: 0.97 })) })()
  }
  const pipeline = new Pipeline({ ctx: { get: () => null }, store, fetchImpl })
  await pipeline.detect(article.id, { key: 'k', fixedLines: [] })
  const saved = (await store.read()).articles[0]
  assert.ok(!saved.notice?.error, saved.notice?.text)
  assert.ok(!body.text.includes('#') && !body.text.includes('slug'))
  assert.deepEqual(saved.blocks.map(b => b.check?.status ?? null), ['flag', null, null, 'pass', null])
  assert.equal(saved.blocks[0].check.level, 'ai')
  assert.match(saved.notice.text, /1 段要处理.*88 token/)
})

test('模型：跟随 DSH 默认，指定后用指定的，读不到的提供方跳过', async () => {
  const llm = {
    listProviders: () => [{ id: 'a', name: 'A' }, { id: 'b' }, { id: 'c', name: 'C' }],
    listModels: async id => { if (id === 'c') throw new Error('down'); return id === 'a' ? [{ id: 'a1', name: 'A one' }] : [{ id: 'b1' }] },
  }
  const ctx = { get: name => ({ llm, agentDefaultModel: { currentSelection: () => ({ provider: 'a', model: 'a1' }) } })[name] }
  assert.deepEqual(await listModels(ctx), [{ provider: 'a', name: 'A', models: [{ id: 'a1', name: 'A one' }] }, { provider: 'b', name: 'b', models: [{ id: 'b1', name: 'b1' }] }])
  setModelOverride(null)
  assert.deepEqual(modelInfo(ctx), { provider: 'a', model: 'a1' })
  setModelOverride({ provider: 'b', model: 'b1' })
  assert.deepEqual(modelInfo(ctx), { provider: 'b', model: 'b1' })
  setModelOverride({ provider: '', model: '' })
  assert.deepEqual(modelInfo(ctx), { provider: 'a', model: 'a1' })
  const root = mkdtempSync(join(tmpdir(), 'ws-model-'))
  await assert.rejects(updateSettings(root, { model: { provider: 'a', model: '' } }), /一起填/)
  assert.deepEqual((await updateSettings(root, { model: { provider: 'b', model: 'b1' } })).model, { provider: 'b', model: 'b1' })
  assert.deepEqual((await readSettings(root)).model, { provider: 'b', model: 'b1' })
})

const LONG = n => `第${n}段的正文内容写得足够长，这样才会参加朱雀检测和一键处理的流程。`
function flaggedArticle() {
  // 1-3 相邻标红，4 是标题，5-6 标红，7 通过，8 改过两轮，9 该退回，10 噪声带
  const md = [1, 2, 3].map(LONG).concat('## 小节', LONG(5), LONG(6), LONG(7), LONG(8), LONG(9), LONG(10)).join('\n\n')
  const article = createArticle({ markdown: md })
  const flag = (i, extra) => { article.blocks[i].check = { status: 'flag', score: 0.9, level: 'suspect', source: 'pdf', fixes: 0, ...extra } }
  flag(0, { level: 'ai', score: 0.99 }); flag(1); flag(2); flag(4); flag(5, { score: 0.95 })
  article.blocks[6].check = { status: 'pass' }
  flag(7, { fixes: 2 }); flag(8, { worse: true }); flag(9, { score: 0.55 })
  return article
}

test('一键处理：按 skill 跳过三种段，相邻的成组，AI 特征的组先改', () => {
  const article = flaggedArticle()
  const { picked, skipped } = fixPlan(article)
  assert.deepEqual(picked, [0, 1, 2, 4, 5])
  assert.deepEqual(skipped, { twice: 1, worse: 1, noise: 1 })
  assert.deepEqual(fixGroups(article, picked), [[0, 1, 2], [4, 5]])
  assert.deepEqual(fixGroups(article, picked, { maxBlocks: 2 }), [[0, 1], [4, 5], [2]], '拆开后仍按轻重排')
  article.blocks[9].check.source = 'api'
  assert.deepEqual(fixPlan(article).picked, [0, 1, 2, 4, 5, 9], 'API 结果没有噪声带这一说')
})

function batchPipeline(store, answer, { gate } = {}) {
  const calls = []
  const llm = { prepareCall: async () => ({ config: {}, async *stream({ messages }) {
    const text = messages[0].content[0].text
    calls.push(text)
    if (gate) await gate()
    yield { type: 'text-delta', text: answer(text) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }) }
  const services = { llm, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } }
  return { calls, pipeline: new Pipeline({ ctx: { get: name => services[name] }, store }) }
}

const rewriteAll = text => {
  const part = text.split('# 要一起改写的段').pop()
  const numbers = [...part.matchAll(/【(\d+)】/g)].map(m => Number(m[1]))
  return JSON.stringify({ paragraphs: numbers.map(n => ({ block: n, text: n === 2 ? `第2段改写了，[可补：当时的具体时间]` : `第${n}段改写了，写得不一样的长度和节奏。` })).concat({ block: 7, text: '不该动的段' }) })
}

test('一键处理流水线：只改点名的段，整批一次撤销，列出 [可补]', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'ws-fixall-')))
  const article = flaggedArticle()
  const before = article.blocks.map(b => b.text)
  await store.update(state => { state.articles.push(article) })
  const { calls, pipeline } = batchPipeline(store, rewriteAll)
  await pipeline.fixAll(article.id)
  let saved = (await store.read()).articles[0]
  assert.equal(calls.length, 2)
  assert.match(calls[0], /【1】（AIGC 值 0.99）/, 'AI 特征那组先改')
  assert.deepEqual(saved.blocks.map(b => b.check?.status ?? null), ['fixed', 'fixed', 'fixed', null, 'fixed', 'fixed', 'pass', 'flag', 'flag', 'flag'])
  assert.equal(saved.blocks[6].text, before[6], '没点名的段不动')
  assert.equal(saved.blocks[0].prev, before[0])
  assert.equal(saved.blocks[0].check.fixes, 1)
  assert.match(saved.notice.text, /改写了 5 段.*跳过：1 段改过两轮.*第 2 段留了 \[可补\]/)
  undo(saved)
  assert.deepEqual(saved.blocks.map(b => b.text), before, '撤销一次全部退回')
  assert.equal(pipeline.job(article.id), null)
})

test('一键处理流水线：中途停止只改完已经开始的组，某组失败不影响其他组', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'ws-fixstop-')))
  const md = Array.from({ length: 12 }, (_, i) => LONG(i + 1)).join('\n\n## 断开\n\n')
  const article = createArticle({ markdown: md })
  article.blocks.forEach(b => { if (isCheckable(b.text)) b.check = { status: 'flag', score: 0.9, level: 'suspect', source: 'api', fixes: 0 } })
  await store.update(state => { state.articles.push(article) })
  const gate = () => new Promise(resolve => setTimeout(resolve, 20))
  const { calls, pipeline } = batchPipeline(store, text => (text.split('# 要一起改写的段').pop().includes('【3】') ? 'not json' : rewriteAll(text)), { gate })
  const run = pipeline.fixAll(article.id)
  while (calls.length < 3) await new Promise(resolve => setTimeout(resolve, 1))
  assert.equal(pipeline.job(article.id).progress.total, 12)
  assert.equal(pipeline.job(article.id).targets.length, 3, '三组同时在改')
  assert.ok(pipeline.stop(article.id))
  await run
  const saved = (await store.read()).articles[0]
  assert.equal(calls.length, 3, '停止后不再开新的组')
  assert.match(saved.notice.text, /已停止：处理了 3 段，改写 2 段，还有 9 段没动.*1 段这次没改成/)
})

test('飞书 Markdown 导入：先打开稿面，后台上传去重，预览更新，失败后可重试', async () => {
  const { route } = await import('../src/host.js')
  const store = new Store(mkdtempSync(join(tmpdir(), 'ws-cloudinary-')))
  const url = 'https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=temporary'
  const cdn = 'https://res.cloudinary.com/demo/image/upload/example.png'
  const source = '# 标题\n\n![一](<'+ url +'> "说明")\n\n![二]('+ url +')\n\n```md\n![例子]('+ url +')\n```'
  const config = { cloudName: 'demo', apiKey: 'key', apiSecret: 'local-secret' }
  const settings = publicSettings(await updateSettings(store.root, { cloudinary: config }))
  assert.equal(settings.cloudinary.apiSecretSet, true)
  assert.ok(!JSON.stringify(settings).includes(config.apiSecret))
  let calls = 0
  let reject = false
  let release
  const uploading = new Promise(resolve => { release = resolve })
  const deps = {
    ctx: { get: () => null }, store, pipeline: { job: () => null },
    fetchImpl: async (endpoint, { body }) => {
      calls++
      assert.equal(endpoint, 'https://api.cloudinary.com/v1_1/demo/image/upload')
      assert.equal(body.get('file'), url)
      assert.match(body.get('signature'), /^[a-f0-9]{64}$/)
      assert.equal(body.get('api_secret'), null)
      await uploading
      return reject ? new Response(null, { status: 400 }) : Response.json({ secure_url: cdn })
    },
  }
  async function request(path, payload) {
    const req = { url: '/wechat-studio/' + path, method: payload ? 'POST' : 'GET',
      async *[Symbol.asyncIterator]() { if (payload) yield Buffer.from(JSON.stringify(payload)) } }
    let result
    await route(deps, req, { setHeader() {}, end(value) { result = JSON.parse(value) } })
    return result
  }
  async function waitForImport() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const { current } = await request('state')
      if (!current.imageImport?.total) return current
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.fail('后台转存未结束')
  }
  const { current } = await request('articles/new', { markdown: source, titles: false })
  assert.deepEqual(current.imageImport, { total: 1, done: 0 })
  await store.update(state => { state.articles[0].blocks[0].text += '\n正文编辑' })
  release()
  await waitForImport()
  assert.equal(calls, 1)
  const state = await store.read()
  const markdown = toMarkdown(state.articles[0])
  assert.ok(markdown.includes('![一](<' + cdn + '> "说明")'))
  assert.ok(markdown.includes('正文编辑'))
  assert.ok(markdown.includes('![二](' + cdn + ')'))
  assert.ok(markdown.includes('![例子](' + url + ')'))
  assert.ok((await request('layout')).html.replaceAll('\\"', '"').includes('<img src="' + cdn + '"'))
  reject = true
  const failed = await request('articles/new', { markdown: source, titles: false })
  assert.match((await waitForImport()).imageImport.error, /第 1 张飞书图片转存失败/)
  assert.equal((await store.read()).articles.length, 2)
  reject = false
  await request('images/retry', { id: failed.current.id })
  assert.equal((await waitForImport()).imageImport, null)
})

test('归档当前稿件后可跨重启恢复，正文和续写状态保留', async () => {
  const { route } = await import('../src/host.js')
  const store = new Store(mkdtempSync(join(tmpdir(), 'ws-archive-')))
  const article = createArticle({ markdown: MD })
  article.lastView = 'layout'
  await store.update(state => {
    state.articles.push(article)
    state.currentId = article.id
  })
  const updatedAt = article.updatedAt
  const deps = { ctx: { get: () => null }, store, pipeline: { job: () => null } }
  async function request(path, post = false) {
    const req = { url: '/wechat-studio/' + path, method: post ? 'POST' : 'GET',
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ id: article.id })) } }
    let result
    await route(deps, req, { setHeader() {}, end(value) { result = JSON.parse(value) } })
    return result
  }

  await request('articles/archive', true)
  deps.store = new Store(store.root)
  const archived = await request('state')
  assert.equal(archived.current, null)
  assert.ok(archived.articles[0].archivedAt)
  await assert.rejects(request('articles/select', true), { status: 409 })
  await request('articles/restore', true)
  const restored = await request('articles/select', true)
  assert.equal(restored.current.id, article.id)
  assert.equal(restored.articles[0].archivedAt, null)
  assert.equal(restored.articles[0].lastView, 'layout')
  assert.equal(restored.articles[0].updatedAt, updatedAt)
  assert.equal(toMarkdown((await deps.store.read()).articles[0]).trim(), MD.trim())
})

test('稿件分片损坏时 state 返回 storageProblems', async () => {
  const { route } = await import('../src/host.js')
  const root = mkdtempSync(join(tmpdir(), 'ws-storage-problems-'))
  const seed = new Store(root)
  await seed.update(state => {
    state.articles.push({ id: 'a_x', title: '损坏测试', createdAt: '2026-11-19T00:00:00Z', updatedAt: '2026-11-19T00:00:00Z', blocks: [], history: [], chat: [] })
  })
  const dir = join(root, 'articles', 'a_x')
  writeFileSync(join(dir, 'article.json'), '{broken')
  writeFileSync(join(dir, 'article.json.bak'), '{broken')
  const deps = { ctx: { get: () => null }, store: new Store(root), pipeline: { job: () => null } }
  const req = { url: '/wechat-studio/state', method: 'GET', async *[Symbol.asyncIterator]() {} }
  let result
  await route(deps, req, { setHeader() {}, end(value) { result = JSON.parse(value) } })
  assert.deepEqual(result.storageProblems, ['稿件 a_x 已损坏，已改名保留，未加载'])
})

test('state 返回实时 preflight 结果，保存自定义提醒词后立即生效', async () => {
  const { route } = await import('../src/host.js')
  const store = new Store(mkdtempSync(join(tmpdir(), 'ws-preflight-host-')))
  const longTitle = '一'.repeat(33)
  const link = ['https:', '', 'example.com', 'promo'].join('/')
  const article = createArticle({
    markdown: `# ${longTitle}\n\n正文里有外链 ${link} 和秘密代号需要复核。`,
  })
  await store.update(state => {
    state.articles.push(article)
    state.currentId = article.id
  })
  const deps = { ctx: { get: () => null }, store, pipeline: { job: () => null } }
  async function request(path, payload) {
    const req = {
      url: '/wechat-studio/' + path,
      method: payload ? 'POST' : 'GET',
      async *[Symbol.asyncIterator]() { if (payload) yield Buffer.from(JSON.stringify(payload)) },
    }
    let result
    await route(deps, req, { setHeader() {}, end(value) { result = JSON.parse(value) } })
    return result
  }

  const before = await request('state')
  const pf1 = before.current.preflight
  assert.equal(pf1.ok, false)
  assert.equal(pf1.counts.blocking, 1)
  const titleItem = pf1.items.find(item => item.id === 'title-too-long')
  assert.ok(titleItem)
  assert.equal(titleItem.blockId, null)
  const linkItem = pf1.items.find(item => item.id === 'external-link')
  assert.ok(linkItem)
  assert.equal(linkItem.severity, 'warn')
  assert.equal(linkItem.blockId, article.blocks[0].id)
  assert.equal(pf1.items.some(item => item.id === 'custom-banned-word'), false)

  const saved = await request('settings', { preflightWords: ['秘密代号', '  秘密代号  '] })
  assert.deepEqual(saved.preflightWords, ['秘密代号'])

  const after = await request('state')
  const customItem = after.current.preflight.items.find(item => item.id === 'custom-banned-word')
  assert.ok(customItem)
  assert.equal(customItem.severity, 'warn')
  assert.equal(customItem.blockId, article.blocks[0].id)
})
