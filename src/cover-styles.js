export const COVER_STYLES = [
  { id: 'classic', name: '经典深绿', description: '深绿渐变、低对比度终端命令和目录树，适合教程和复盘。', source: 'builtin', usePortrait: true },
  { id: 'editorial', name: '新锐科技编辑', description: '米白纸感、克莱因蓝几何块、悬浮白色应用卡片，适合产品发布和工具介绍。', source: 'builtin', usePortrait: true },
  { id: 'campaign', name: '时尚 Campaign', description: '奶油纸底、黑色巨型英文主题词和荧光绿高亮，适合观点和系列开篇。', source: 'builtin', usePortrait: true },
  { id: 'kinetic', name: '动感大字', description: '暖白底、斜体大标题、红色速度线与右侧人物特写，突出标题。', source: 'builtin', usePortrait: true },
  { id: 'grunge', name: '颗粒海报', description: '暖白皱纸、黑白摄影、颗粒喷溅和亮绿高亮，适合实测和玩法拆解。', source: 'builtin', usePortrait: true },
  { id: 'magenta', name: '纪实海报', description: '做旧水泥墙、主题点色、英文巨字和桌前人物摄影，适合工具实测和反差主题。', source: 'builtin', usePortrait: true },
  { id: 'felt', name: '羊毛毡手作', description: '米色手工纸底、羊毛毡黏土微缩场景、宋体大标题和品牌色小字，适合产品发布和资讯解读。', source: 'builtin', usePortrait: false },
]

export const CUSTOM_COVER_STYLE_LIMITS = Object.freeze({
  maxStyles: 30,
  maxReferenceImages: 3,
  maxReferenceBytes: 2 * 1024 * 1024,
  minSlots: 2,
  maxName: 16,
  maxDescription: 80,
  maxRequirement: 1000,
  maxTemplate: 8000,
  maxGuidance: 4000,
})

const CUSTOM_STYLE_ID_RE = /^custom-[a-z0-9-]{4,32}$/
const PORTRAIT_MARKER_RE = /\[\[(?:SUBJECT|人物)\]\]/

export function isCustomStyleId(id) {
  return typeof id === 'string' && CUSTOM_STYLE_ID_RE.test(id)
}

export function extractTemplateSlots(template) {
  const source = String(template ?? '')
  const slots = []
  for (const match of source.matchAll(/\{\{([^{}]+)\}\}/g)) {
    const name = match[1].trim()
    if (name) slots.push(name)
  }
  return slots
}

export function hasPortraitMarkers(template) {
  return PORTRAIT_MARKER_RE.test(String(template ?? ''))
}

export function resolveCoverStyleName(styleId, styles = null, fallbackName = '') {
  const id = typeof styleId === 'string' ? styleId.trim() : ''
  if (id && Array.isArray(styles)) {
    const live = styles.find(item => item?.id === id)?.name
    if (typeof live === 'string' && live.trim()) return live.trim()
  }
  if (typeof fallbackName === 'string' && fallbackName.trim()) return fallbackName.trim()
  if (id) {
    const builtin = COVER_STYLES.find(item => item.id === id)?.name
    if (builtin) return builtin
  }
  return '封面'
}
