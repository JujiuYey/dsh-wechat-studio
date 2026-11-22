import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  DERIVE_LIMITS,
  DERIVE_PLATFORMS,
  MARKDOWN_TARGETS,
  THREAD_VARIANTS,
  charCount,
  normalizeThread,
  normalizeXhs,
  numberTokens,
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
