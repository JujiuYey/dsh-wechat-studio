// 信息流卡片预览的纯函数数据模型。
// 摘要与封面回退直接复用 src/wechat-meta.js，确保预览与真实草稿推送同源。
import { deriveDigest, latestCover, MAX_MP_TITLE, MAX_TITLE } from '../src/wechat-meta.js'

export const MAX_FEED_TITLE_CHARS = MAX_TITLE
export const MAX_FEED_DRAFT_TITLE_CHARS = MAX_TITLE
export const MAX_FEED_MP_TITLE_CHARS = MAX_MP_TITLE

export const FEED_PREVIEW_WIDTHS = [
  { id: '375', label: '375px · 标准屏', width: 375 },
  { id: '414', label: '414px · 大屏', width: 414 },
]

function safeAvatarUrl(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) return null
  return trimmed
}

/**
 * 组装订阅号信息流大图卡与转发给好友卡片所需的展示字段。
 * 注意：头像只使用公众号独立缓存的 mp.headImg，绝不复用封面生图人物参考图 portraitUrl。
 * @param {{ article?: object, brand?: object, mp?: { name?: string, headImg?: string } | null }} input
 */
export function buildFeedCardModel({ article, brand, mp } = {}) {
  const accountName = String(mp?.name ?? '').trim() || String(brand?.author ?? '').trim() || '公众号'
  const avatarText = Array.from(accountName)[0] ?? '公'
  const avatarUrl = safeAvatarUrl(mp?.headImg)

  const title = String(article?.title ?? '').trim()
  const titleChars = title.length
  const titleEmpty = titleChars === 0
  const titleOverDraftLimit = titleChars > MAX_FEED_DRAFT_TITLE_CHARS
  const titleOverMpLimit = titleChars > MAX_FEED_MP_TITLE_CHARS

  const { text: summary, fallback: summaryFallback } = deriveDigest(article)

  const cover = latestCover(article)
  const coverUrl = article?.id && cover?.id
    ? `wechat-studio/cover/image?${new URLSearchParams({ id: article.id, asset: cover.id })}`
    : null

  return {
    accountName,
    avatarText,
    avatarUrl,
    title,
    titleEmpty,
    titleChars,
    titleOverDraftLimit,
    titleOverMpLimit,
    titleOverLimit: titleOverMpLimit,
    summary,
    summaryFallback,
    coverUrl,
  }
}
