import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildFeedCardModel, FEED_PREVIEW_WIDTHS, MAX_FEED_TITLE_CHARS } from '../client/feed-preview-model.js'

const SAMPLE_IMG = 'https://example.com/a.png'

test('完整稿件返回正确的账号名、头像、封面、字数与摘要', () => {
  const model = buildFeedCardModel({
    article: {
      id: 'art-1',
      title: '一份源码盖成一座城：实测代码可视化',
      summary: '用一套实测流程拆解代码仓库可视化。',
      cover: { id: 'cov-1', format: 'png' },
      blocks: [{ kind: 'para', text: '正文第一段' }],
    },
    brand: { author: '备用品牌名' },
    mp: { name: '测试公众号', headImg: SAMPLE_IMG },
  })
  assert.equal(MAX_FEED_TITLE_CHARS, 32)
  assert.deepEqual(FEED_PREVIEW_WIDTHS.map(w => w.width), [375, 414])
  assert.equal(model.accountName, '测试公众号')
  assert.equal(model.avatarText, '测')
  assert.equal(model.avatarUrl, SAMPLE_IMG)
  assert.equal(model.titleEmpty, false)
  assert.equal(model.titleChars, 17)
  assert.equal(model.titleOverLimit, false)
  assert.equal(model.summary, '用一套实测流程拆解代码仓库可视化。')
  assert.equal(model.summaryFallback, false)
  assert.equal(model.coverUrl, 'wechat-studio/cover/image?id=art-1&asset=cov-1')
})

test('账号名按 mp.name → brand.author → 公众号 回退，emoji 首字不拆代理对', () => {
  const fromBrand = buildFeedCardModel({
    article: { id: 'a1', title: '标题', blocks: [] },
    brand: { author: '🚀火箭笔记' },
    mp: { name: '   ', headImg: '' },
  })
  assert.equal(fromBrand.accountName, '🚀火箭笔记')
  assert.equal(fromBrand.avatarText, '🚀')

  const fallback = buildFeedCardModel({
    article: { id: 'a2', title: '标题', blocks: [] },
    brand: { author: '' },
    mp: null,
  })
  assert.equal(fallback.accountName, '公众号')
  assert.equal(fallback.avatarText, '公')
})

test('无摘要时与 deriveDigest 一致跳过非正文块，无正文段返回空串', () => {
  const withPara = buildFeedCardModel({
    article: {
      id: 'a3',
      title: '标题',
      summary: '',
      blocks: [
        { kind: 'heading', text: '## 小节' },
        { kind: 'media', text: `![图](${SAMPLE_IMG})` },
        { kind: 'code', text: '```js\n1+1\n```' },
        { kind: 'para', text: '第一段 **加粗** 正文。' },
      ],
    },
  })
  assert.equal(withPara.summary, '第一段 加粗 正文。')
  assert.equal(withPara.summaryFallback, true)

  const noPara = buildFeedCardModel({
    article: { id: 'a4', title: '标题', summary: ' ', blocks: [{ kind: 'heading', text: '## 仅标题' }] },
  })
  assert.equal(noPara.summary, '')
  assert.equal(noPara.summaryFallback, true)
})

test('标题为空、32/33/64/65 字边界返回准确两档状态', () => {
  const empty = buildFeedCardModel({ article: { id: 'a5', title: '   ', blocks: [] } })
  assert.equal(empty.titleEmpty, true)
  assert.equal(empty.titleChars, 0)
  assert.equal(empty.titleOverDraftLimit, false)
  assert.equal(empty.titleOverMpLimit, false)

  const exact32 = buildFeedCardModel({ article: { id: 'a6', title: '字'.repeat(32), blocks: [] } })
  assert.equal(exact32.titleChars, 32)
  assert.equal(exact32.titleOverDraftLimit, false)
  assert.equal(exact32.titleOverMpLimit, false)

  const overDraft33 = buildFeedCardModel({ article: { id: 'a7', title: '字'.repeat(33), blocks: [] } })
  assert.equal(overDraft33.titleChars, 33)
  assert.equal(overDraft33.titleOverDraftLimit, true)
  assert.equal(overDraft33.titleOverMpLimit, false)

  const exact64 = buildFeedCardModel({ article: { id: 'a7b', title: '字'.repeat(64), blocks: [] } })
  assert.equal(exact64.titleChars, 64)
  assert.equal(exact64.titleOverDraftLimit, true)
  assert.equal(exact64.titleOverMpLimit, false)

  const overMp65 = buildFeedCardModel({ article: { id: 'a7c', title: '字'.repeat(65), blocks: [] } })
  assert.equal(overMp65.titleChars, 65)
  assert.equal(overMp65.titleOverDraftLimit, true)
  assert.equal(overMp65.titleOverMpLimit, true)

  // 与 preflight / pushWechatDraft 一致按 UTF-16 码元计数：17 个 🚀 = 34 码元，触发 32 字草稿箱上限提醒
  const emoji17 = buildFeedCardModel({ article: { id: 'a7d', title: '🚀'.repeat(17), blocks: [] } })
  assert.equal(emoji17.titleChars, 34)
  assert.equal(emoji17.titleOverDraftLimit, true)
  assert.equal(emoji17.titleOverMpLimit, false)
})

test('头像仅接受合法 http(s) 且不读取 portraitUrl', () => {
  const bad = buildFeedCardModel({
    article: { id: 'a8', title: '标题', blocks: [] },
    mp: { name: '号', headImg: 'ftp://example.com/a.png' },
    portraitUrl: SAMPLE_IMG,
  })
  assert.equal(bad.avatarUrl, null)

  const authUrl = new URL(SAMPLE_IMG)
  authUrl.username = 'demo'
  const withAuth = buildFeedCardModel({
    article: { id: 'a9', title: '标题', blocks: [] },
    mp: { name: '号', headImg: authUrl.href },
  })
  assert.equal(withAuth.avatarUrl, null)
})

test('无 article.cover 时回退到 coverRuns 最新非空批次最后一张，与 latestCover 一致', () => {
  const fallbackCover = buildFeedCardModel({
    article: {
      id: 'a10',
      title: '标题',
      cover: null,
      coverRuns: [
        { images: [{ id: 'old-1' }], format: 'png' },
        { images: [{ id: 'mid-1' }, { id: 'latest-2' }], format: 'jpeg' },
        { images: [], format: 'png' },
      ],
      blocks: [],
    },
  })
  assert.equal(fallbackCover.coverUrl, 'wechat-studio/cover/image?id=a10&asset=latest-2')

  const none = buildFeedCardModel({
    article: { id: 'a11', title: '标题', cover: null, coverRuns: [{ images: [] }], blocks: [] },
  })
  assert.equal(none.coverUrl, null)
})
