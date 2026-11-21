// 公众号草稿推送与信息流卡片预览共用的纯函数元数据派生。
// 保持零外部依赖，既可在 Node 端调用，也可由 esbuild 打包进浏览器端。
import { blockKind, plainOf } from './article.js'

// 微信 draft/add 草稿箱接口 title 上限是 32 字，公众号网页后台手动编辑上限是 64 字，digest 上限是 120 字
export const MAX_TITLE = 32
export const MAX_MP_TITLE = 64
export const MAX_DIGEST = 120

const collapseSpace = value => String(value ?? '').replace(/\s+/g, ' ').trim()

/**
 * 按 UTF-16 码元上限截断字符串，同时避免把末尾的代理对（如 emoji）拆成孤立高代理码元。
 * @param {string} text
 * @param {number} maxChars
 */
export function sliceUtf16Safe(text, maxChars) {
  if (text.length <= maxChars) return text
  let out = text.slice(0, maxChars)
  if (!out.length) return out
  const last = out.charCodeAt(out.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1)
  return out
}

/**
 * 派生草稿推送与转发卡片共用的摘要文本：
 * 优先使用 article.summary；为空时跳过标题、图片、代码块等非正文块，取第一段普通正文（para）纯文本。
 * @param {object} article
 * @param {number} [maxChars=MAX_DIGEST]
 * @returns {{ text: string, fallback: boolean }}
 */
export function deriveDigest(article, maxChars = MAX_DIGEST) {
  const direct = collapseSpace(article?.summary)
  if (direct) return { text: sliceUtf16Safe(direct, maxChars), fallback: false }
  for (const block of article?.blocks ?? []) {
    const raw = typeof block?.text === 'string' ? block.text : ''
    if (!raw.trim()) continue
    const kind = block.kind ?? blockKind(raw)
    if (kind !== 'para') continue
    const text = collapseSpace(plainOf(raw))
    if (text) return { text: sliceUtf16Safe(text, maxChars), fallback: true }
  }
  return { text: '', fallback: true }
}

/**
 * 选这篇稿子要推送/预览的封面图：
 * 优先用户「设为当前封面」选中的 article.cover，没有再回退到最新一批非空 coverRuns 的最后一张；都没有返回 null。
 */
export function latestCover(article) {
  if (article?.cover?.id) return { id: article.cover.id, format: article.cover.format ?? 'png' }
  const runs = (article?.coverRuns ?? []).filter(run => run.images?.length)
  if (!runs.length) return null
  const run = runs.at(-1)
  return { id: run.images.at(-1).id, format: run.format ?? 'png' }
}
