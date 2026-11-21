// 稿面首页的纯函数汇总与筛选模型（零外部依赖，便于单测）。

/** 按公众号阅读速度（约 420 字/分钟）估算阅读时长，至少 1 分钟。 */
export function readMinutes(chars) {
  return Math.max(1, Math.round((Number(chars) || 0) / 420))
}

/** 5 项发车体检（正文/标题/质检/封面/横幅）全部完成即视为就绪。 */
export function isDraftReady(draft) {
  const r = draft?.readiness
  return Boolean(r && r.total > 0 && r.done >= r.total)
}

function padIssue(num) {
  return String(Math.max(1, num)).padStart(2, '0')
}

function parseTime(value) {
  if (!value) return Number.NaN
  return Date.parse(value)
}

/**
 * 汇总稿面首页所需的刊号、统计 KPI、下一班排期、精选头版与筛选后的列表。
 * @param {Array<object>} articles
 * @param {{ currentId?: string | null, filter?: 'all' | 'review' | 'ready' | 'archived', query?: string, now?: number }} [options]
 */
export function summarizeDraftHome(articles = [], { currentId = null, filter = 'all', query = '', now = Date.now() } = {}) {
  const list = Array.isArray(articles) ? articles : []
  const activeRaw = list.filter(item => !item.archivedAt)
  const archivedRaw = list
    .filter(item => item.archivedAt)
    .sort((a, b) => String(b.archivedAt).localeCompare(String(a.archivedAt)))

  const active = activeRaw.map((item, idx) => ({
    ...item,
    issueNo: padIssue(activeRaw.length - idx),
  }))
  const archived = archivedRaw.map((item, idx) => ({
    ...item,
    issueNo: padIssue(archivedRaw.length - idx),
  }))

  const readyItems = active.filter(item => !item.publishedAt && isDraftReady(item))
  const reviewItems = active.filter(item => (item.review ?? 0) > 0)
  const scheduledItems = active
    .filter(item => !item.publishedAt && Number.isFinite(parseTime(item.scheduledFor)))
    .map(item => ({ draft: item, at: parseTime(item.scheduledFor) }))
    .sort((a, b) => a.at - b.at)

  const upcoming = scheduledItems.find(entry => entry.at >= now)
  const nextScheduled = upcoming
    ? { draft: upcoming.draft, at: upcoming.at, overdue: false }
    : scheduledItems.length
      ? { draft: scheduledItems.at(-1).draft, at: scheduledItems.at(-1).at, overdue: true }
      : null

  const featured = active.find(item => item.id === currentId) ?? active[0] ?? null

  const base = filter === 'archived'
    ? archived
    : filter === 'review'
      ? reviewItems
      : filter === 'ready'
        ? readyItems
        : active

  const terms = String(query ?? '').normalize('NFKC').trim().toLowerCase().split(/\s+/).filter(Boolean)
  const hasQuery = terms.length > 0
  const items = hasQuery
    ? base.filter(draft => {
      const normalized = String(draft.title ?? '').normalize('NFKC').toLowerCase()
      return terms.every(term => normalized.includes(term))
    })
    : base

  return {
    stats: {
      activeCount: active.length,
      archivedCount: archived.length,
      readyCount: readyItems.length,
      reviewCount: reviewItems.length,
      scheduledCount: scheduledItems.length,
    },
    filterCounts: {
      all: active.length,
      review: reviewItems.length,
      ready: readyItems.length,
      archived: archived.length,
    },
    nextScheduled,
    featured,
    items,
    hasQuery,
  }
}
