const GALLERY_HEADER = /^<\[([^\r\n]*)\][ \t]*\r?\n/

export const DEFAULT_GALLERY_LABEL = '图集'

export function isGalleryOpening(line) {
  return line === '<' || /^<\s*!\[/.test(line) || GALLERY_HEADER.test(line + '\n')
}

export function parseGalleryBlock(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed.startsWith('<') || !trimmed.endsWith('>')) return null
  const header = GALLERY_HEADER.exec(trimmed)
  const label = header?.[1].trim() || ''
  const inner = trimmed.slice(header ? header[0].length : 1, -1).trim()
  if (!inner) return null
  const items = []
  const itemRe = /!\[((?:\\.|[^\]\\])*)\]\(<?([^\s>)]+)>?(?:\s+"([^"]*)")?\)/gy
  const sepRe = /[\s,，]+/gy
  let pos = 0
  while (pos < inner.length) {
    itemRe.lastIndex = pos
    const match = itemRe.exec(inner)
    if (!match) return null
    items.push({
      caption: match[1].replace(/\\([\\\[\]])/g, '$1'),
      src: match[2],
      title: match[3] ?? '',
    })
    pos = itemRe.lastIndex
    if (pos >= inner.length) break
    sepRe.lastIndex = pos
    const sep = sepRe.exec(inner)
    if (!sep) return null
    pos = sepRe.lastIndex
  }
  return items.length ? { label, items } : null
}

export function galleryColors(style, palette = { main: '#C9643E', mark: '#FCE7A6', line: '#DAB196' }) {
  const countColor = '#64748B'
  if (style === 'note') return { badgeBg: palette.mark, badgeText: '#1F1F1F', countColor }
  if (style === 'zen') return { badgeBg: 'transparent', badgeText: palette.main, countColor }
  if (style === 'dark') return { badgeBg: palette.line, badgeText: '#0F1218', countColor: '#A8B3C2' }
  return { badgeBg: palette.main, badgeText: '#FFFFFF', countColor }
}
