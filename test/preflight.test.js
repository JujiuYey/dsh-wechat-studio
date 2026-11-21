import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { extractLinks, MAX_WECHAT_TITLE, runPreflight } from '../src/preflight.js'
import { publicSettings, readSettings, updateSettings } from '../src/settings.js'

const SITE = ['https:/', 'example.com'].join('/')
const CDN = ['https:/', 'cdn.example.com'].join('/')

test('干净文章体检通过，阻断与提醒均为 0', () => {
  const res = runPreflight({
    markdown: `# 这是一篇干净的短文\n\n第一段文字简短清晰。\n\n## 小节\n\n![公网图](${CDN}/ok.png)\n\n第二段继续展开说明。\n`,
  })
  assert.equal(res.ok, true)
  assert.deepEqual(res.counts, { blocking: 0, warn: 0, info: 0 })
  assert.equal(res.stats.images, 1)
  assert.equal(res.stats.links, 0)
})

test('标题长度边界：空标题阻断，32 字通过，33 字阻断', () => {
  const empty = runPreflight({ title: '', blocks: [{ id: 'b1', text: '一段正常正文。' }] })
  assert.equal(empty.ok, false)
  assert.equal(empty.items[0].id, 'title-empty')
  assert.equal(empty.items[0].severity, 'blocking')
  assert.equal(empty.items[0].blockId, null)

  const ok32 = runPreflight({ title: '字'.repeat(MAX_WECHAT_TITLE), blocks: [{ id: 'b1', text: '一段正常正文。' }] })
  assert.equal(ok32.ok, true)
  assert.equal(ok32.counts.blocking, 0)

  const bad33 = runPreflight({ title: '字'.repeat(MAX_WECHAT_TITLE + 1), blocks: [{ id: 'b1', text: '一段正常正文。' }] })
  assert.equal(bad33.ok, false)
  assert.equal(bad33.items[0].id, 'title-too-long')
  assert.equal(bad33.items[0].severity, 'blocking')
})

test('媒体与占位阻断：飞书图、本地图、base64 与 [可补/截图] 占位均阻断，代码块内不误报', () => {
  const feishuImg = ['https:/', 'internal.feishu.cn', 'space', 'api', 'box', 'abc'].join('/')
  const base64Img = ['data:image', 'png;base64,AAAA'].join('/')
  const md = [
    '# 媒体测试',
    '',
    `![飞书图](${feishuImg})`,
    '',
    '![本地图](./missing.png)',
    '',
    `![内联](${base64Img})`,
    '',
    '这里留个占位[可补：补上实测数据]和[截图：放后台截图]。',
    '',
    '```markdown',
    '![示例代码里的本地图](./demo.png)',
    '[可补：代码块里的占位不该报错]',
    `${SITE}/in-code-block`,
    '转发抽奖',
    '```',
  ].join('\n')

  const res = runPreflight({ markdown: md })
  assert.equal(res.ok, false)
  const ids = res.items.map(i => i.id)
  assert.ok(ids.includes('feishu-image'))
  assert.ok(ids.includes('local-image'))
  assert.ok(ids.includes('placeholder'))
  assert.equal(res.counts.blocking, 4)
  assert.equal(res.stats.links, 0)
  assert.ok(!ids.includes('compliance-word'))
})

test('链接提取与商单提醒：去重、剥离尾部标点、排除图片与代码块，且永不阻断发布', () => {
  const urls = extractLinks(`看 [官网](${SITE}/a) 和详情（${SITE}/b）。还有 ![图](${CDN}/1.png) 与 \`${SITE}/code\`。`)
  assert.deepEqual(urls, [`${SITE}/a`, `${SITE}/b`])

  const mpUrl = ['https:/', 'mp.weixin.qq.com', 's', 'demo123'].join('/')
  const res = runPreflight({
    title: '商单文章测试',
    blocks: [
      { id: 'b1', text: `点击 [产品页](${SITE}/prod) 查看，或者访问（${SITE}/docs）。` },
      { id: 'b2', text: `往期文章见 ${mpUrl}` },
    ],
  })
  assert.equal(res.ok, true, '外链只做提醒，绝不阻断发布')
  assert.equal(res.counts.blocking, 0)
  assert.equal(res.stats.links, 3)
  const linkItems = res.items.filter(i => i.id === 'external-link')
  assert.equal(linkItems.length, 2)
  assert.equal(linkItems[0].severity, 'warn')
  assert.equal(linkItems[0].blockId, 'b1')
  assert.equal(linkItems[0].blockNumber, 1)
  assert.deepEqual(linkItems[0].matches, [`${SITE}/prod`, `${SITE}/docs`])
})

test('文字墙与视觉节奏边界：160/161 与 600/601，标题/图片/引用/列表重置连续累计', () => {
  const p160 = '正'.repeat(160)
  const p161 = '正'.repeat(161)

  const ok160 = runPreflight({ title: '短段测试', blocks: [{ id: 'b1', text: p160 }] })
  assert.equal(ok160.stats.longParagraphs, 0)

  const warn161 = runPreflight({ title: '长段测试', blocks: [{ id: 'b1', text: p161 }] })
  assert.equal(warn161.ok, true)
  assert.equal(warn161.stats.longParagraphs, 1)
  assert.equal(warn161.items[0].id, 'long-paragraph')
  assert.equal(warn161.items[0].blockId, 'b1')

  const four = Array.from({ length: 4 }, (_, i) => ({ id: `p${i}`, text: '文'.repeat(150) }))
  assert.equal(runPreflight({ title: '六百字', blocks: four }).items.filter(i => i.id === 'dense-run').length, 0)

  const over600 = [...four, { id: 'p4', text: '一' }]
  const denseRes = runPreflight({ title: '超六百字', blocks: over600 })
  assert.equal(denseRes.items.filter(i => i.id === 'dense-run').length, 1)
  assert.equal(denseRes.items.find(i => i.id === 'dense-run').severity, 'info')

  const broken = [
    { id: 'p1', text: '文'.repeat(150) },
    { id: 'p2', text: '文'.repeat(150) },
    { id: 'h1', text: '## 中间小节' },
    { id: 'p3', text: '文'.repeat(150) },
    { id: 'p4', text: '文'.repeat(150) },
    { id: 'q1', text: '> 一句引用' },
    { id: 'p5', text: '文'.repeat(150) },
  ]
  assert.equal(runPreflight({ title: '有节奏', blocks: broken }).items.filter(i => i.id === 'dense-run').length, 0)
})

test('内置合规词与自定义词提醒：忽略 fixedLines，并去重合并排版专属 layoutIssues', () => {
  const res = runPreflight(
    {
      title: '合规词测试',
      blocks: [
        { id: 'b1', text: '这篇活动支持转发抽奖，而且竞品A也不错。' },
        { id: 'b2', text: '固定尾注：转发抽奖仅限粉丝' },
      ],
    },
    {
      fixedLines: ['固定尾注：转发抽奖'],
      customWords: ['竞品A'],
      layoutIssues: [
        '1 张图是飞书临时链接，粘进公众号会丢，发布前换成公众号图库地址',
        '1 处视频占位，需要在公众号里手动插视频或删掉',
      ],
    },
  )
  assert.equal(res.ok, true)
  const compliance = res.items.filter(i => i.id === 'compliance-word')
  const custom = res.items.filter(i => i.id === 'custom-banned-word')
  const layout = res.items.filter(i => i.id === 'layout-issue')
  assert.equal(compliance.length, 1, '命中 fixedLines 的第 2 段不误报')
  assert.equal(compliance[0].blockNumber, 1)
  assert.equal(custom.length, 1)
  assert.deepEqual(custom[0].matches, ['竞品A'])
  assert.equal(layout.length, 1, '重复的飞书图提示已去重，视频占位保留')
  assert.match(layout[0].title, /视频占位/)
})

test('settings.preflightWords：清洗、截断后去重、100 条上限、清空与非数组保护', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ws-preflight-words-'))
  try {
    const def = await readSettings(root)
    assert.deepEqual(def.preflightWords, [])
    assert.deepEqual(publicSettings(def).preflightWords, [])

    const longA = '词'.repeat(60) + '尾巴1'
    const longB = '词'.repeat(60) + '尾巴2'
    const updated = await updateSettings(root, {
      preflightWords: [' 竞品A ', '', '竞品A', longA, longB],
    })
    assert.deepEqual(updated.preflightWords, ['竞品A', '词'.repeat(60)])
    assert.deepEqual(publicSettings(updated).preflightWords, ['竞品A', '词'.repeat(60)])

    const ignored = await updateSettings(root, { preflightWords: 'not-an-array' })
    assert.deepEqual(ignored.preflightWords, ['竞品A', '词'.repeat(60)])

    const many = Array.from({ length: 120 }, (_, i) => `敏感词${i}`)
    const capped = await updateSettings(root, { preflightWords: many })
    assert.equal(capped.preflightWords.length, 100)

    const cleared = await updateSettings(root, { preflightWords: [] })
    assert.deepEqual(cleared.preflightWords, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('混合围栏代码块与正文在同一块：代码内不误报，代码外真实问题不漏报', () => {
  const promoUrl = `${SITE}/promo`
  const proseBeforeCode = [
    '前文',
    '```md',
    '[可补：代码示例]',
    promoUrl,
    '![本地图](./demo.png)',
    '转发抽奖',
    '```',
    '后文',
  ].join('\n')
  const resBefore = runPreflight({ title: '代码前接正文', blocks: [{ id: 'b1', text: proseBeforeCode }] })
  assert.equal(resBefore.ok, true)
  assert.deepEqual(resBefore.counts, { blocking: 0, warn: 0, info: 0 })
  assert.equal(resBefore.stats.links, 0)
  assert.equal(resBefore.stats.images, 0)

  const codeBeforeProse = [
    '```js',
    'const demo = true',
    '```',
    '这里还有真实占位[可补：发布前补充]。',
  ].join('\n')
  const resAfter = runPreflight({ title: '代码后接正文', blocks: [{ id: 'b2', text: codeBeforeProse }] })
  assert.equal(resAfter.ok, false)
  assert.equal(resAfter.counts.blocking, 1)
  assert.equal(resAfter.items[0].id, 'placeholder')
  assert.equal(resAfter.items[0].blockId, 'b2')
})

test('行内代码不计入正文字数、长段判断与连续文字统计', () => {
  const longCode = '`' + 'a'.repeat(180) + '`'
  const res = runPreflight({
    title: '行内代码测试',
    blocks: [{ id: 'b1', text: `说明：${longCode}` }],
  })
  assert.equal(res.ok, true)
  assert.equal(res.stats.chars, 3)
  assert.equal(res.stats.longParagraphs, 0)
  assert.equal(res.items.length, 0)

  const denseWithCode = Array.from({ length: 4 }, (_, i) => ({
    id: `c${i}`,
    text: '文'.repeat(100) + '`' + 'x'.repeat(100) + '`',
  }))
  const resDense = runPreflight({ title: '连续行内代码', blocks: denseWithCode })
  assert.equal(resDense.stats.chars, 400)
  assert.equal(resDense.items.filter(i => i.id === 'dense-run').length, 0)
})
