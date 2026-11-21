import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isDraftReady, readMinutes, summarizeDraftHome } from '../client/draft-home-model.js'

const makeReadiness = doneCount => ({
  done: doneCount,
  total: 5,
  items: ['正文', '标题', '质检', '封面', '横幅'].map((label, i) => ({ id: String(i), label, done: i < doneCount })),
})

test('readMinutes 与 isDraftReady 计算边界', () => {
  assert.equal(readMinutes(0), 1)
  assert.equal(readMinutes(420), 1)
  assert.equal(readMinutes(2158), 5)
  assert.equal(isDraftReady({ readiness: makeReadiness(5) }), true)
  assert.equal(isDraftReady({ readiness: makeReadiness(4) }), false)
  assert.equal(isDraftReady({}), false)
})

test('summarizeDraftHome 准确统计 KPI、刊号、精选稿与下一班排期', () => {
  const now = Date.parse('2026-11-21T10:00:00Z')
  const articles = [
    { id: 'a1', title: '最新稿', updatedAt: '2026-11-21T09:00:00Z', chars: 2000, review: 0, readiness: makeReadiness(5), scheduledFor: '2026-11-23T12:00:00Z' },
    { id: 'a2', title: '待质检稿', updatedAt: '2026-11-21T08:00:00Z', chars: 1800, review: 6, readiness: makeReadiness(3), scheduledFor: '2026-11-22T08:00:00Z' },
    { id: 'a3', title: '已发稿', updatedAt: '2026-11-20T08:00:00Z', chars: 1500, review: 0, readiness: makeReadiness(5), publishedAt: '2026-11-20T12:00:00Z', scheduledFor: '2026-11-20T12:00:00Z' },
    { id: 'a4', title: '归档旧稿', updatedAt: '2026-11-18T08:00:00Z', archivedAt: '2026-11-19T08:00:00Z', chars: 900, review: 0, readiness: makeReadiness(2) },
  ]
  const res = summarizeDraftHome(articles, { currentId: 'a2', now })
  assert.deepEqual(res.stats, {
    activeCount: 3,
    archivedCount: 1,
    readyCount: 1, // a3 已发表不计入待发就绪
    reviewCount: 1,
    scheduledCount: 2, // a1 与 a2，不含已发表的 a3
  })
  assert.equal(res.featured.id, 'a2')
  assert.equal(res.featured.issueNo, '02')
  assert.equal(res.items[0].issueNo, '03')
  assert.equal(res.nextScheduled.draft.id, 'a2')
  assert.equal(res.nextScheduled.overdue, false)
})

test('summarizeDraftHome 支持筛选标签、NFKC 搜索与过点排期回退', () => {
  const now = Date.parse('2026-11-25T10:00:00Z')
  const articles = [
    { id: 'a1', title: 'ＤＳＨ 插件实测', updatedAt: '2026-11-21T09:00:00Z', chars: 2000, review: 3, readiness: makeReadiness(3), scheduledFor: '2026-11-22T08:00:00Z' },
    { id: 'a2', title: '纯技术复盘', updatedAt: '2026-11-21T08:00:00Z', chars: 1500, review: 0, readiness: makeReadiness(5) },
    { id: 'a3', title: '归档 1', updatedAt: '2026-11-18T08:00:00Z', archivedAt: '2026-11-19T08:00:00Z', chars: 500, review: 0, readiness: makeReadiness(2) },
    { id: 'a4', title: '归档 2', updatedAt: '2026-11-17T08:00:00Z', archivedAt: '2026-11-20T08:00:00Z', chars: 600, review: 0, readiness: makeReadiness(2) },
  ]
  const byReview = summarizeDraftHome(articles, { filter: 'review', now })
  assert.deepEqual(byReview.items.map(x => x.id), ['a1'])
  assert.equal(byReview.nextScheduled.draft.id, 'a1')
  assert.equal(byReview.nextScheduled.overdue, true)

  const byReady = summarizeDraftHome(articles, { filter: 'ready', now })
  assert.deepEqual(byReady.items.map(x => x.id), ['a2'])

  const byArchived = summarizeDraftHome(articles, { filter: 'archived', now })
  assert.deepEqual(byArchived.items.map(x => x.id), ['a4', 'a3'])

  const bySearch = summarizeDraftHome(articles, { filter: 'all', query: 'dsh 实测', now })
  assert.equal(bySearch.hasQuery, true)
  assert.deepEqual(bySearch.items.map(x => x.id), ['a1'])
})
