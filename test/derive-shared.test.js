import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  DERIVE_LIMITS,
  DERIVE_PLATFORMS,
  MARKDOWN_TARGETS,
  THREAD_VARIANTS,
  XHS_STYLE_PRESETS,
  cardContentVersion,
  charCount,
  computeDomTopologySignature,
  enforceXhsDarkSurfaceContrast,
  findHardcodedBrandColors,
  normalizeThread,
  normalizeXhs,
  normalizeXhsReferencePlan,
  numberTokens,
  parseSingleXhsCardMarkup,
  parseXhsDeckMarkup,
  sanitizeXhsCardHtml,
  sanitizeXhsCss,
  selectXhsReferenceImages,
  sourceOverlap,
  threadClipboardText,
  unsupportedFacts,
  weightedLength,
  xhsClipboardText,
} from '../src/derive-shared.js'

const sampleSource = '这篇文章介绍了增长 1,200 人，转化率 12.5% 的做法。核心在于先做最小可用版本，再收集真实反馈，避免空想三个月。'

test('derive-shared.js 不含任何 node:* 导入以保持浏览器安全', async () => {
  const src = await readFile(new URL('../src/derive-shared.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /from\s+['"]node:/)
  assert.deepEqual(DERIVE_PLATFORMS, ['thread', 'xhs'])
  assert.deepEqual(THREAD_VARIANTS, ['jike', 'x'])
  assert.deepEqual(MARKDOWN_TARGETS, ['zhihu', 'juejin', 'blog'])
  assert.equal(DERIVE_LIMITS.thread.x.maxWeighted, 270)
})

test('参考图计划清洗角色、共享图和页面分配', () => {
  const cards = [{ kind: 'cover' }, { kind: 'steps' }, { kind: 'quote' }]
  const rawPlan = {
    images: [
      { id: 'ref-1', role: 'cover', reason: '封面' },
      { id: 'ref-2', role: 'content', reason: '步骤' },
      { id: 'ref-3', role: 'style', reason: '共享风格' },
      { id: 'ref-99', role: 'content', reason: '未知图片' },
    ],
    sharedImageIds: ['ref-3', 'ref-2'],
    pages: [
      { page: 1, imageIds: ['ref-1', 'ref-2', 'ref-99'] },
      { page: 2, imageIds: ['ref-2'] },
      { page: 3, imageIds: ['ref-2'] },
      { page: 99, imageIds: ['ref-2'] },
    ],
  }
  const plan = normalizeXhsReferencePlan(rawPlan, {
    cards,
    referenceImageIds: ['ref-1', 'ref-2', 'ref-3'],
  })
  assert.deepEqual(plan.sharedImageIds, ['ref-3'])
  assert.deepEqual(plan.pages[0], { page: 1, imageIds: ['ref-1'] })
  assert.deepEqual(plan.pages[2], { page: 3, imageIds: ['ref-2'] })
  assert.equal(plan.pages.some(item => item.page === 99), false)
  assert.equal(plan.images.some(item => item.id === 'ref-99'), false)
  assert.equal(DERIVE_LIMITS.xhs.referenceImages, 10)
  assert.equal(DERIVE_LIMITS.xhs.referenceImagesPerCard, 2)
  assert.equal(DERIVE_LIMITS.xhs.sharedReferenceImages, 1)

  assert.equal(normalizeXhsReferencePlan(null, { cards }), null)
  assert.equal(normalizeXhsReferencePlan({}, { cards }), null)
  assert.equal(normalizeXhsReferencePlan({ images: [], sharedImageIds: [], pages: [] }, { cards }), null)

  const constrained = normalizeXhsReferencePlan({
    images: [
      { id: 'ref-1', role: 'cover', reason: `封\u0000面${'长'.repeat(130)}` },
      { id: 'ref-2', role: 'content', reason: '内容' },
      { id: 'ref-3', role: 'content', reason: '更多内容' },
      { id: 'ref-4', role: 'style', reason: '风格' },
    ],
    sharedImageIds: ['ref-1', 'ref-4'],
    pages: [
      { page: 1, imageIds: ['ref-2', 'ref-1', 'ref-1'] },
      { page: 2, imageIds: ['ref-1', 'ref-2', 'ref-3', 'ref-2'] },
      { page: 3, imageIds: ['ref-3'] },
    ],
  }, { cards })
  assert.deepEqual(constrained.pages, [
    { page: 1, imageIds: ['ref-1'] },
    { page: 2, imageIds: ['ref-2', 'ref-3'] },
    { page: 3, imageIds: ['ref-3'] },
  ])
  assert.deepEqual(constrained.sharedImageIds, ['ref-4'])
  assert.equal(constrained.images[0].reason.includes('\u0000'), false)
  assert.equal(constrained.images[0].reason.length, 120)

  const withoutUploadDirectory = normalizeXhsReferencePlan(rawPlan, { cards })
  assert.deepEqual(withoutUploadDirectory.pages[1], { page: 2, imageIds: ['ref-2'] })
  assert.equal(normalizeXhsReferencePlan(rawPlan, {
    cards,
    referenceImageIds: ['ref-2'],
  }).images.some(item => item.id === 'ref-1'), false)
})

test('按页选择参考图按共享优先并支持跨页复用', () => {
  const refs = [
    'data:image/png;base64,AA==',
    'data:image/png;base64,BB==',
    'data:image/png;base64,CC==',
  ]
  const plan = normalizeXhsReferencePlan({
    images: [
      { id: 'ref-1', role: 'cover', reason: '封面' },
      { id: 'ref-2', role: 'content', reason: '步骤' },
      { id: 'ref-3', role: 'style', reason: '共享风格' },
    ],
    sharedImageIds: ['ref-3'],
    pages: [
      { page: 1, imageIds: ['ref-1'] },
      { page: 2, imageIds: ['ref-2'] },
      { page: 3, imageIds: ['ref-2'] },
    ],
  }, { cards: [{ kind: 'cover' }, { kind: 'steps' }, { kind: 'quote' }] })
  assert.deepEqual(
    selectXhsReferenceImages(refs, plan, 2).map(item => item.id),
    ['ref-3', 'ref-2'],
    '第 3 页复用第 2 页的内容参考，并带共享风格图',
  )
  assert.deepEqual(selectXhsReferenceImages(refs, plan, 1), [
    { id: 'ref-3', dataUrl: refs[2] },
    { id: 'ref-2', dataUrl: refs[1] },
  ])
  assert.deepEqual(selectXhsReferenceImages(refs, plan, 0), [
    { id: 'ref-3', dataUrl: refs[2] },
    { id: 'ref-1', dataUrl: refs[0] },
  ])
  assert.deepEqual(selectXhsReferenceImages(refs, null, 0), [])
})

test('参考图计划随 normalizeXhs 保留且不保存图片数据', () => {
  const normalized = normalizeXhs({
    title: '参考图计划',
    body: '这是一段符合字数要求的小红书正文内容，用来验证参考图计划会和整套卡片一起保存。'.repeat(3),
    tags: ['参考图', '自动分配', '小红书'],
    cards: [
      { kind: 'cover', heading: '封面', lines: [], source: [] },
      { kind: 'steps', heading: '步骤', lines: ['一', '二', '三'], source: [] },
      { kind: 'quote', heading: '', lines: ['一句金句'], source: [] },
      { kind: 'list', heading: '清单', lines: ['一', '二'], source: [] },
      { kind: 'end', heading: '尾页', lines: [], source: [] },
    ],
    referencePlan: {
      images: [{ id: 'ref-1', role: 'cover', reason: '大标题封面', dataUrl: 'data:image/png;base64,AA==' }],
      sharedImageIds: [],
      pages: [{ page: 1, imageIds: ['ref-1'] }],
    },
  }, { referenceImageIds: ['ref-1'] })
  assert.deepEqual(normalized.referencePlan, {
    images: [{ id: 'ref-1', role: 'cover', reason: '大标题封面' }],
    sharedImageIds: [],
    pages: [{ page: 1, imageIds: ['ref-1'] }],
  })
  assert.equal(JSON.stringify(normalized).includes('data:image'), false)
})

test('深色区域自动补充浅色文字规则且重复归一化不叠加', () => {
  const css = sanitizeXhsCss('.dark-panel { background: var(--xhs-dark); color: var(--xhs-ink); }')
  const once = enforceXhsDarkSurfaceContrast('', css)
  assert.match(once, /\.xhs-artboard \.dark-panel \*/)
  assert.match(once, /color:\s*#FFFFFF\s*!important/)
  const twice = enforceXhsDarkSurfaceContrast('', once)
  assert.equal(twice, once)

  const inline = enforceXhsDarkSurfaceContrast('<div style="background: var(--xhs-dark)"><p>正文</p></div>', '')
  assert.match(inline, /\[style\*="var\(--xhs-dark\)"\]/)
  assert.match(inline, /#FFFFFF\s*!important/)
})

test('weightedLength 与 charCount 正确计算中英文、URL 与 emoji', () => {
  assert.equal(charCount('hello👍'), 6)
  assert.equal(weightedLength('hello'), 5)
  assert.equal(weightedLength('你好'), 4)
  assert.equal(weightedLength('看 https://example.com/a/very/long/path'), 2 + 1 + 23)
  assert.equal(weightedLength('👍'), 2)
  assert.equal(weightedLength('你好—世界'), 4 + 1 + 4) // U+2014 em-dash 计 1
})

test('numberTokens 与 unsupportedFacts 捕获原文没有的数字并忽略 1-10 纯序号', () => {
  assert.deepEqual(numberTokens('增长 1,200 人，转化率 12.5%，成本 0 元'), ['1200', '12.5%', '0'])
  assert.deepEqual(
    unsupportedFacts('3 个方法帮你增长 1200 人，转化率 12.5%，留存 40%，甚至 0 成本和 11 天见效', sampleSource),
    ['40%', '0', '11'],
  )
  assert.deepEqual(unsupportedFacts('1,200 人和 12.5% 以及 5 条建议', sampleSource), [])
})

test('sourceOverlap 计算字符二元组重合度', () => {
  assert.equal(sourceOverlap('先做最小可用版本，再收集真实反馈。', sampleSource), 1)
  assert.equal(sourceOverlap('完全不相干的另外一段文字', sampleSource), 0)
  const partial = sourceOverlap('先做最小可用版本，之后我们再慢慢迭代优化', sampleSource)
  assert.ok(partial > 0.3 && partial < 0.7, `expected partial overlap, got ${partial}`)
  assert.equal(sourceOverlap('好', sampleSource), 1)
  assert.equal(sourceOverlap('测试重合度', '短'), 0)
})

test('normalizeThread 校验条数、X/即刻字数上限、剥离编号并过滤来源与告警', () => {
  const validPosts = [
    { text: '1/5 第一条钩子：增长 1,200 人的复盘', source: ['b1', 'invalid-id', 'b1'] },
    { text: '第二条讲最小可用版本，转化率 12.5%', source: ['b1'] },
    { text: '(3/5) 第三条新增了原文没有的 40% 数据', source: ['b2'] },
    { text: '第四条忘记标来源段落', source: [] },
    { text: '第五条收尾互动', source: [] },
  ]
  const out = normalizeThread({ posts: validPosts }, {
    variant: 'jike',
    blockIds: ['b1', 'b2'],
    sourceText: sampleSource,
  })
  assert.equal(out.variant, 'jike')
  assert.equal(out.posts.length, 5)
  assert.equal(out.posts[0].text, '第一条钩子：增长 1,200 人的复盘')
  assert.deepEqual(out.posts[0].source, ['b1'])
  assert.equal(out.posts[2].text, '第三条新增了原文没有的 40% 数据')
  assert.ok(out.warnings.some(w => w.includes('第 3 条') && w.includes('40%')))
  assert.ok(out.warnings.some(w => w.includes('第 4 条没有标注来源段落')))
  assert.ok(!out.warnings.some(w => w.includes('第 5 条')))

  assert.throws(
    () => normalizeThread({ posts: [{ text: 'a' }, { text: 'b' }] }, { variant: 'jike' }),
    err => err.status === 502 && /至少.*3 条/.test(err.message),
  )

  const longChinese = '汉'.repeat(141) // 282 > 270 weighted, 141 <= 500 jike
  const postsWithLongFirst = [
    { text: longChinese, source: [] },
    { text: '第二条内容', source: [] },
    { text: '第三条内容', source: [] },
  ]
  assert.throws(
    () => normalizeThread({ posts: postsWithLongFirst }, { variant: 'x' }),
    err => err.status === 502 && /第 1 条/.test(err.message) && /270/.test(err.message),
  )
  const jikePass = normalizeThread({ posts: postsWithLongFirst }, { variant: 'jike' })
  assert.equal(jikePass.posts[0].text.length, 141)

  assert.throws(
    () => normalizeThread({ posts: validPosts }, { variant: 'weibo' }),
    err => err.status === 400,
  )
})

test('normalizeXhs 校验结构、卡片类型顺序、字段必填与事实/金句告警', () => {
  const makeXhs = (overrides = {}) => ({
    title: ' #小标题\n实操指南 ',
    body: '这是一段符合字数要求的小红书正文内容，重点记录我们在做增长时的第一原则。'.repeat(3),
    tags: ['#增长', ' 实操指南 ', '#增长', '效率工具'],
    cards: [
      { kind: 'cover', heading: '别再空想三个月', lines: ['增长 1200 人的实操法'], source: ['b1'] },
      { kind: 'quote', heading: '核心原则', lines: ['先做最小可用版本，再收集真实反馈'], source: ['b1'] },
      { kind: 'list', heading: '三步清单', lines: ['第一写最小原型', '第二找十个读者看'], source: ['b1'] },
      { kind: 'quote', heading: '', lines: ['完全是模型自己胡编出来的一段金句'], source: ['b1'] },
      { kind: 'end', heading: '点个收藏', lines: ['去公众号看完整步骤'], source: [] },
    ],
    ...overrides,
  })

  const normalized = normalizeXhs(makeXhs(), { blockIds: ['b1'], sourceText: sampleSource })
  assert.equal(normalized.title, '小标题 实操指南')
  assert.deepEqual(normalized.tags, ['增长', '实操指南', '效率工具'])
  assert.equal(normalized.cards.length, 5)
  assert.ok(normalized.warnings.some(w => w.includes('第 4 页金句偏离原文较多')))
  assert.ok(!normalized.warnings.some(w => w.includes('第 2 页金句偏离原文较多')))

  // 首页非 cover
  assert.throws(
    () => normalizeXhs(makeXhs({
      cards: [
        { kind: 'quote', heading: '', lines: ['不能放首页'], source: [] },
        { kind: 'quote', heading: '', lines: ['二'], source: [] },
        { kind: 'list', heading: '清单', lines: ['a', 'b'], source: [] },
        { kind: 'quote', heading: '', lines: ['四'], source: [] },
        { kind: 'end', heading: '尾页', lines: [], source: [] },
      ],
    })),
    err => err.status === 502 && /第 1 页/.test(err.message) && /cover/.test(err.message),
  )

  // end 在中间
  assert.throws(
    () => normalizeXhs(makeXhs({
      cards: [
        { kind: 'cover', heading: '封面', lines: [], source: [] },
        { kind: 'end', heading: '尾页不能在中间', lines: [], source: [] },
        { kind: 'list', heading: '清单', lines: ['a', 'b'], source: [] },
        { kind: 'quote', heading: '', lines: ['四'], source: [] },
        { kind: 'quote', heading: '', lines: ['五'], source: [] },
      ],
    })),
    err => err.status === 502 && /第 2 页/.test(err.message) && /end/.test(err.message),
  )

  // 标签不足 3 个
  assert.throws(
    () => normalizeXhs(makeXhs({ tags: ['标签1', '#标签1', '标签2'] })),
    err => err.status === 502 && /3–10 个/.test(err.message),
  )

  // 标题超 20 字
  assert.throws(
    () => normalizeXhs(makeXhs({ title: '字'.repeat(21) })),
    err => err.status === 502 && /20/.test(err.message),
  )

  // cover 缺少 heading
  assert.throws(
    () => normalizeXhs(makeXhs({
      cards: [
        { kind: 'cover', heading: '', lines: ['副标题'], source: [] },
        { kind: 'quote', heading: '', lines: ['二'], source: [] },
        { kind: 'list', heading: '清单', lines: ['a', 'b'], source: [] },
        { kind: 'quote', heading: '', lines: ['四'], source: [] },
        { kind: 'end', heading: '尾页', lines: [], source: [] },
      ],
    })),
    err => err.status === 502 && /第 1 页/.test(err.message),
  )

  // 空白 end 页
  assert.throws(
    () => normalizeXhs(makeXhs({
      cards: [
        { kind: 'cover', heading: '封面', lines: [], source: [] },
        { kind: 'quote', heading: '', lines: ['二'], source: [] },
        { kind: 'list', heading: '清单', lines: ['a', 'b'], source: [] },
        { kind: 'quote', heading: '', lines: ['四'], source: [] },
        { kind: 'end', heading: '', lines: [], source: [] },
      ],
    })),
    err => err.status === 502 && /第 5 页/.test(err.message),
  )

  // 多处卡片超长一次性合并报错
  assert.throws(
    () => normalizeXhs(makeXhs({
      cards: [
        { kind: 'cover', heading: '这是一个超过十六字上限的封面标题啦', lines: [], source: [] },
        { kind: 'quote', heading: '', lines: ['二'], source: [] },
        { kind: 'list', heading: '清单', lines: ['a', 'b'], source: [] },
        { kind: 'list', heading: '清单二', lines: ['第一行正常', '第二行刚好二十九个字用来复现一次多点报错的真实测试情况啦啦'], source: [] },
        { kind: 'end', heading: '尾页', lines: [], source: [] },
      ],
    })),
    err => err.status === 502 && /第 1 页/.test(err.message) && /第 4 页第 2 行/.test(err.message) && err.issues?.length === 2,
  )

  // strictCardLength: false 对轻微偏长的卡片标题与单行放行并转为提醒告警，硬约束依然拦截
  const relaxed = normalizeXhs(makeXhs({
    body: '这是一段四十字左右偏短但高于最低二十字硬门槛的小红书测试正文内容用来测试提醒告警。',
    cards: [
      { kind: 'cover', heading: '这是一个超过十六字上限的封面标题啦', lines: [], source: [] },
      { kind: 'quote', heading: '', lines: ['先做最小可用版本，再收集真实反馈'], source: [] },
      { kind: 'list', heading: '清单', lines: ['a', '字'.repeat(29)], source: [] },
      { kind: 'quote', heading: '', lines: ['先做最小可用版本，再收集真实反馈'], source: [] },
      { kind: 'end', heading: '尾页', lines: [], source: [] },
    ],
  }), { strictCardLength: false })
  assert.ok(relaxed.warnings.some(w => w.includes('第 1 页卡片标题偏长')))
  assert.ok(relaxed.warnings.some(w => w.includes('第 3 页第 2 行偏长') && w.includes('29 字')))
  assert.ok(relaxed.warnings.some(w => w.includes('正文偏短')))

  const relaxedLongBody = normalizeXhs(makeXhs({
    body: '字'.repeat(1048),
  }), { strictCardLength: false })
  assert.ok(relaxedLongBody.warnings.some(w => w.includes('正文偏长') && w.includes('1048 字')))

  assert.throws(
    () => normalizeXhs(makeXhs({ title: '字'.repeat(21) }), { strictCardLength: false }),
    err => err.status === 502 && /20/.test(err.message),
  )
  assert.throws(
    () => normalizeXhs(makeXhs({
      cards: [
        { kind: 'cover', heading: '封面', lines: [], source: [] },
        { kind: 'quote', heading: '', lines: ['二'], source: [] },
        { kind: 'list', heading: '清单', lines: ['a', '字'.repeat(61)], source: [] },
        { kind: 'quote', heading: '', lines: ['四'], source: [] },
        { kind: 'end', heading: '尾页', lines: [], source: [] },
      ],
    }), { strictCardLength: false }),
    err => err.status === 502 && /60 字硬上限/.test(err.message),
  )
})

test('normalizeXhs 支持全部 8 种卡型、deckStyle、富字段清洗、imageUrl 白名单与单一版式提醒', () => {
  const rich = normalizeXhs({
    deckStyle: 'editorial',
    title: '高密度多版式卡片',
    body: '这是一段足够一百字的小红书测试正文，主要测试新版八种卡片与多种视觉字段的清洗、保留以及白名单安全检查。'.repeat(2),
    tags: ['效率工具', 'AI协作', '信息图'],
    cards: [
      {
        kind: 'cover',
        badge: '实操笔记',
        heading: '把长文拆成高颜值卡片',
        accent: '告别白纸黑字模板',
        lines: ['八种版式智能搭配'],
        tags: ['#冷白科技风', '双Agent'],
        callout: '左滑看实测',
        imageUrl: 'javascript:alert(1)',
        source: [],
      },
      { kind: 'compare', badge: '痛点', heading: '新旧对比', lines: ['以前 | 手工搬运', '现在 | 自动同步'], callout: '省下大量时间', source: [] },
      { kind: 'steps', badge: '流程', heading: '三步跑通', lines: ['步骤一 | 准备母稿', '步骤二 | 提炼结构', '步骤三 | 导出大图'], imageUrl: 'https://cdn.example.com/step.png', source: [] },
      { kind: 'metrics', badge: '数据', heading: '实测指标', lines: ['1.1 s | 首字延迟 | 稳定性高', '0 次 | 重试失败 | 一次通过'], source: [] },
      { kind: 'grid', badge: '要点', heading: '四个亮点', lines: ['高对比 | 视觉层次清晰', '零依赖 | 浏览器直出'], source: [] },
      { kind: 'end', badge: '总结', heading: '直接抄作业', lines: ['先收藏 | 跑通再来交作业'], callout: '欢迎交流', source: [] },
    ],
  })

  assert.equal(rich.deckStyle, 'editorial')
  assert.equal(rich.cards.length, 6)
  assert.equal(rich.cards[0].badge, '实操笔记')
  assert.equal(rich.cards[0].accent, '告别白纸黑字模板')
  assert.deepEqual(rich.cards[0].tags, ['冷白科技风', '双Agent'])
  assert.equal(rich.cards[0].imageUrl, undefined)
  assert.equal(rich.cards[2].imageUrl, 'https://cdn.example.com/step.png')

  // 非法 deckStyle 回落 tech；全部中页同 kind 给出温和提醒
  const monotone = normalizeXhs({
    deckStyle: 'unknown-style',
    title: '单一版式测试',
    body: '这是一段足够一百字的小红书测试正文，主要用来测试当全部中间页都是同一版式时给出提醒，且非法风格回落默认。'.repeat(2),
    tags: ['标签一', '标签二', '标签三'],
    cards: [
      { kind: 'cover', heading: '封面', lines: [], source: [] },
      { kind: 'list', heading: '第一页', lines: ['甲', '乙'], source: [] },
      { kind: 'list', heading: '第二页', lines: ['甲', '乙'], source: [] },
      { kind: 'list', heading: '第三页', lines: ['甲', '乙'], source: [] },
      { kind: 'end', heading: '尾页', lines: [], source: [] },
    ],
  })
  assert.equal(monotone.deckStyle, 'tech')
  assert.ok(monotone.warnings.some(w => w.includes('卡片版式较为单一')))
})

test('normalizeThread 多条超限时合并报错', () => {
  const long = '汉'.repeat(141)
  assert.throws(
    () => normalizeThread({ posts: [{ text: long }, { text: '正常第二条' }, { text: long }] }, { variant: 'x' }),
    err => err.status === 502 && /第 1 条/.test(err.message) && /第 3 条/.test(err.message) && err.issues?.length === 2,
  )
})

test('threadClipboardText 与 xhsClipboardText 生成规范剪贴板文本', () => {
  const posts = [{ text: '第一条' }, { text: '第二条' }, { text: '第三条' }]
  assert.equal(threadClipboardText(posts), '1/3 第一条\n\n2/3 第二条\n\n3/3 第三条')
  assert.equal(threadClipboardText(posts, { numbered: false }), '第一条\n\n第二条\n\n第三条')
  assert.equal(
    xhsClipboardText({ title: '标题', body: '正文第一段\n\n正文第二段', tags: ['标签一', '标签二'] }),
    '标题\n\n正文第一段\n\n正文第二段\n\n#标签一 #标签二',
  )
})

test('sanitizeXhsCss 强制限定选择器在 .xhs-artboard 内并阻断外部请求与危险定位', () => {
  assert.deepEqual(XHS_STYLE_PRESETS, ['claude', 'editorial', 'tech', 'emerald', 'bold', 'theme'])
  const rawCss = `
    @import url("https://evil.com/x.css");
    @font-face { font-family: Evil; src: url(https://evil.com/f.woff2); }
    body { display: none !important; }
    * { box-sizing: border-box; }
    .ws-derive-bar, .hero-box {
      background-image: url(//evil.com/track.png);
      background: image-set(url("https://evil.com/a.png") 1x);
      position: fixed;
      border: 2px solid var(--xhs-accent);
      padding: 20px;
    }
  `
  const scoped = sanitizeXhsCss(rawCss)
  assert.doesNotMatch(scoped, /@import|@font-face|url\(|image-set\(|evil\.com/i)
  assert.doesNotMatch(scoped, /position\s*:\s*fixed/i)
  assert.match(scoped, /\.xhs-artboard\s*\{/)
  assert.match(scoped, /\.xhs-artboard\s+\*\s*\{/)
  assert.match(scoped, /\.xhs-artboard\s+\.hero-box\b/)
  assert.match(scoped, /border:\s*2px solid var\(--xhs-accent\)/)
  assert.match(scoped, /position:\s*absolute/)
})

test('sanitizeXhsCardHtml 严格执行标签、属性、图片 URL 与内联样式白名单，且不破坏本地 data:image 截图', () => {
  const dirty = `
    <div class="card" onclick="alert(1)" data-xhs-slot="image" style="position:fixed; background:url(https://evil.com/p.png); padding:16px">
      <script>evil()</script>
      <style>body{display:none}</style>
      <iframe src="https://evil.com"></iframe>
      <a href="javascript:alert(1)">链接文字</a>
      <img src="javascript:alert(1)" alt="坏图" />
      <img src="https://cdn.example.com/ok.png" alt="好图" data-img-fit="contain" />
      <p>正常文案</p>
    </div>
  `
  const clean = sanitizeXhsCardHtml(dirty)
  assert.doesNotMatch(clean, /<script|<style|<iframe|onclick|javascript:|evil\.com|position:\s*fixed/i)
  assert.ok(clean.includes('https://cdn.example.com/ok.png'))
  assert.ok(clean.includes('data-img-fit="contain"'))
  assert.ok(clean.includes('position:absolute'))
  assert.ok(clean.includes('正常文案'))

  // 超长 data:image base64 不计入 6000 字符 HTML 标签预算，不会被截断损坏
  const bigDataUri = `data:image/png;base64,${'A'.repeat(12000)}`
  const withLocalImg = sanitizeXhsCardHtml(`<div class="cd-shot-frame"><img src="${bigDataUri}" alt="本地截图" /></div>`)
  assert.ok(withLocalImg.includes(bigDataUri), '本地截图 data URL 不应被 HTML 预算截断')
})

test('computeDomTopologySignature 忽略 class/文本准确识别同构版式并区分不同拓扑', () => {
  const cardA = '<div class="cd-header"><h2>标题A</h2></div><div class="cd-main"><div class="alpha"><p>一</p><p>二</p></div></div>'
  const cardB = '<div class="custom-hd"><h2>完全不同的标题B</h2></div><div class="custom-bd"><div class="beta" style="padding:12px"><p>三</p><p>四</p></div></div>'
  const cardTable = '<div class="cd-header"><h2>对比</h2></div><div class="cd-main"><table><tbody><tr><td>旧</td><td>新</td></tr></tbody></table></div>'
  const cardGrid = '<div class="cd-header"><h2>矩阵</h2></div><div class="cd-main"><div style="display:grid;grid-template-columns:repeat(2,1fr)"><div>1</div><div>2</div></div></div>'

  assert.equal(computeDomTopologySignature(cardA), computeDomTopologySignature(cardB))
  assert.notEqual(computeDomTopologySignature(cardA), computeDomTopologySignature(cardTable))
  assert.notEqual(computeDomTopologySignature(cardTable), computeDomTopologySignature(cardGrid))
})

test('findHardcodedBrandColors 允许中性灰与语义状态色，捕获非中性硬编码主色', () => {
  const ok = findHardcodedBrandColors('color: #0A0A0A; background: #FFFFFF; border-color: #E4E4EE; color: #15803D;')
  assert.deepEqual(ok, [])
  const bad = findHardcodedBrandColors('color: #6D3BF2; background: #FF6B35; border: 1px solid var(--xhs-accent);')
  assert.deepEqual(bad, ['#6D3BF2', '#FF6B35'])
})

test('parseXhsDeckMarkup、parseSingleXhsCardMarkup、自定义 HTML 金句重合度与 cardContentVersion', () => {
  const markup = `
<xhs-meta>
{
  "title": "实操增长复盘",
  "body": "这是一段超过一百字的小红书正文内容，记录我们在做最小可用版本与增长 1,200 人过程中的真实经验与步骤。".repeat_placeholder,
  "tags": ["实操复盘", "增长", "最小版本"],
  "tweaks": { "preset": "claude" }
}
</xhs-meta>
<xhs-style>
.custom-pill { border: 2px solid var(--xhs-accent); }
body { display: none; }
</xhs-style>
<xhs-card page="1" kind="cover" heading="增长 1200 人复盘" badge="实测" source="b1">
  <div class="cd-header"><h1>增长 1200 人复盘</h1></div>
  <div class="cd-main"><p>先做最小可用版本</p></div>
</xhs-card>
<xhs-card page="2" kind="compare" heading="前后对比" source="b1">
  <div class="cd-header"><h2>前后对比</h2></div>
  <div class="cd-main"><table><tbody><tr><td>以前</td><td>空想三个月</td></tr></tbody></table></div>
</xhs-card>
<xhs-card page="3" kind="quote" heading="核心金句" source="b1">
  <div class="cd-header"><h2>核心金句</h2></div>
  <div class="cd-main"><blockquote>这段完全编造的话在母稿里根本没有出现过一句</blockquote></div>
</xhs-card>
<xhs-card page="4" kind="grid" heading="四个要点" source="b1">
  <div class="cd-header"><h2>四个要点</h2></div>
  <div class="cd-main"><div style="display:grid;grid-template-columns:repeat(2,1fr)"><div>甲</div><div>乙</div></div></div>
</xhs-card>
<xhs-card page="5" kind="end" heading="收藏备用" source="">
  <div class="cd-header"><h2>收藏备用</h2></div>
  <div class="cd-main"><p>照着做就行</p></div>
</xhs-card>
`.replace('".repeat_placeholder', '这是一段超过一百字的小红书正文内容，记录我们在做最小可用版本与增长 1,200 人过程中的真实经验与步骤。"')

  const parsed = parseXhsDeckMarkup(markup)
  assert.ok(parsed)
  assert.equal(parsed.cards.length, 5)
  assert.ok(parsed.customCss.includes('.custom-pill'))

  const normalized = normalizeXhs({ ...parsed, designPrompt: '极简工具说明书感' }, {
    blockIds: ['b1'],
    sourceText: sampleSource,
    strictCardLength: false,
  })
  assert.equal(normalized.designPrompt, '极简工具说明书感')
  assert.ok(normalized.customCss.includes('.xhs-artboard .custom-pill'))
  assert.doesNotMatch(normalized.customCss, /body\s*\{/)
  assert.ok(normalized.warnings.some(w => w.includes('第 3 页金句偏离原文较多')), '自定义 HTML 金句卡也应触发 sourceOverlap 告警')

  const single = parseSingleXhsCardMarkup(`
<xhs-page-style>
.local-box { padding: 18px; border: 2px solid var(--xhs-accent); }
</xhs-page-style>
<xhs-card kind="steps" heading="三步跑通" source="b1">
  <div class="local-box"><ol><li>第一步</li><li>第二步</li></ol></div>
</xhs-card>
`)
  assert.ok(single)
  assert.equal(single.kind, 'steps')
  assert.ok(single.pageCss.includes('.local-box'))
  assert.ok(single.html.includes('第一步'))

  const v1 = cardContentVersion(normalized.cards[1])
  const v2 = cardContentVersion({ ...normalized.cards[1], heading: '改了标题' })
  assert.notEqual(v1, v2)

  // 回归：parseXhsDeckMarkup 容忍 <xhs-meta> 内含裸换行、未转义英文双引号、尾随逗号、缺少闭合标签，且不被紧随其后的 <xhs-style> 里的花括号破坏
  const messyStage1 = `<think>构思视觉方向</think>
<xhs-meta>
\`\`\`json
{
  "deckStyle": "tech",
  "tweaks": { "preset": "claude" },
  "title": "两个 "Agent" 关进房间",
  "body": "第一段正文包含裸换行
第二段提到 "Claude" 和 Codex 协作的真实体验，凑满一百字以便后续完整校验通过，这里补充更多实操细节确保正文长度达标且段落清晰自然。",
  "tags": ["实操复盘", "Agent", "效率工具",],
  "cards": [
    { "kind": "cover", "layoutArchetype": "hero", "heading": "两个 "Agent" 协作", "lines": ["零复制粘贴"], "source": ["b1"], }
  ],
}
\`\`\`
<xhs-style>
.hero-tag { color: var(--xhs-accent); }
</xhs-style>`
  const parsedMessy = parseXhsDeckMarkup(messyStage1)
  assert.ok(parsedMessy, '即使 <xhs-meta> 含裸换行、未转义双引号、未闭合标签且紧跟 <xhs-style>，也应成功解析')
  assert.equal(parsedMessy.title, '两个 "Agent" 关进房间')
  assert.equal(parsedMessy.cards[0].heading, '两个 "Agent" 协作')
  assert.ok(parsedMessy.customCss.includes('.hero-tag'))
})

test('卡片组件直接子元素的字号规则在清洗后仍然生效', () => {
  assert.match(sanitizeXhsCss('.panel > p { font-size: 30px }'), /\.xhs-artboard \.panel > p \{ font-size:30px;/)
})
