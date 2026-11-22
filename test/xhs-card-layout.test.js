import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { CARD_SIZE, FONT_STACK, PADDING, XHS_DECK_STYLES, layoutCard, wrapText } from '../client/xhs-card-layout.js'

const BLUE_PALETTE = {
  main: '#2952B6',
  soft: '#F4F8FD',
  tint: '#DDE8FB',
  line: '#A6BBE2',
  mark: '#F9E8A7',
}

const TEAL_PALETTE = {
  main: '#0C7D6C',
  soft: '#F3F9F7',
  tint: '#D8EDE6',
  line: '#9BC5B9',
  mark: '#F8E8AB',
}

const fixedMeasure = (fontPx = 40) => text => {
  let w = 0
  for (const ch of String(text)) {
    w += ch.codePointAt(0) <= 0x00ff ? fontPx * 0.56 : fontPx
  }
  return w
}

test('xhs-card-layout.js 纯函数且不含 node:* 或 DOM 全局对象', async () => {
  const src = await readFile(new URL('../client/xhs-card-layout.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /from\s+['"]node:/)
  assert.doesNotMatch(src, /\b(?:document|window)\b/)
  assert.equal(CARD_SIZE.width, 1080)
  assert.equal(CARD_SIZE.height, 1440)
  assert.equal(PADDING, 80)
  assert.deepEqual(XHS_DECK_STYLES, ['tech', 'editorial', 'bold'])
  assert.ok(FONT_STACK.includes('PingFang SC'))
})

test('wrapText 支持中文按宽断行、行首行尾禁则与英文单词不拆开', () => {
  const measure = fixedMeasure(40)
  const lines = wrapText('第一句话刚好到这里结束。第二句话接着开始展示排版效果。', 400, measure)
  assert.ok(lines.length >= 2)
  for (const line of lines.slice(1)) {
    assert.doesNotMatch(line, /^[，。！？、；：）」』》”’…]/)
  }

  const openBracketLines = wrapText('这是一个用于测试左括号（不能留在行尾的例子）文本', 320, measure)
  for (const line of openBracketLines.slice(0, -1)) {
    assert.doesNotMatch(line, /[（(「『《“‘]$/)
  }

  const mixed = wrapText('用 OpenAI 做高效自动化的文章拆解流程', 240, measure)
  assert.ok(mixed.some(line => line.includes('OpenAI')), `OpenAI 不应被拆开: ${JSON.stringify(mixed)}`)

  const longWord = wrapText('supercalifragilisticexpialidocious', 160, measure)
  assert.ok(longWord.length >= 2)
  assert.equal(longWord.join(''), 'supercalifragilisticexpialidocious')
})

test('layoutCard 渲染全部 8 种版式、3 套视觉风格、image 指令与旧数据兼容', () => {
  const measure = (text, fontPx) => fixedMeasure(fontPx)(text)
  const opts = { index: 1, total: 8, palette: BLUE_PALETTE, author: '林月半子', deckStyle: 'tech' }

  const cards = [
    { kind: 'cover', badge: '实操笔记', heading: '我给 AI 办了个邮箱', accent: '它每天替我拆信', lines: ['两个 Bot 共用一个邮箱'], tags: ['实测', '双Bot'], callout: '左滑看详细拆解 →' },
    { kind: 'compare', badge: '痛点', heading: '以前和现在', lines: ['以前 | 每次手动复制上下文', '现在 | 自动共享全部记录'], callout: '彻底告别复制粘贴' },
    { kind: 'steps', badge: 'STEP 03', heading: '三步完成', lines: ['起草 | 搭项目骨架', '审查 | 跨端提建议', '落地 | 一键打包'], imageUrl: 'https://cdn.example.com/ui.png', callout: '全程无人工搬运' },
    { kind: 'metrics', badge: '实测数据', heading: '首字快不快', lines: ['1.1 s | 首 Token 延迟 | 约 1 秒出首字', '141.6 | 生成速度 | token/s', '0 次 | 失败重试 | 一次跑通'], callout: '稳定不限流' },
    { kind: 'grid', badge: '优势', heading: '四个亮点', lines: ['高密度 | 一眼看懂', '无依赖 | 本地可跑', '多风格 | 一键切换', '防出错 | 严格校验'], callout: '记住这四点就行' },
    { kind: 'list', badge: '清单', heading: '实战注意事项', lines: ['保留原始数据', '压缩过渡空话'], imageUrl: 'wechat-studio/cover/image?id=a1&asset=c1' },
    { kind: 'quote', heading: '核心观点', lines: ['先做最小可用版本，再收集真实反馈。'] },
    { kind: 'end', heading: '照着直接用', lines: ['信息源 | 订阅官方博客', '晚间简报 | 每天汇总一次'], callout: '先收藏备用' },
  ]

  cards.forEach((card, i) => {
    const res = layoutCard(card, { ...opts, index: i }, measure)
    assert.equal(res.overflow, false, `${card.kind} 不应溢出`)
    assert.ok(res.ops.some(op => op.type === 'text' && op.text === `${i + 1}/8`))
    assert.ok(res.ops.some(op => op.type === 'text' && op.text === '@林月半子'))
    // 所有坐标都在画布范围内
    for (const op of res.ops) {
      if (op.type === 'rect' || op.type === 'dotGrid' || op.type === 'image') {
        assert.ok(op.x >= 0 && op.y >= 0 && op.x + op.w <= CARD_SIZE.width && op.y + op.h <= CARD_SIZE.height, `${card.kind} ${op.type} 越界`)
      } else if (op.type === 'line' || op.type === 'arrow') {
        assert.ok(op.x1 >= 0 && op.x2 <= CARD_SIZE.width && op.y1 >= 0 && op.y2 <= CARD_SIZE.height)
      }
    }
  })

  // steps / list 带 imageUrl 时产出 image 指令
  const stepsRes = layoutCard(cards[2], opts, measure)
  assert.ok(stepsRes.ops.some(op => op.type === 'image' && op.src === 'https://cdn.example.com/ui.png'))
  assert.ok(stepsRes.ops.some(op => op.type === 'arrow'))

  // 旧卡片数据（不含 badge / accent / callout / tags）也能生成丰富的卡片元素
  const legacyCover = layoutCard({ kind: 'cover', heading: '旧版封面标题', lines: ['副标题'] }, { index: 0, total: 5, palette: BLUE_PALETTE }, measure)
  assert.ok(legacyCover.ops.some(op => op.type === 'rect' && op.fill === BLUE_PALETTE.main))
  assert.ok(legacyCover.ops.some(op => op.type === 'text' && op.text === '实操笔记'))

  // 3 套风格产生差异化元素（tech 含 dotGrid，editorial 含 polygon，bold 含硬投影）
  assert.ok(layoutCard(cards[0], { ...opts, deckStyle: 'tech' }, measure).ops.some(op => op.type === 'dotGrid'))
  assert.ok(layoutCard(cards[0], { ...opts, deckStyle: 'editorial' }, measure).ops.some(op => op.type === 'polygon'))
  assert.ok(layoutCard(cards[1], { ...opts, deckStyle: 'bold' }, measure).ops.some(op => op.type === 'rect' && op.shadow?.color === '#18181B'))

  // 配色切换反映到 ops 中
  const tealCover = layoutCard({ kind: 'cover', heading: '切换配色', lines: [] }, { ...opts, palette: TEAL_PALETTE }, measure)
  assert.ok(tealCover.ops.some(op => op.fill === TEAL_PALETTE.main || op.color === TEAL_PALETTE.main))
  assert.ok(!tealCover.ops.some(op => op.fill === BLUE_PALETTE.main || op.color === BLUE_PALETTE.main))
})

test('layoutCard 超长 quote 降到下限字号并标出 overflow === true', () => {
  const measure = (text, fontPx) => fixedMeasure(fontPx)(text)
  const hugeQuote = layoutCard(
    {
      kind: 'quote',
      heading: '很长的一页',
      lines: [
        '这是一段非常非常长而且塞了很多细节用来测试排版引擎在降字号到极限之后仍然溢出的金句文本第一段内容，'.repeat(3),
        '这是同样非常非常长并且继续往下占用大量垂直高度的测试金句文本第二段内容，'.repeat(3),
        '这是第三段继续堆满像素高度直到彻底突破底部安全边距的测试金句文本第三段内容。'.repeat(3),
      ],
    },
    { index: 2, total: 6, palette: BLUE_PALETTE, author: '' },
    measure,
  )
  assert.equal(hugeQuote.overflow, true)
  const quoteLines = hugeQuote.ops.filter(op => op.type === 'text' && op.text.includes('测试'))
  assert.ok(quoteLines.length > 0 && quoteLines.every(op => op.fontPx === 40))
})
