import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { CARD_SIZE, FONT_STACK, PADDING, layoutCard, wrapText } from '../client/xhs-card-layout.js'

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
  assert.equal(PADDING, 96)
  assert.ok(FONT_STACK.includes('PingFang SC'))
})

test('wrapText 支持中文按宽断行、行首行尾禁则与英文单词不拆开', () => {
  const measure = fixedMeasure(40)
  // 1. 中文断行且句号不出现在行首
  const lines = wrapText('第一句话刚好到这里结束。第二句话接着开始展示排版效果。', 400, measure)
  assert.ok(lines.length >= 2)
  for (const line of lines.slice(1)) {
    assert.doesNotMatch(line, /^[，。！？、；：）」』》”’…]/)
  }

  // 2. 左括号不放行尾
  const openBracketLines = wrapText('这是一个用于测试左括号（不能留在行尾的例子）文本', 320, measure)
  for (const line of openBracketLines.slice(0, -1)) {
    assert.doesNotMatch(line, /[（(「『《“‘]$/)
  }

  // 3. 英文单词不被拆开
  const mixed = wrapText('用 OpenAI 做高效自动化的文章拆解流程', 240, measure)
  assert.ok(mixed.some(line => line.includes('OpenAI')), `OpenAI 不应被拆开: ${JSON.stringify(mixed)}`)

  // 4. 单个超长英文单词降级硬拆且不死循环
  const longWord = wrapText('supercalifragilisticexpialidocious', 160, measure)
  assert.ok(longWord.length >= 2)
  assert.equal(longWord.join(''), 'supercalifragilisticexpialidocious')
})

test('layoutCard 渲染 cover/quote/list/end 四种版式、页码与 palette 配色', () => {
  const measure = (text, fontPx) => fixedMeasure(fontPx)(text)
  const opts = { index: 1, total: 6, palette: BLUE_PALETTE, author: '林月半子' }

  const cover = layoutCard({ kind: 'cover', heading: '把长文拆成高密度笔记', lines: ['三分钟完成多平台分发'] }, opts, measure)
  assert.equal(cover.overflow, false)
  assert.ok(cover.ops.some(op => op.type === 'text' && op.text === '2/6'))
  assert.ok(cover.ops.some(op => op.type === 'text' && op.text === '林月半子'))
  assert.ok(cover.ops.some(op => op.type === 'rect' && op.fill === BLUE_PALETTE.mark))
  const markIdx = cover.ops.findIndex(op => op.type === 'rect' && op.fill === BLUE_PALETTE.mark)
  const titleIdx = cover.ops.findIndex(op => op.type === 'text' && op.color === BLUE_PALETTE.main && op.fontPx >= 72)
  assert.ok(markIdx !== -1 && titleIdx !== -1 && markIdx < titleIdx, '荧光笔底块需在标题文字之前绘制')

  const quoteShort = layoutCard({ kind: 'quote', heading: '核心观点', lines: ['先做最小可用版本，再收集真实反馈。'] }, opts, measure)
  assert.equal(quoteShort.overflow, false)
  const quoteTextOp = quoteShort.ops.find(op => op.type === 'text' && op.text.includes('最小可用'))
  assert.equal(quoteTextOp.fontPx, 64)

  const listCard = layoutCard({ kind: 'list', heading: '三步清单', lines: ['保留原始数据', '压缩过渡空话', '导出纯正卡片'] }, opts, measure)
  assert.equal(listCard.overflow, false)
  assert.ok(listCard.ops.some(op => op.type === 'text' && op.text === '1'))
  assert.ok(listCard.ops.some(op => op.type === 'text' && op.text === '3'))

  const endCard = layoutCard({ kind: 'end', heading: '点个收藏备用', lines: ['公众号搜「林月半子」看全文'] }, opts, measure)
  assert.equal(endCard.overflow, false)
  assert.ok(endCard.ops.some(op => op.type === 'rect' && op.fill === BLUE_PALETTE.tint))

  // 非溢出卡片所有坐标在画布范围内
  for (const res of [cover, quoteShort, listCard, endCard]) {
    for (const op of res.ops) {
      if (op.type === 'rect') {
        assert.ok(op.x >= 0 && op.y >= 0 && op.x + op.w <= CARD_SIZE.width && op.y + op.h <= CARD_SIZE.height)
      } else {
        assert.ok(op.x >= 0 && op.x <= CARD_SIZE.width && op.y >= 0 && op.y <= CARD_SIZE.height)
      }
    }
  }

  // 配色切换会反映到 ops 中
  const tealCover = layoutCard({ kind: 'cover', heading: '切换配色', lines: [] }, { ...opts, palette: TEAL_PALETTE }, measure)
  assert.ok(tealCover.ops.some(op => op.type === 'rect' && op.fill === TEAL_PALETTE.soft))
  assert.ok(tealCover.ops.some(op => op.type === 'rect' && op.fill === TEAL_PALETTE.main))
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
  assert.ok(quoteLines.length > 0 && quoteLines.every(op => op.fontPx === 44))
})
