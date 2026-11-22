export const DERIVE_PLATFORMS = ['thread', 'xhs']
export const THREAD_VARIANTS = ['jike', 'x']
export const MARKDOWN_TARGETS = ['zhihu', 'juejin', 'blog']

export const DERIVE_LIMITS = {
  thread: {
    minPosts: 3,
    maxPosts: 15,
    x: { maxWeighted: 270 }, // X 预留 "12/15 " 编号空间
    jike: { maxChars: 500 },
  },
  xhs: {
    title: 20,
    body: [100, 1000],
    tags: [3, 10],
    tagChars: 15,
    cards: [5, 8],
    heading: 16,
    cover: { lines: [0, 1], lineChars: 24 },
    quote: { lines: [1, 3], lineChars: 48 },
    list: { lines: [2, 5], lineChars: 24 },
    end: { lines: [0, 2], lineChars: 24 },
  },
}

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/
const CARD_KINDS = new Set(['cover', 'quote', 'list', 'end'])
const fail = (message, status = 502, extra = {}) => Object.assign(new Error(message), { status }, extra)

export function charCount(text) {
  return [...String(text ?? '')].length
}

function isSingleWeightCodePoint(cp) {
  return (cp >= 0x0000 && cp <= 0x10ff) ||
    (cp >= 0x2000 && cp <= 0x200d) ||
    (cp >= 0x2010 && cp <= 0x201f) ||
    (cp >= 0x2032 && cp <= 0x2037)
}

export function weightedLength(text) {
  const input = String(text ?? '')
  const urlPattern = /https?:\/\/\S+/g
  let total = 0
  let cursor = 0
  for (const match of input.matchAll(urlPattern)) {
    const segment = input.slice(cursor, match.index)
    for (const ch of segment) total += isSingleWeightCodePoint(ch.codePointAt(0)) ? 1 : 2
    total += 23
    cursor = match.index + match[0].length
  }
  for (const ch of input.slice(cursor)) total += isSingleWeightCodePoint(ch.codePointAt(0)) ? 1 : 2
  return total
}

export function numberTokens(text) {
  return (String(text ?? '').match(/\d[\d,]*(?:\.\d+)?%?/g) ?? []).map(token => token.replace(/,/g, ''))
}

export function unsupportedFacts(text, sourceText) {
  const sourceSet = new Set(numberTokens(sourceText))
  const seen = new Set()
  const out = []
  for (const token of numberTokens(text)) {
    if (/^(?:[1-9]|10)$/.test(token)) continue
    if (!sourceSet.has(token) && !seen.has(token)) {
      seen.add(token)
      out.push(token)
    }
  }
  return out
}

function cleanBigrams(text) {
  return [...String(text ?? '').replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase()]
}

export function sourceOverlap(text, sourceText) {
  const chars = cleanBigrams(text)
  if (chars.length < 2) return 1
  const srcChars = cleanBigrams(sourceText)
  if (srcChars.length < 2) return 0
  const srcSet = new Set()
  for (let i = 0; i < srcChars.length - 1; i++) srcSet.add(srcChars[i] + srcChars[i + 1])
  let hits = 0
  for (let i = 0; i < chars.length - 1; i++) {
    if (srcSet.has(chars[i] + chars[i + 1])) hits += 1
  }
  return hits / (chars.length - 1)
}

function filterSourceIds(rawSource, validIds) {
  if (!Array.isArray(rawSource) || !validIds.size) return []
  const out = []
  const seen = new Set()
  for (const id of rawSource) {
    if (typeof id === 'string' && validIds.has(id) && !seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

function stripThreadPrefix(text) {
  return text.replace(/^\s*(?:[（(\[]\s*\d+\s*\/\s*\d+\s*[）)\]][:：\s]*|\d+\s*\/\s*\d+(?:[:：]\s*|\s+))/, '')
}

export function normalizeThread(raw, { variant = 'jike', blockIds = [], sourceText = '', status = 502 } = {}) {
  if (!THREAD_VARIANTS.includes(variant)) {
    throw fail(`不支持的串推平台：${variant}（可选：${THREAD_VARIANTS.join('、')}）。`, 400)
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.posts)) {
    throw fail('串推格式无效，必须包含 posts 数组。', status)
  }
  const { minPosts, maxPosts, x, jike } = DERIVE_LIMITS.thread
  if (raw.posts.length < minPosts) {
    throw fail(`串推至少需要 ${minPosts} 条（当前 ${raw.posts.length} 条）。`, status)
  }
  if (raw.posts.length > maxPosts) {
    throw fail(`串推最多 ${maxPosts} 条（当前 ${raw.posts.length} 条）。`, status)
  }

  const validIds = new Set(blockIds)
  const posts = []
  const warnings = []
  const errors = []

  raw.posts.forEach((item, index) => {
    const no = index + 1
    if (!item || typeof item !== 'object' || typeof item.text !== 'string') {
      errors.push(`第 ${no} 条串推缺少文本内容`)
      return
    }
    if (CONTROL_CHARS.test(item.text)) {
      errors.push(`第 ${no} 条串推包含不允许的控制字符`)
      return
    }
    const text = stripThreadPrefix(item.text.replace(/\r\n/g, '\n')).trim()
    if (!text) {
      errors.push(`第 ${no} 条串推内容为空`)
      return
    }
    if (variant === 'x') {
      const len = weightedLength(text)
      if (len > x.maxWeighted) {
        errors.push(`第 ${no} 条串推超出 X 加权字数上限 ${x.maxWeighted}（当前 ${len}）`)
        return
      }
    } else {
      const len = charCount(text)
      if (len > jike.maxChars) {
        errors.push(`第 ${no} 条串推超出即刻字数上限 ${jike.maxChars}（当前 ${len}）`)
        return
      }
    }

    const source = filterSourceIds(item.source, validIds)
    posts.push({ text, source })

    if (sourceText) {
      const badFacts = unsupportedFacts(text, sourceText)
      if (badFacts.length) {
        warnings.push(`第 ${no} 条出现原文没有的数字：${badFacts.join('、')}`)
      }
    }
    if (validIds.size > 0 && index > 0 && index < raw.posts.length - 1 && source.length === 0) {
      warnings.push(`第 ${no} 条没有标注来源段落`)
    }
  })

  if (errors.length) {
    throw fail(`${errors.join('；')}。`, status, { issues: errors })
  }

  return { variant, posts, warnings }
}

export function normalizeXhs(raw, { blockIds = [], sourceText = '', status = 502, strictCardLength = true } = {}) {
  if (!raw || typeof raw !== 'object') {
    throw fail('小红书格式无效，必须是 JSON 对象。', status)
  }
  const limits = DERIVE_LIMITS.xhs

  if (typeof raw.title !== 'string') throw fail('小红书缺少标题（title）。', status)
  if (typeof raw.body !== 'string') throw fail('小红书缺少正文（body）。', status)
  if (!Array.isArray(raw.tags)) throw fail('小红书标签（tags）必须是字符串数组。', status)
  if (!Array.isArray(raw.cards)) throw fail('小红书卡片（cards）必须是数组。', status)
  if (raw.cards.length < limits.cards[0] || raw.cards.length > limits.cards[1]) {
    throw fail(`小红书卡片需为 ${limits.cards[0]}–${limits.cards[1]} 页（当前 ${raw.cards.length} 页）。`, status)
  }

  const errors = []
  const warnings = []

  let title = ''
  if (CONTROL_CHARS.test(raw.title)) {
    errors.push('小红书标题包含不允许的控制字符')
  } else {
    title = raw.title.replace(/#/g, '').replace(/[\r\n]+/g, ' ').trim()
    const titleLen = charCount(title)
    if (titleLen < 1 || titleLen > limits.title) {
      errors.push(`小红书标题需为 1–${limits.title} 字（当前 ${titleLen} 字）`)
    }
  }

  let body = ''
  if (CONTROL_CHARS.test(raw.body)) {
    errors.push('小红书正文包含不允许的控制字符')
  } else {
    body = raw.body.replace(/\r\n/g, '\n').trim()
    const bodyLen = charCount(body)
    if (bodyLen > limits.body[1]) {
      errors.push(`小红书正文超出 ${limits.body[1]} 字上限（当前 ${bodyLen} 字）`)
    } else if (bodyLen < 20) {
      errors.push(`小红书正文过短，至少需要 20 字（当前 ${bodyLen} 字）`)
    } else if (bodyLen < limits.body[0]) {
      if (strictCardLength) {
        errors.push(`小红书正文需为 ${limits.body[0]}–${limits.body[1]} 字（当前 ${bodyLen} 字）`)
      } else {
        warnings.push(`正文偏短（${bodyLen} 字，建议 ${limits.body[0]}–${limits.body[1]} 字）`)
      }
    }
  }

  const tags = []
  const seenTags = new Set()
  raw.tags.forEach((rawTag, index) => {
    if (typeof rawTag !== 'string') {
      errors.push(`第 ${index + 1} 个标签必须是文本`)
      return
    }
    if (CONTROL_CHARS.test(rawTag)) {
      errors.push(`第 ${index + 1} 个标签包含不允许的控制字符`)
      return
    }
    const tag = rawTag.replace(/[#\s]+/g, '')
    if (!tag) return
    if (charCount(tag) > limits.tagChars) {
      errors.push(`标签「${tag}」超出 ${limits.tagChars} 字上限（当前 ${charCount(tag)} 字）`)
      return
    }
    if (!seenTags.has(tag)) {
      seenTags.add(tag)
      tags.push(tag)
    }
  })
  if (tags.length < limits.tags[0] || tags.length > limits.tags[1]) {
    errors.push(`小红书标签需为 ${limits.tags[0]}–${limits.tags[1]} 个（当前 ${tags.length} 个）`)
  }

  const validIds = new Set(blockIds)
  const cards = []

  if (sourceText && title && body) {
    const bodyFacts = unsupportedFacts(`${title}\n${body}`, sourceText)
    if (bodyFacts.length) {
      warnings.push(`标题或正文出现原文没有的数字：${bodyFacts.join('、')}`)
    }
  }

  raw.cards.forEach((item, index) => {
    const page = index + 1
    if (!item || typeof item !== 'object') {
      errors.push(`第 ${page} 页卡片格式无效`)
      return
    }
    const kind = item.kind
    if (!CARD_KINDS.has(kind)) {
      errors.push(`第 ${page} 页卡片类型无效：${String(kind)}`)
      return
    }
    if (index === 0 && kind !== 'cover') {
      errors.push('第 1 页卡片类型必须是 cover')
    }
    if (index > 0 && kind === 'cover') {
      errors.push(`第 ${page} 页不能使用 cover，封面只能放在第 1 页`)
    }
    if (kind === 'end' && index !== raw.cards.length - 1) {
      errors.push(`第 ${page} 页不能使用 end，尾页卡只能放在最后 1 页`)
    }

    let heading = ''
    if (item.heading != null && typeof item.heading !== 'string') {
      errors.push(`第 ${page} 页卡片标题必须是文本`)
    } else if (typeof item.heading === 'string' && CONTROL_CHARS.test(item.heading)) {
      errors.push(`第 ${page} 页卡片标题包含不允许的控制字符`)
    } else {
      heading = String(item.heading ?? '').replace(/[\r\n]+/g, ' ').trim()
      const headLen = charCount(heading)
      const hardHeadMax = limits.heading * 2
      if (headLen > hardHeadMax) {
        errors.push(`第 ${page} 页卡片标题超出 ${hardHeadMax} 字硬上限（当前 ${headLen} 字）`)
      } else if (headLen > limits.heading) {
        if (strictCardLength) {
          errors.push(`第 ${page} 页卡片标题超出 ${limits.heading} 字上限（当前 ${headLen} 字）`)
        } else {
          warnings.push(`第 ${page} 页卡片标题偏长（${headLen} 字，建议 ≤ ${limits.heading} 字），可在右侧精简`)
        }
      }
      if ((kind === 'cover' || kind === 'list') && !heading) {
        errors.push(`第 ${page} 页（${kind}）必须填写卡片标题`)
      }
    }

    const lines = []
    if (item.lines != null && !Array.isArray(item.lines)) {
      errors.push(`第 ${page} 页卡片条目（lines）必须是字符串数组`)
    } else {
      let lineTypeOk = true
      for (const rawLine of item.lines ?? []) {
        if (typeof rawLine !== 'string') {
          errors.push(`第 ${page} 页卡片条目必须全部是文本`)
          lineTypeOk = false
          break
        }
        if (CONTROL_CHARS.test(rawLine)) {
          errors.push(`第 ${page} 页卡片条目包含不允许的控制字符`)
          lineTypeOk = false
          break
        }
        const cleaned = rawLine.replace(/[\r\n]+/g, ' ').trim()
        if (cleaned) lines.push(cleaned)
      }
      if (lineTypeOk) {
        if (kind === 'end' && !heading && lines.length === 0) {
          errors.push(`第 ${page} 页（end）不能是空白尾页，请填写标题或至少一行内容`)
        }
        const spec = limits[kind]
        if (lines.length < spec.lines[0] || lines.length > spec.lines[1]) {
          errors.push(`第 ${page} 页（${kind}）正文行数需为 ${spec.lines[0]}–${spec.lines[1]} 行（当前 ${lines.length} 行）`)
        }
        const hardLineMax = Math.max(spec.lineChars * 2, 60)
        lines.forEach((line, lineIdx) => {
          const len = charCount(line)
          if (len > hardLineMax) {
            errors.push(`第 ${page} 页第 ${lineIdx + 1} 行超出 ${hardLineMax} 字硬上限（当前 ${len} 字）`)
          } else if (len > spec.lineChars) {
            if (strictCardLength) {
              errors.push(`第 ${page} 页第 ${lineIdx + 1} 行超出 ${spec.lineChars} 字上限（当前 ${len} 字）`)
            } else {
              warnings.push(`第 ${page} 页第 ${lineIdx + 1} 行偏长（${len} 字，建议 ≤ ${spec.lineChars} 字），可在右侧精简`)
            }
          }
        })
      }
    }

    const source = filterSourceIds(item.source, validIds)
    cards.push({ kind, heading, lines, source })

    if (sourceText) {
      if (kind === 'quote' && sourceOverlap(lines.join(' '), sourceText) < 0.6) {
        warnings.push(`第 ${page} 页金句偏离原文较多`)
      }
      const cardFacts = unsupportedFacts(`${heading}\n${lines.join('\n')}`, sourceText)
      if (cardFacts.length) {
        warnings.push(`第 ${page} 页卡片出现原文没有的数字：${cardFacts.join('、')}`)
      }
    }
  })

  if (errors.length) {
    throw fail(`${errors.join('；')}。`, status, { issues: errors })
  }

  return { title, body, tags, cards, warnings }
}

export function threadClipboardText(posts, { numbered = true } = {}) {
  const list = Array.isArray(posts) ? posts : []
  const total = list.length
  return list
    .map((post, index) => (numbered ? `${index + 1}/${total} ${post.text}` : post.text))
    .join('\n\n')
}

export function xhsClipboardText({ title = '', body = '', tags = [] } = {}) {
  const tagLine = Array.isArray(tags) && tags.length
    ? tags.map(tag => (String(tag).startsWith('#') ? String(tag) : `#${tag}`)).join(' ')
    : ''
  return [String(title).trim(), String(body).trim(), tagLine].filter(Boolean).join('\n\n')
}
