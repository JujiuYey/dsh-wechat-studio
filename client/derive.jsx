import React from 'react'
import {
  DERIVE_LIMITS,
  charCount,
  threadClipboardText,
  weightedLength,
  xhsClipboardText,
} from '../src/derive-shared.js'
import {
  buildMarkdownRefreshKey,
  canExportMarkdown,
  deriveDraftKey,
  recordVersion,
  resolveThreadEditorState,
  resolveXhsEditorState,
  shouldConfirmDeriveAction,
  summarizeCardPreviews,
} from './derive-draft-model.js'
import {
  clearDeriveDraft,
  copyText,
  deleteDerivative,
  downloadBlob,
  generateDerivative,
  loadPortableMarkdown,
  saveDerivative,
  setDeriveDraft,
  toast,
  useStudio,
} from './state.js'
import { renderCardToBlob, renderCardToDataUrl } from './xhs-card-render.js'
import { createZip } from './zip.js'

const SUB_TABS = [
  { id: 'markdown', label: '通用 Markdown' },
  { id: 'thread', label: '串推（即刻 / X）' },
  { id: 'xhs', label: '小红书图文' },
]

const MD_TARGETS = [
  { id: 'blog', label: '通用博客 / Obsidian' },
  { id: 'zhihu', label: '知乎' },
  { id: 'juejin', label: '掘金' },
]

const THREAD_VARIANTS = [
  { id: 'jike', label: '即刻' },
  { id: 'x', label: 'X (Twitter)' },
]

const CARD_KIND_LABELS = {
  cover: '封面',
  quote: '金句',
  list: '清单',
  end: '尾页',
}

const DEFAULT_PALETTE = {
  main: '#C9643E',
  soft: '#FCF6F2',
  tint: '#F7E3D5',
  line: '#DAB196',
  mark: '#FCE7A6',
}

function safeFileBase(title) {
  return String(title || '未命名').replace(/[\\/:*?"<>|\r\n]+/g, '-').trim().slice(0, 60) || '未命名'
}

function MarkdownPanel({ article }) {
  const settingsFixedLines = useStudio(s => s.settings?.fixedLines)
  const stateFixedLines = useStudio(s => s.data?.fixedLines)
  const fixedLines = settingsFixedLines ?? stateFixedLines ?? []

  const [target, setTarget] = React.useState('blog')
  const [result, setResult] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(null)
  const [retryNonce, setRetryNonce] = React.useState(0)

  const refreshKey = React.useMemo(
    () => buildMarkdownRefreshKey({ article, target, fixedLines }),
    [article, target, fixedLines],
  )

  React.useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    setResult(null)
    loadPortableMarkdown(article.id, target, controller.signal)
      .then(res => {
        if (cancelled) return
        setResult(res)
        setLoading(false)
      })
      .catch(err => {
        if (cancelled || err.name === 'AbortError') return
        setResult(null)
        setError(err.message || '导出通用 Markdown 失败')
        setLoading(false)
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [article.id, target, refreshKey, retryNonce])

  const exportable = canExportMarkdown({ loading, error, result })

  const exportFile = () => {
    if (!exportable) return
    const blob = new Blob([result.markdown], { type: 'text/markdown;charset=utf-8' })
    downloadBlob(blob, `${safeFileBase(result.title || article.title)}-${target}.md`)
    toast('已开始下载 Markdown')
  }

  return (
    <section className="ws-derive-section" aria-label="通用 Markdown 导出">
      <div className="ws-derive-bar">
        <div className="ws-chips" role="group" aria-label="目标平台">
          {MD_TARGETS.map(item => (
            <button key={item.id} type="button" className={target === item.id ? 'is-on' : ''} onClick={() => setTarget(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
        <span className="ws-grow" />
        <button type="button" className="ws-btn" disabled={!exportable} onClick={() => copyText(result.markdown, '已复制通用 Markdown')}>
          复制 Markdown
        </button>
        <button type="button" className="ws-btn is-primary" disabled={!exportable} onClick={exportFile}>
          下载 .md
        </button>
      </div>

      <p className="ws-muted ws-small">
        确定性实时转换，不调用模型：自动剔除固定引导语、公众号高亮/下划线与动画卡围栏（转为可读清单或表格）。
        {target === 'zhihu' ? ' 知乎模式不在正文重复输出一级标题，请粘贴标题到知乎标题栏。' : ''}
      </p>

      {error ? (
        <div className="ws-banner is-error" role="status">
          <span>{error}</span>
          <button type="button" className="ws-btn" onClick={() => setRetryNonce(n => n + 1)}>重试</button>
        </div>
      ) : null}

      {result?.warnings?.length ? (
        <div className="ws-derive-warnings" role="status">
          <strong>导出提醒</strong>
          <ul>
            {result.warnings.map(w => <li key={w}>{w}</li>)}
          </ul>
        </div>
      ) : null}

      {loading ? (
        <div className="ws-derive-empty"><span className="ws-shimmer">正在转换 Markdown…</span></div>
      ) : error ? null : result?.markdown ? (
        <textarea className="ws-derive-md-preview" readOnly value={result.markdown} aria-label="通用 Markdown 预览" />
      ) : (
        <div className="ws-derive-empty"><p className="ws-muted">正文为空，没有可导出的内容。</p></div>
      )}
    </section>
  )
}

function ThreadPanel({ article, pending, onGenerate, onDelete }) {
  const deriveDrafts = useStudio(s => s.deriveDrafts)
  const record = article.derivatives?.find(item => item.platform === 'thread') ?? null
  const draftEntry = deriveDrafts[deriveDraftKey(article.id, 'thread')] ?? null
  const { variant: draftVariant, posts, dirty, baseChanged } = resolveThreadEditorState(record, draftEntry)

  const [targetVariant, setTargetVariant] = React.useState(record?.variant ?? 'jike')
  const versionKey = `${article.id}:${recordVersion(record)}`
  React.useEffect(() => {
    setTargetVariant(record?.variant ?? 'jike')
  }, [versionKey])

  const busy = pending === 'derive/thread' || pending === 'derive/update' || pending === 'derive/delete'
  const archived = Boolean(article.archivedAt)
  const displayVariant = record?.variant ?? draftVariant ?? targetVariant
  const maxLen = displayVariant === 'x' ? DERIVE_LIMITS.thread.x.maxWeighted : DERIVE_LIMITS.thread.jike.maxChars
  const countFn = displayVariant === 'x' ? weightedLength : charCount
  const unitLabel = displayVariant === 'x' ? '加权字' : '字'

  const writeDraftPosts = nextPosts => {
    setDeriveDraft(article.id, 'thread', {
      baseVersion: recordVersion(record),
      variant: record?.variant ?? 'jike',
      payload: { posts: nextPosts },
    })
  }

  const updatePost = (index, text) => {
    writeDraftPosts(posts.map((item, i) => (i === index ? { ...item, text } : item)))
  }

  const addPostAfter = index => {
    if (posts.length >= DERIVE_LIMITS.thread.maxPosts) return
    const next = posts.map(item => ({ ...item }))
    next.splice(index + 1, 0, { text: '', source: [] })
    writeDraftPosts(next)
  }

  const removePost = index => {
    if (posts.length <= DERIVE_LIMITS.thread.minPosts) return
    writeDraftPosts(posts.filter((_, i) => i !== index))
  }

  const handleSave = async () => {
    const ok = await saveDerivative({ id: article.id, platform: 'thread', payload: { posts } })
    if (ok) toast('已保存串推修改')
  }

  return (
    <section className="ws-derive-section" aria-label="串推派生">
      <div className="ws-derive-bar">
        <div className="ws-chips" role="group" aria-label="串推平台">
          {THREAD_VARIANTS.map(item => (
            <button
              key={item.id}
              type="button"
              className={targetVariant === item.id ? 'is-on' : ''}
              disabled={busy}
              onClick={() => setTargetVariant(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <span className="ws-grow" />
        {record ? (
          <>
            <button type="button" className="ws-btn" disabled={busy || !posts.length} onClick={() => copyText(threadClipboardText(posts), '已复制全部串推（带编号）')}>
              复制全部（带 1/n）
            </button>
            {dirty ? (
              <button type="button" className="ws-btn" disabled={busy} onClick={() => clearDeriveDraft(article.id, 'thread')}>
                放弃修改
              </button>
            ) : null}
            <button type="button" className="ws-btn" disabled={busy || archived || !dirty} onClick={handleSave}>
              保存修改
            </button>
            <button type="button" className="ws-btn is-primary" disabled={busy || archived} onClick={() => onGenerate('thread', targetVariant, { dirty, record })}>
              {pending === 'derive/thread' ? '正在派生…（约 30–90 秒）' : targetVariant !== record.variant ? `按 ${THREAD_VARIANTS.find(v => v.id === targetVariant)?.label} 生成` : '重新生成'}
            </button>
            <button type="button" className="ws-btn" disabled={busy || archived} onClick={() => onDelete('thread', { dirty, record })}>
              删除
            </button>
          </>
        ) : null}
      </div>

      {archived ? <div className="ws-banner is-error"><span>归档稿件不能生成或修改派生，请先恢复。</span></div> : null}

      {dirty && baseChanged ? (
        <div className="ws-banner ws-derive-stale" role="status">
          <span>后台串推版本已更新，当前保留着你的未保存草稿。你可以保存覆盖，或放弃本地修改。</span>
          <button type="button" className="ws-btn" disabled={busy} onClick={() => clearDeriveDraft(article.id, 'thread')}>
            放弃本地修改
          </button>
        </div>
      ) : null}

      {record?.stale ? (
        <div className="ws-banner ws-derive-stale" role="status">
          <span>母稿已修改，这份串推可能已过期。</span>
          <button type="button" className="ws-btn" disabled={busy || archived} onClick={() => onGenerate('thread', targetVariant, { dirty, record })}>
            按最新母稿重新生成
          </button>
        </div>
      ) : null}

      {record?.warnings?.length ? (
        <div className="ws-derive-warnings" role="status">
          <strong>质量与事实提醒</strong>
          <ul>
            {record.warnings.map(w => <li key={w}>{w}</li>)}
          </ul>
        </div>
      ) : null}

      {!record ? (
        <div className="ws-derive-empty">
          <p className="ws-muted">从已打磨好的母稿中挑选核心观点，按 {targetVariant === 'x' ? 'X (Twitter) 270 加权字符' : '即刻短动态'} 拆分为 3–15 条可独立阅读的串推。</p>
          <button type="button" className="ws-btn is-primary" disabled={busy || archived} onClick={() => onGenerate('thread', targetVariant, { dirty: false, record: null })}>
            {pending === 'derive/thread' ? '正在派生…（约 30–90 秒）' : '生成串推'}
          </button>
        </div>
      ) : (
        <div className="ws-derive-thread-list">
          {posts.map((post, index) => {
            const count = countFn(post.text)
            const over = count > maxLen
            return (
              <div className="ws-derive-post" key={`${index}-${post.source?.join(',') ?? ''}`}>
                <div className="ws-derive-post-head">
                  <strong>第 {index + 1} / {posts.length} 条</strong>
                  <span className={`ws-derive-count ${over ? 'is-over' : ''}`}>
                    {count} / {maxLen} {unitLabel}
                  </span>
                  <span className="ws-grow" />
                  <button type="button" className="ws-link" onClick={() => copyText(post.text, `已复制第 ${index + 1} 条`)}>复制本条</button>
                  {posts.length < DERIVE_LIMITS.thread.maxPosts ? (
                    <button type="button" className="ws-link" onClick={() => addPostAfter(index)}>+ 下方加一条</button>
                  ) : null}
                  {posts.length > DERIVE_LIMITS.thread.minPosts ? (
                    <button type="button" className="ws-link" onClick={() => removePost(index)}>删除</button>
                  ) : null}
                </div>
                <textarea
                  rows={3}
                  value={post.text}
                  onChange={event => updatePost(index, event.target.value)}
                  aria-label={`第 ${index + 1} 条串推`}
                />
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function XhsPanel({ article, brand, pending, onGenerate, onDelete }) {
  const deriveDrafts = useStudio(s => s.deriveDrafts)
  const record = article.derivatives?.find(item => item.platform === 'xhs') ?? null
  const draftEntry = deriveDrafts[deriveDraftKey(article.id, 'xhs')] ?? null
  const { draft, dirty, baseChanged } = resolveXhsEditorState(record, draftEntry)

  const [selectedIndex, setSelectedIndex] = React.useState(0)
  const [tagInput, setTagInput] = React.useState('')
  const [previewState, setPreviewState] = React.useState({ status: 'idle', items: [], failedCount: 0, error: null })
  const [renderNonce, setRenderNonce] = React.useState(0)
  const [packing, setPacking] = React.useState(false)

  React.useEffect(() => {
    setSelectedIndex(0)
    setTagInput('')
  }, [article.id])

  const palette = article.xhsPalette ?? DEFAULT_PALETTE
  const author = brand?.author || ''

  React.useEffect(() => {
    if (!draft?.cards?.length) {
      setPreviewState({ status: 'idle', items: [], failedCount: 0, error: null })
      return
    }
    let cancelled = false
    const createdUrls = []
    setPreviewState({ status: 'rendering', items: [], failedCount: 0, error: null })

    Promise.allSettled(
      draft.cards.map((card, index) =>
        renderCardToDataUrl(card, { index, total: draft.cards.length, palette, author }),
      ),
    ).then(settled => {
      const summary = summarizeCardPreviews(settled)
      if (cancelled) {
        summary.items.forEach(item => { if (item.status === 'ok' && item.url) URL.revokeObjectURL(item.url) })
        return
      }
      summary.items.forEach(item => { if (item.status === 'ok' && item.url) createdUrls.push(item.url) })
      setPreviewState(summary)
    })

    return () => {
      cancelled = true
      createdUrls.forEach(url => URL.revokeObjectURL(url))
    }
  }, [draft?.cards, palette, author, renderNonce])

  const busy = pending === 'derive/xhs' || pending === 'derive/update' || pending === 'derive/delete' || packing
  const archived = Boolean(article.archivedAt)
  const cards = draft?.cards ?? []
  const safeSelected = Math.min(selectedIndex, Math.max(0, cards.length - 1))
  const selectedCard = cards[safeSelected] ?? null

  const updateDraft = updater => {
    if (!draft) return
    const next = updater(draft)
    setDeriveDraft(article.id, 'xhs', {
      baseVersion: recordVersion(record),
      payload: next,
    })
  }

  const updateCard = (idx, patch) => {
    updateDraft(prev => ({
      ...prev,
      cards: prev.cards.map((card, i) => (i === idx ? { ...card, ...patch } : card)),
    }))
  }

  const addTagsFromInput = () => {
    const tokens = tagInput.split(/[\s,，、#]+/).map(t => t.trim()).filter(Boolean)
    if (!tokens.length) return
    updateDraft(prev => {
      const next = [...prev.tags]
      for (const t of tokens) {
        if (!next.includes(t) && next.length < DERIVE_LIMITS.xhs.tags[1]) next.push(t)
      }
      return { ...prev, tags: next }
    })
    setTagInput('')
  }

  const removeTag = tag => {
    updateDraft(prev => ({ ...prev, tags: prev.tags.filter(t => t !== tag) }))
  }

  const handleSave = async () => {
    if (!draft) return
    const ok = await saveDerivative({ id: article.id, platform: 'xhs', payload: draft })
    if (ok) toast('已保存小红书修改')
  }

  const downloadOneCard = async index => {
    const card = cards[index]
    if (!card) return
    try {
      const { blob } = await renderCardToBlob(card, { index, total: cards.length, palette, author })
      const num = String(index + 1).padStart(2, '0')
      downloadBlob(blob, `${safeFileBase(draft.title || article.title)}-${num}.png`)
    } catch (err) {
      toast(err.message || '导出图片失败', true)
    }
  }

  const downloadAllZip = async () => {
    if (!cards.length) return
    setPacking(true)
    try {
      const base = safeFileBase(draft.title || article.title)
      const files = []
      for (let i = 0; i < cards.length; i++) {
        const { blob } = await renderCardToBlob(cards[i], { index: i, total: cards.length, palette, author })
        const data = new Uint8Array(await blob.arrayBuffer())
        files.push({ name: `${base}-${String(i + 1).padStart(2, '0')}.png`, data })
      }
      const zipBytes = createZip(files)
      downloadBlob(new Blob([zipBytes], { type: 'application/zip' }), `${base}-小红书卡片.zip`)
      toast(`已打包 ${files.length} 张 1080×1440 PNG 卡片`)
    } catch (err) {
      toast(err.message || '打包卡片失败', true)
    } finally {
      setPacking(false)
    }
  }

  const titleCount = charCount(draft?.title ?? '')
  const bodyCount = charCount(draft?.body ?? '')
  const selectedPreview = previewState.items[safeSelected]

  return (
    <section className="ws-derive-section" aria-label="小红书图文派生">
      <div className="ws-derive-bar">
        <span className="ws-muted ws-small">3:4 高密度模板卡片（1080×1440 PNG），配色跟随当前排版主题。</span>
        <span className="ws-grow" />
        {record && draft ? (
          <>
            <button type="button" className="ws-btn" disabled={busy} onClick={() => copyText(xhsClipboardText(draft), '已复制小红书标题、正文与标签')}>
              复制标题+正文+标签
            </button>
            <button type="button" className="ws-btn" disabled={busy} onClick={downloadAllZip}>
              {packing ? '正在打包…' : '下载全部卡片（.zip）'}
            </button>
            {dirty ? (
              <button type="button" className="ws-btn" disabled={busy} onClick={() => clearDeriveDraft(article.id, 'xhs')}>
                放弃修改
              </button>
            ) : null}
            <button type="button" className="ws-btn" disabled={busy || archived || !dirty} onClick={handleSave}>
              保存修改
            </button>
            <button type="button" className="ws-btn is-primary" disabled={busy || archived} onClick={() => onGenerate('xhs', undefined, { dirty, record })}>
              {pending === 'derive/xhs' ? '正在派生…（约 30–90 秒）' : '重新生成'}
            </button>
            <button type="button" className="ws-btn" disabled={busy || archived} onClick={() => onDelete('xhs', { dirty, record })}>
              删除
            </button>
          </>
        ) : null}
      </div>

      {archived ? <div className="ws-banner is-error"><span>归档稿件不能生成或修改派生，请先恢复。</span></div> : null}

      {dirty && baseChanged ? (
        <div className="ws-banner ws-derive-stale" role="status">
          <span>后台小红书内容已更新，当前保留着你的未保存草稿。你可以保存覆盖，或放弃本地修改。</span>
          <button type="button" className="ws-btn" disabled={busy} onClick={() => clearDeriveDraft(article.id, 'xhs')}>
            放弃本地修改
          </button>
        </div>
      ) : null}

      {record?.stale ? (
        <div className="ws-banner ws-derive-stale" role="status">
          <span>母稿已修改，这份小红书笔记可能已过期。</span>
          <button type="button" className="ws-btn" disabled={busy || archived} onClick={() => onGenerate('xhs', undefined, { dirty, record })}>
            按最新母稿重新生成
          </button>
        </div>
      ) : null}

      {record?.warnings?.length ? (
        <div className="ws-derive-warnings" role="status">
          <strong>质量与事实提醒</strong>
          <ul>
            {record.warnings.map(w => <li key={w}>{w}</li>)}
          </ul>
        </div>
      ) : null}

      {previewState.error ? (
        <div className="ws-banner is-error" role="status">
          <span>{previewState.error}</span>
          <button type="button" className="ws-btn" onClick={() => setRenderNonce(n => n + 1)}>重新渲染预览</button>
        </div>
      ) : null}

      {!record || !draft ? (
        <div className="ws-derive-empty">
          <p className="ws-muted">从母稿中提炼 5～8 页高密度金句与清单卡片，并配套 ≤20 字标题、口语化正文与话题标签。</p>
          <button type="button" className="ws-btn is-primary" disabled={busy || archived} onClick={() => onGenerate('xhs', undefined, { dirty: false, record: null })}>
            {pending === 'derive/xhs' ? '正在派生…（约 30–90 秒）' : '生成小红书图文'}
          </button>
        </div>
      ) : (
        <div className="ws-derive-xhs-grid">
          <div className="ws-derive-card-grid" role="list" aria-label="小红书卡片预览">
            {cards.map((card, index) => {
              const preview = previewState.items[index]
              const isSelected = index === safeSelected
              const isOverflow = Boolean(preview?.status === 'ok' && preview.overflow)
              const isFailed = preview?.status === 'error' || previewState.status === 'error'
              return (
                <div key={index} role="listitem" className={`ws-derive-card-tile ${isSelected ? 'is-selected' : ''} ${isOverflow || isFailed ? 'is-overflow' : ''}`}>
                  <button type="button" className="ws-derive-card-thumb" onClick={() => setSelectedIndex(index)} aria-label={`选择第 ${index + 1} 页卡片`}>
                    {preview?.status === 'ok' ? (
                      <img src={preview.url} alt={`第 ${index + 1} 页：${card.heading || card.kind}`} />
                    ) : isFailed ? (
                      <span className="ws-derive-thumb-fail">预览失败</span>
                    ) : (
                      <span className="ws-shimmer">渲染中…</span>
                    )}
                  </button>
                  <div className="ws-derive-card-foot">
                    <span>{index + 1}/{cards.length} · {CARD_KIND_LABELS[card.kind] ?? card.kind}</span>
                    {isOverflow ? <span className="ws-derive-over-badge">文字太多</span> : null}
                    <span className="ws-grow" />
                    {isFailed ? (
                      <button type="button" className="ws-link" onClick={() => setRenderNonce(n => n + 1)}>重试</button>
                    ) : null}
                    <button type="button" className="ws-link" onClick={() => downloadOneCard(index)}>下载 PNG</button>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="ws-derive-xhs-editor">
            {selectedCard ? (
              <fieldset className="ws-group">
                <legend>编辑第 {safeSelected + 1} 页卡片（{CARD_KIND_LABELS[selectedCard.kind] ?? selectedCard.kind}）</legend>
                {selectedPreview?.status === 'ok' && selectedPreview.overflow ? (
                  <p className="ws-warn">文字太多，请删减行数或精简文字，避免超出卡片画布。</p>
                ) : null}
                <label className="ws-field">
                  <span>
                    卡片标题{selectedCard.kind === 'quote' ? '（可选）' : ''}
                    <em className={`ws-derive-count ${charCount(selectedCard.heading) > DERIVE_LIMITS.xhs.heading ? 'is-over' : ''}`}>
                      {charCount(selectedCard.heading)} / {DERIVE_LIMITS.xhs.heading}
                    </em>
                  </span>
                  <input
                    type="text"
                    value={selectedCard.heading}
                    onChange={event => updateCard(safeSelected, { heading: event.target.value })}
                  />
                </label>

                <div className="ws-derive-lines-edit">
                  <div className="ws-derive-lines-head">
                    <span>正文条目（每行 ≤ {DERIVE_LIMITS.xhs[selectedCard.kind]?.lineChars ?? 24} 字）</span>
                    {selectedCard.lines.length < (DERIVE_LIMITS.xhs[selectedCard.kind]?.lines[1] ?? 5) ? (
                      <button
                        type="button"
                        className="ws-link"
                        onClick={() => updateCard(safeSelected, { lines: [...selectedCard.lines, ''] })}
                      >
                        + 加一行
                      </button>
                    ) : null}
                  </div>
                  {selectedCard.lines.map((line, lineIndex) => {
                    const lineMax = DERIVE_LIMITS.xhs[selectedCard.kind]?.lineChars ?? 24
                    const lineLen = charCount(line)
                    return (
                      <div className="ws-derive-line-row" key={lineIndex}>
                        <input
                          type="text"
                          value={line}
                          onChange={event => {
                            const next = selectedCard.lines.map((item, idx) => (idx === lineIndex ? event.target.value : item))
                            updateCard(safeSelected, { lines: next })
                          }}
                        />
                        <span className={`ws-derive-count ${lineLen > lineMax ? 'is-over' : ''}`}>{lineLen}/{lineMax}</span>
                        {selectedCard.lines.length > (DERIVE_LIMITS.xhs[selectedCard.kind]?.lines[0] ?? 0) ? (
                          <button
                            type="button"
                            className="ws-link"
                            onClick={() => updateCard(safeSelected, { lines: selectedCard.lines.filter((_, idx) => idx !== lineIndex) })}
                          >
                            删
                          </button>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              </fieldset>
            ) : null}

            <fieldset className="ws-group">
              <legend>笔记标题、正文与标签</legend>
              <label className="ws-field">
                <span>
                  笔记标题
                  <em className={`ws-derive-count ${titleCount === 0 || titleCount > DERIVE_LIMITS.xhs.title ? 'is-over' : ''}`}>
                    {titleCount} / {DERIVE_LIMITS.xhs.title}
                  </em>
                </span>
                <input
                  type="text"
                  value={draft.title}
                  onChange={event => updateDraft(prev => ({ ...prev, title: event.target.value }))}
                />
              </label>

              <label className="ws-field">
                <span>
                  正文配文
                  <em className={`ws-derive-count ${bodyCount < DERIVE_LIMITS.xhs.body[0] || bodyCount > DERIVE_LIMITS.xhs.body[1] ? 'is-over' : ''}`}>
                    {bodyCount} / {DERIVE_LIMITS.xhs.body[1]}
                  </em>
                </span>
                <textarea
                  rows={6}
                  value={draft.body}
                  onChange={event => updateDraft(prev => ({ ...prev, body: event.target.value }))}
                />
              </label>

              <div className="ws-derive-tags-wrap">
                <div className="ws-derive-lines-head">
                  <span>标签（3–10 个）</span>
                  <span className={`ws-derive-count ${draft.tags.length < 3 || draft.tags.length > 10 ? 'is-over' : ''}`}>
                    {draft.tags.length} / {DERIVE_LIMITS.xhs.tags[1]}
                  </span>
                </div>
                <div className="ws-derive-tag-chips">
                  {draft.tags.map(tag => (
                    <span className="ws-derive-tag" key={tag}>
                      #{tag}
                      <button type="button" aria-label={`移除标签 ${tag}`} onClick={() => removeTag(tag)}>×</button>
                    </span>
                  ))}
                </div>
                <div className="ws-derive-line-row">
                  <input
                    type="text"
                    placeholder="输入标签，空格或逗号分隔后回车添加"
                    value={tagInput}
                    onChange={event => setTagInput(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        addTagsFromInput()
                      }
                    }}
                  />
                  <button type="button" className="ws-btn" onClick={addTagsFromInput}>添加</button>
                </div>
              </div>
            </fieldset>
          </div>
        </div>
      )}
    </section>
  )
}

export function DeriveView({ article, brand }) {
  const pending = useStudio(s => s.pending)
  const deriveDrafts = useStudio(s => s.deriveDrafts)
  const [tab, setTab] = React.useState('markdown')
  const [confirmState, setConfirmState] = React.useState(null)

  const runGenerate = async (platform, variant, confirmOverwrite) => {
    const res = await generateDerivative({ id: article.id, platform, variant, confirmOverwrite })
    if (res.needsConfirm) {
      setConfirmState({ type: 'generate', platform, variant, reason: 'edited' })
    }
  }

  const handleGenerate = async (platform, variant, { dirty = false, record = null } = {}) => {
    const check = shouldConfirmDeriveAction({ action: 'generate', dirty, record })
    if (check.confirm) {
      setConfirmState({ type: 'generate', platform, variant, reason: check.reason })
      return
    }
    await runGenerate(platform, variant, false)
  }

  const handleDelete = async (platform, { dirty = false, record = null } = {}) => {
    const check = shouldConfirmDeriveAction({ action: 'delete', dirty, record })
    if (check.confirm) {
      setConfirmState({ type: 'delete', platform, reason: check.reason })
      return
    }
    await deleteDerivative({ id: article.id, platform })
  }

  const confirmAction = async () => {
    if (!confirmState) return
    const current = confirmState
    setConfirmState(null)
    if (current.type === 'delete') {
      await deleteDerivative({ id: article.id, platform: current.platform })
    } else {
      await runGenerate(current.platform, current.variant, true)
    }
  }

  return (
    <div className="ws-derive">
      <div className="ws-derive-head">
        <div className="ws-tabs" role="tablist" aria-label="派生形态">
          {SUB_TABS.map(item => {
            const hasDraft = item.id !== 'markdown' && Boolean(deriveDrafts[deriveDraftKey(article.id, item.id)])
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                className={tab === item.id ? 'is-on' : ''}
                onClick={() => setTab(item.id)}
              >
                {item.label}
                {hasDraft ? <span className="ws-derive-dirty-tag">未保存</span> : null}
              </button>
            )
          })}
        </div>
        <span className="ws-muted ws-small">母稿 → 派生单向导出，复制或下载后直接发布，不进入排期。</span>
      </div>

      <div className="ws-derive-body">
        {tab === 'markdown' ? <MarkdownPanel article={article} /> : null}
        {tab === 'thread' ? <ThreadPanel article={article} pending={pending} onGenerate={handleGenerate} onDelete={handleDelete} /> : null}
        {tab === 'xhs' ? <XhsPanel article={article} brand={brand} pending={pending} onGenerate={handleGenerate} onDelete={handleDelete} /> : null}
      </div>

      {confirmState ? (
        <div className="ws-scrim" role="presentation" onClick={event => { if (event.target === event.currentTarget) setConfirmState(null) }}>
          <div className="ws-dialog" role="dialog" aria-modal="true" aria-label={confirmState.type === 'delete' ? '确认删除派生' : '确认覆盖修改'}>
            <div className="ws-dialog-head">
              <h2 className="ws-dialog-title">{confirmState.type === 'delete' ? '确认删除派生' : '确认覆盖修改'}</h2>
            </div>
            <p>
              {confirmState.type === 'delete'
                ? (confirmState.reason === 'unsaved'
                  ? '你还有未保存的手改内容，删除后本地修改与这份派生稿都会清空，确定继续吗？'
                  : '这份派生稿你手动改过，删除后无法恢复，确定继续吗？')
                : (confirmState.reason === 'unsaved'
                  ? '你还有未保存的手改内容，重新生成会丢弃当前修改并覆盖，确定继续吗？'
                  : '这份派生稿你手动改过，重新生成会覆盖当前内容，确定继续吗？')}
            </p>
            <div className="ws-dialog-foot">
              <button type="button" className="ws-btn" onClick={() => setConfirmState(null)}>取消</button>
              <button type="button" className="ws-btn is-primary" onClick={confirmAction}>
                {confirmState.type === 'delete' ? '确定删除' : '确定重新生成'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
