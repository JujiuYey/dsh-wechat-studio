export const CARD_SIZE = { width: 1080, height: 1440 }
export const PADDING = 96
export const FONT_STACK = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif'

const NO_LINE_START = new Set([...'，。！？、；：）」』》”’…,.!?;:)]}>'])
const NO_LINE_END = new Set([...'（「『《“‘([{<'])
const BODY_INK = '#2B2B2B'
const WHITE = '#FFFFFF'

function tokenize(text) {
  const input = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!input) return []
  return input.match(/[A-Za-z0-9_\-./]+|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\s\S]/g) ?? []
}

function splitLongToken(token, maxWidth, measure) {
  const chars = [...token]
  const out = []
  let cur = ''
  for (const ch of chars) {
    if (!cur) {
      cur = ch
    } else if (measure(cur + ch) <= maxWidth) {
      cur += ch
    } else {
      out.push(cur)
      cur = ch
    }
  }
  if (cur) out.push(cur)
  return out
}

export function wrapText(text, maxWidth, measure) {
  const tokens = tokenize(text)
  if (!tokens.length) return []
  const lines = []
  let current = ''

  for (const token of tokens) {
    if (!current) {
      if (token === ' ') continue
      if (measure(token) <= maxWidth) {
        current = token
      } else {
        const parts = splitLongToken(token, maxWidth, measure)
        lines.push(...parts.slice(0, -1))
        current = parts.at(-1) ?? ''
      }
      continue
    }

    if (measure(current + token) <= maxWidth) {
      current += token
      continue
    }

    if (token === ' ') {
      lines.push(current.trimEnd())
      current = ''
      continue
    }

    if (NO_LINE_START.has(token)) {
      lines.push((current + token).trimEnd())
      current = ''
      continue
    }

    const curChars = [...current]
    let carry = ''
    while (curChars.length > 1 && NO_LINE_END.has(curChars.at(-1))) {
      carry = curChars.pop() + carry
    }
    lines.push(curChars.join('').trimEnd())

    const nextStart = carry + token
    if (measure(nextStart) <= maxWidth) {
      current = nextStart
    } else {
      const parts = splitLongToken(nextStart, maxWidth, measure)
      lines.push(...parts.slice(0, -1))
      current = parts.at(-1) ?? ''
    }
  }

  if (current.trimEnd()) lines.push(current.trimEnd())
  return lines
}

function layoutCover(card, { contentWidth, topSafe, bottomSafe, palette }, measure) {
  const maxHeight = bottomSafe - topSafe
  const subtitle = card.lines?.[0] ?? ''
  const subPx = 44
  const subLineH = Math.round(subPx * 1.45)
  const subLines = subtitle ? wrapText(subtitle, contentWidth, text => measure(text, subPx, 500)) : []

  let chosen = null
  let overflow = false
  for (let titlePx = 112; titlePx >= 72; titlePx -= 4) {
    const titleLineH = Math.round(titlePx * 1.3)
    const titleLines = wrapText(card.heading || '', contentWidth, text => measure(text, titlePx, 700))
    const gap = subLines.length ? 44 : 0
    const totalH = titleLines.length * titleLineH + gap + subLines.length * subLineH
    chosen = { titlePx, titleLineH, titleLines, gap, totalH }
    if (totalH <= maxHeight) break
    if (titlePx === 72) overflow = true
  }

  const { titlePx, titleLineH, titleLines, gap, totalH } = chosen
  const startY = topSafe + Math.max(0, Math.round((maxHeight - totalH) * 0.42))
  const ops = []

  if (titleLines.length) {
    const lastLine = titleLines.at(-1)
    const lastW = Math.min(contentWidth, measure(lastLine, titlePx, 700))
    const lastY = startY + (titleLines.length - 1) * titleLineH
    ops.push({
      type: 'rect',
      x: PADDING - 8,
      y: Math.round(lastY + titlePx * 0.62),
      w: Math.min(contentWidth + 16, Math.round(lastW) + 16),
      h: Math.round(titlePx * 0.42),
      fill: palette.mark,
      radius: 8,
    })
  }

  titleLines.forEach((line, i) => {
    ops.push({
      type: 'text',
      x: PADDING,
      y: startY + i * titleLineH,
      text: line,
      fontPx: titlePx,
      weight: 700,
      color: palette.main,
      align: 'left',
    })
  })

  const subStartY = startY + titleLines.length * titleLineH + gap
  subLines.forEach((line, i) => {
    ops.push({
      type: 'text',
      x: PADDING,
      y: subStartY + i * subLineH,
      text: line,
      fontPx: subPx,
      weight: 500,
      color: BODY_INK,
      align: 'left',
    })
  })

  return { ops, overflow }
}

function layoutQuote(card, { contentWidth, topSafe, bottomSafe, palette }, measure) {
  const ops = [
    { type: 'text', x: PADDING, y: topSafe - 16, text: '“', fontPx: 200, weight: 700, color: palette.tint, align: 'left' },
  ]
  const hasHeading = Boolean(card.heading)
  if (hasHeading) {
    ops.push({
      type: 'text',
      x: PADDING,
      y: topSafe + 48,
      text: card.heading,
      fontPx: 36,
      weight: 700,
      color: palette.main,
      align: 'left',
    })
  }

  const areaTop = hasHeading ? topSafe + 132 : topSafe + 120
  const maxHeight = bottomSafe - areaTop
  let chosen = null
  let overflow = false

  for (let fontPx = 64; fontPx >= 44; fontPx -= 4) {
    const lineH = Math.round(fontPx * 1.55)
    const paraGap = 28
    const paragraphs = (card.lines ?? []).map(line => wrapText(line, contentWidth, text => measure(text, fontPx, 600)))
    const totalLines = paragraphs.reduce((sum, p) => sum + p.length, 0)
    const totalH = totalLines * lineH + Math.max(0, paragraphs.length - 1) * paraGap
    chosen = { fontPx, lineH, paraGap, paragraphs, totalH }
    if (totalH <= maxHeight) break
    if (fontPx === 44) overflow = true
  }

  const { fontPx, lineH, paraGap, paragraphs, totalH } = chosen
  let y = areaTop + (overflow ? 0 : Math.max(0, Math.round((maxHeight - totalH) * 0.35)))
  paragraphs.forEach((lines, pIndex) => {
    lines.forEach(line => {
      ops.push({
        type: 'text',
        x: PADDING,
        y,
        text: line,
        fontPx,
        weight: 600,
        color: BODY_INK,
        align: 'left',
      })
      y += lineH
    })
    if (pIndex < paragraphs.length - 1) y += paraGap
  })

  return { ops, overflow }
}

function layoutList(card, { contentWidth, topSafe, bottomSafe, palette }, measure) {
  const maxHeight = bottomSafe - topSafe
  const textX = PADDING + 80
  const itemWidth = contentWidth - 80
  let chosen = null
  let overflow = false

  for (let step = 0; step <= 4; step++) {
    const headPx = Math.max(56, 72 - step * 4)
    const itemPx = Math.max(40, 52 - step * 4)
    const headLineH = Math.round(headPx * 1.3)
    const itemLineH = Math.round(itemPx * 1.45)
    const headLines = card.heading ? wrapText(card.heading, contentWidth, text => measure(text, headPx, 700)) : []
    const items = (card.lines ?? []).map(line => wrapText(line, itemWidth, text => measure(text, itemPx, 500)))
    const itemGap = 40
    const headGap = headLines.length ? 48 : 0
    const itemsH = items.reduce((sum, lines, idx) => {
      const h = Math.max(56, lines.length * itemLineH)
      return sum + h + (idx < items.length - 1 ? itemGap : 0)
    }, 0)
    const totalH = headLines.length * headLineH + headGap + itemsH
    chosen = { headPx, itemPx, headLineH, itemLineH, headLines, items, headGap, itemGap, totalH }
    if (totalH <= maxHeight) break
    if (step === 4) overflow = true
  }

  const { headPx, itemPx, headLineH, itemLineH, headLines, items, headGap, itemGap } = chosen
  const ops = []
  let y = topSafe

  headLines.forEach(line => {
    ops.push({ type: 'text', x: PADDING, y, text: line, fontPx: headPx, weight: 700, color: palette.main, align: 'left' })
    y += headLineH
  })
  y += headGap

  items.forEach((lines, index) => {
    const blockH = Math.max(56, lines.length * itemLineH)
    ops.push({ type: 'rect', x: PADDING, y: y + 4, w: 56, h: 56, fill: palette.main, radius: 28 })
    ops.push({ type: 'text', x: PADDING + 28, y: y + 17, text: String(index + 1), fontPx: 28, weight: 700, color: WHITE, align: 'center' })
    let lineY = y
    lines.forEach(line => {
      ops.push({ type: 'text', x: textX, y: lineY, text: line, fontPx: itemPx, weight: 500, color: BODY_INK, align: 'left' })
      lineY += itemLineH
    })
    y += blockH + itemGap
  })

  return { ops, overflow }
}

function layoutEnd(card, { contentWidth, topSafe, bottomSafe, palette }, measure) {
  const boxPad = 64
  const innerWidth = contentWidth - boxPad * 2
  const maxHeight = bottomSafe - topSafe - 160
  const linePx = 44
  const lineH = Math.round(linePx * 1.5)
  const wrappedLines = (card.lines ?? []).flatMap(line => wrapText(line, innerWidth, text => measure(text, linePx, 500)))

  let chosen = null
  let overflow = false
  for (let headPx = 80; headPx >= 56; headPx -= 4) {
    const headLineH = Math.round(headPx * 1.3)
    const headLines = card.heading ? wrapText(card.heading, innerWidth, text => measure(text, headPx, 700)) : []
    const gap = headLines.length && wrappedLines.length ? 40 : 0
    const contentH = headLines.length * headLineH + gap + wrappedLines.length * lineH
    chosen = { headPx, headLineH, headLines, gap, contentH }
    if (contentH <= maxHeight) break
    if (headPx === 56) overflow = true
  }

  const { headPx, headLineH, headLines, gap, contentH } = chosen
  const boxH = Math.min(bottomSafe - topSafe, contentH + boxPad * 2)
  const boxY = topSafe + Math.max(0, Math.round((bottomSafe - topSafe - boxH) * 0.45))
  const centerX = Math.round(CARD_SIZE.width / 2)
  const ops = [
    { type: 'rect', x: PADDING, y: boxY, w: contentWidth, h: boxH, fill: palette.tint, radius: 24 },
  ]

  let y = boxY + Math.max(boxPad, Math.round((boxH - contentH) / 2))
  headLines.forEach(line => {
    ops.push({ type: 'text', x: centerX, y, text: line, fontPx: headPx, weight: 700, color: palette.main, align: 'center' })
    y += headLineH
  })
  y += gap
  wrappedLines.forEach(line => {
    ops.push({ type: 'text', x: centerX, y, text: line, fontPx: linePx, weight: 500, color: BODY_INK, align: 'center' })
    y += lineH
  })

  return { ops, overflow }
}

export function layoutCard(card, { index = 0, total = 1, palette = {}, author = '' } = {}, measure) {
  const { width, height } = CARD_SIZE
  const contentWidth = width - PADDING * 2
  const footerY = height - PADDING - 28
  const topSafe = PADDING + 48
  const bottomSafe = footerY - 56

  const ops = [
    { type: 'rect', x: 0, y: 0, w: width, h: height, fill: palette.soft },
    { type: 'rect', x: 0, y: 0, w: width, h: 16, fill: palette.main },
  ]

  const layoutCtx = { contentWidth, topSafe, bottomSafe, palette }
  let result
  if (card.kind === 'cover') result = layoutCover(card, layoutCtx, measure)
  else if (card.kind === 'quote') result = layoutQuote(card, layoutCtx, measure)
  else if (card.kind === 'list') result = layoutList(card, layoutCtx, measure)
  else result = layoutEnd(card, layoutCtx, measure)

  ops.push(...result.ops)
  if (author) {
    ops.push({ type: 'text', x: PADDING, y: footerY, text: String(author), fontPx: 28, weight: 500, color: palette.line, align: 'left' })
  }
  ops.push({
    type: 'text',
    x: width - PADDING,
    y: footerY,
    text: `${index + 1}/${total}`,
    fontPx: 28,
    weight: 600,
    color: palette.line,
    align: 'right',
  })

  return { ops, overflow: result.overflow }
}
