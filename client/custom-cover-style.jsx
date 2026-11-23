import React from 'react'
import { COVER_RESOLUTIONS } from '../src/cover-options.js'
import { CUSTOM_COVER_STYLE_LIMITS, extractTemplateSlots, hasPortraitMarkers } from '../src/cover-styles.js'
import {
  applyTestJobToDraft,
  buildRefinePayload,
  buildSavePayload,
  createWizardDraft,
  DEFAULT_TEST_COVER_TITLE,
  isWizardDirty,
  markPreviewStaleOnDraftChange,
} from './custom-cover-style-model.js'
import { compressReferenceImageFile, extractClipboardImageFiles } from './image-input.js'
import {
  analyzeCustomCoverStyle,
  closeCustomCoverStyleWizard,
  deleteCustomCoverStyle,
  loadCoverStyles,
  loadCustomCoverStyle,
  openCustomCoverStyleWizard,
  saveCustomCoverStyle,
  startCustomCoverStyleTest,
  toast,
  updateCustomCoverWizardSession,
  useStudio,
} from './state.js'

const TEST_STAGE_LABEL = {
  prompt: '正在分析测试内容…',
  generating: '正在生成样图…',
  saving: '正在裁切并保存…',
}

function articlePreviewMarkdown(article) {
  if (!article?.blocks?.length) return ''
  return article.blocks.map(b => b.text).filter(Boolean).join('\n\n').slice(0, 1200)
}

export function CustomCoverTestBanner({ returnTo = 'skills' }) {
  const activeJob = useStudio(s => s.coverStyles?.activeTestJob)
  const hasSession = useStudio(s => Boolean(s.customCoverWizard?.draftSession))
  if (!activeJob || (activeJob.status !== 'running' && activeJob.status !== 'succeeded')) return null
  const isRunning = activeJob.status === 'running'
  return (
    <div className={`ws-custom-cover-banner ${isRunning ? 'is-running' : 'is-ready'}`} role="status">
      <span>
        {isRunning
          ? `自定义封面样图正在后台生成（${TEST_STAGE_LABEL[activeJob.stage] ?? '处理中…'}）`
          : '后台试生成的自定义封面样图已就绪'}
      </span>
      <button
        type="button"
        className="ws-link"
        onClick={() => openCustomCoverStyleWizard({ resume: hasSession, mode: 'create', returnTo })}
      >
        {isRunning ? '返回查看' : '继续编辑'}
      </button>
    </div>
  )
}

export function CustomCoverStyleCard() {
  const coverStyles = useStudio(s => s.coverStyles)
  const [deletingId, setDeletingId] = React.useState(null)

  React.useEffect(() => {
    void loadCoverStyles()
  }, [])

  const customList = (coverStyles?.styles ?? []).filter(item => item.source === 'custom')
  const atLimit = customList.length >= CUSTOM_COVER_STYLE_LIMITS.maxStyles

  const onDelete = async item => {
    if (deletingId) return
    if (!window.confirm(`确定删除自定义封面风格「${item.name}」吗？\n删除后不影响已生成的文章封面，但后续无法再用此风格。`)) return
    setDeletingId(item.id)
    try {
      await deleteCustomCoverStyle(item.id)
      toast(`已删除「${item.name}」`)
    } catch (err) {
      toast(err.message, true)
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <section className={`ws-style-card ws-custom-cover-card ${customList.length ? 'is-active' : ''}`} aria-label="自定义封面风格">
      <div className="ws-style-card-head">
        <div>
          <div className="ws-style-card-title-row">
            <h2>自定义封面风格</h2>
            <span className={`ws-skill-src ${customList.length ? 'is-user' : ''}`}>
              {customList.length ? `${customList.length} / ${CUSTOM_COVER_STYLE_LIMITS.maxStyles} 套` : '尚未新建'}
            </span>
          </div>
          <p className="ws-muted">
            上传网上喜欢的封面参考图或写下视觉诉求，AI 拆解为可复用的 21:9 模板并支持现场试图；保存后可在每篇文章的「选择封面风格」中直接复用。
          </p>
        </div>
      </div>

      <CustomCoverTestBanner returnTo="skills" />

      {coverStyles?.error ? (
        <p className="ws-warn ws-small">读取封面风格失败：{coverStyles.error}</p>
      ) : null}

      {coverStyles?.warnings?.length ? (
        <p className="ws-warn ws-small">{coverStyles.warnings.join(' ')}</p>
      ) : null}

      {customList.length ? (
        <div className="ws-custom-cover-grid">
          {customList.map(item => (
            <article className="ws-custom-cover-item" key={item.id}>
              <div className="ws-custom-cover-thumb">
                {item.previewUrl ? (
                  <img src={item.previewUrl} alt={item.name} loading="lazy" />
                ) : (
                  <div className="ws-cover-placeholder-art"><span>{item.name}</span></div>
                )}
                <span className="ws-cover-badge">自定义</span>
              </div>
              <div className="ws-custom-cover-meta">
                <strong>{item.name}</strong>
                <p className="ws-muted ws-small">{item.description}</p>
                <div className="ws-custom-cover-item-foot">
                  <span className="ws-muted ws-small">{item.usePortrait ? '含博主出镜' : '纯视觉/无真人'}</span>
                  <span className="ws-custom-cover-item-actions">
                    <button
                      type="button"
                      className="ws-link"
                      onClick={() => openCustomCoverStyleWizard({ mode: 'edit', styleId: item.id, returnTo: 'skills' })}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="ws-link is-danger"
                      disabled={deletingId === item.id}
                      onClick={() => void onDelete(item)}
                    >
                      {deletingId === item.id ? '删除中…' : '删除'}
                    </button>
                  </span>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : null}

      <div className="ws-style-card-actions">
        <button
          type="button"
          className="ws-btn is-primary"
          disabled={atLimit}
          onClick={() => openCustomCoverStyleWizard({ mode: 'create', returnTo: 'skills' })}
        >
          {atLimit ? `已达 ${CUSTOM_COVER_STYLE_LIMITS.maxStyles} 套上限` : '+ 新建自定义封面风格'}
        </button>
      </div>
    </section>
  )
}

export function CustomCoverStyleWizard() {
  const wizard = useStudio(s => s.customCoverWizard)
  const coverStyles = useStudio(s => s.coverStyles)
  const currentArticle = useStudio(s => s.data?.current)

  const mode = wizard?.mode ?? 'create'
  const styleId = wizard?.styleId ?? null
  const visionSupport = coverStyles?.visionSupport ?? null
  const activeTestJob = coverStyles?.activeTestJob ?? null
  const testRunning = activeTestJob?.status === 'running'

  const [loading, setLoading] = React.useState(mode === 'edit' && !wizard?.draftSession)
  const [step, setStep] = React.useState(() => wizard?.draftSession?.step ?? (mode === 'edit' ? 2 : 1))
  const [initialDraft, setInitialDraft] = React.useState(() => createWizardDraft(wizard?.draftSession?.initialDraft ?? {}))
  const [draft, setDraft] = React.useState(() => createWizardDraft(wizard?.draftSession?.draft ?? {}))
  const [testTitle, setTestTitle] = React.useState(() => wizard?.draftSession?.testTitle || currentArticle?.title?.trim() || DEFAULT_TEST_COVER_TITLE)
  const [resolution, setResolution] = React.useState(() => wizard?.draftSession?.resolution || '1K')
  const [adjustment, setAdjustment] = React.useState('')
  const [busy, setBusy] = React.useState(null) // null | 'analyze' | 'refine' | 'save' | 'compress'
  const [dragOver, setDragOver] = React.useState(false)
  const fileInputRef = React.useRef(null)

  React.useEffect(() => {
    void loadCoverStyles()
  }, [])

  // 编辑模式且无挂起草稿会话时从服务端加载完整风格详情
  React.useEffect(() => {
    if (mode !== 'edit' || !styleId || wizard?.draftSession) return
    let cancelled = false
    setLoading(true)
    loadCustomCoverStyle(styleId)
      .then(full => {
        if (cancelled) return
        const loaded = createWizardDraft(full)
        setInitialDraft(loaded)
        setDraft(loaded)
        setStep(2)
      })
      .catch(err => {
        if (cancelled) return
        toast(err.message, true)
        closeCustomCoverStyleWizard({ preserveSession: false })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [mode, styleId])

  // 当后台试生成任务完成时同步新样图到本地草稿
  React.useEffect(() => {
    if (activeTestJob?.status === 'succeeded' && activeTestJob.result?.draftToken) {
      setDraft(prev => {
        if (prev.previewDraftToken === activeTestJob.result.draftToken) return prev
        return applyTestJobToDraft(prev, activeTestJob)
      })
    }
  }, [activeTestJob?.status, activeTestJob?.result?.draftToken])

  // 同步草稿快照到会话，保证后台试生成期间关闭后仍可恢复
  React.useEffect(() => {
    if (loading) return
    updateCustomCoverWizardSession({
      step,
      initialDraft,
      draft,
      testTitle,
      resolution,
    })
  }, [step, initialDraft, draft, testTitle, resolution, loading])

  const patchDraft = updater => {
    setDraft(prev => {
      const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...updater }
      const stale = markPreviewStaleOnDraftChange(prev, next)
      return stale ? { ...next, previewStale: true } : next
    })
  }

  const dirty = isWizardDirty(initialDraft, draft)
  const slots = extractTemplateSlots(draft.template)
  const hasMarkers = hasPortraitMarkers(draft.template)
  const portraitMismatch = draft.template.trim() && (
    (draft.usePortrait && !hasMarkers) || (!draft.usePortrait && hasMarkers)
  )

  const handleClose = () => {
    if (busy) return
    if (dirty || testRunning) {
      const msg = testRunning
        ? '当前样图仍在后台试生成且草稿尚未保存，确认先关闭弹窗？（后台任务会继续完成，稍后可点「返回查看」恢复）'
        : '当前自定义风格尚未保存，确认放弃修改？'
      if (!window.confirm(msg)) return
    }
    closeCustomCoverStyleWizard({ preserveSession: testRunning })
  }

  React.useEffect(() => {
    const onKey = event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        handleClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const addFiles = async files => {
    const list = Array.from(files ?? []).filter(f => f && f.type?.startsWith('image/'))
    if (!list.length) return
    const remaining = CUSTOM_COVER_STYLE_LIMITS.maxReferenceImages - draft.referenceImages.length
    if (remaining <= 0) {
      toast(`最多上传 ${CUSTOM_COVER_STYLE_LIMITS.maxReferenceImages} 张参考封面图。`, true)
      return
    }
    const picked = list.slice(0, remaining)
    if (list.length > remaining) {
      toast(`已保留前 ${remaining} 张，最多支持 ${CUSTOM_COVER_STYLE_LIMITS.maxReferenceImages} 张参考图。`)
    }
    setBusy('compress')
    try {
      const encoded = []
      for (const file of picked) {
        encoded.push(await compressReferenceImageFile(file))
      }
      patchDraft(prev => ({
        ...prev,
        referenceImages: [...prev.referenceImages, ...encoded.filter(Boolean)].slice(0, CUSTOM_COVER_STYLE_LIMITS.maxReferenceImages),
      }))
    } catch (err) {
      toast(err.message, true)
    } finally {
      setBusy(null)
    }
  }

  const onAnalyze = async event => {
    event.preventDefault()
    if (busy) return
    if (!draft.referenceImages.length && !draft.userRequirement.trim()) {
      toast('请至少上传 1 张参考封面图，或填写风格诉求。', true)
      return
    }
    if (draft.referenceImages.length > 0 && visionSupport === false) {
      toast('当前模型不支持识图，请先在右上角切换支持视觉的模型，或移除参考图仅用文字描述创建。', true)
      return
    }
    setBusy('analyze')
    try {
      const res = await analyzeCustomCoverStyle({
        referenceImages: draft.referenceImages,
        requirement: draft.userRequirement.trim(),
      })
      patchDraft(prev => ({
        ...prev,
        name: res.draft.name,
        description: res.draft.description,
        usePortrait: res.draft.usePortrait,
        template: res.draft.template,
        guidance: res.draft.guidance,
      }))
      setStep(2)
    } catch (err) {
      toast(err.message, true)
    } finally {
      setBusy(null)
    }
  }

  const onRefine = async () => {
    if (busy || !adjustment.trim()) return
    if (draft.referenceImages.length > 0 && visionSupport === false) {
      toast('当前模型不支持识图，请切换视觉模型或移除参考图后再微调。', true)
      return
    }
    setBusy('refine')
    try {
      const res = await analyzeCustomCoverStyle(buildRefinePayload(draft, adjustment))
      patchDraft(prev => ({
        ...prev,
        name: res.draft.name,
        description: res.draft.description,
        usePortrait: res.draft.usePortrait,
        template: res.draft.template,
        guidance: res.draft.guidance,
      }))
      setAdjustment('')
      toast('已按要求微调模板，可重新试生成样图验证效果')
    } catch (err) {
      toast(err.message, true)
    } finally {
      setBusy(null)
    }
  }

  const onTestGenerate = async () => {
    if (busy || testRunning) return
    if (slots.length < CUSTOM_COVER_STYLE_LIMITS.minSlots) {
      toast(`提示词模板至少需要包含 ${CUSTOM_COVER_STYLE_LIMITS.minSlots} 个 {{...}} 占位符。`, true)
      return
    }
    try {
      await startCustomCoverStyleTest({
        draft: {
          name: draft.name,
          template: draft.template,
          guidance: draft.guidance,
          usePortrait: draft.usePortrait,
        },
        testTitle: testTitle.trim() || DEFAULT_TEST_COVER_TITLE,
        testMarkdown: articlePreviewMarkdown(currentArticle),
        resolution,
      })
    } catch (err) {
      toast(err.message, true)
    }
  }

  const onSave = async () => {
    if (busy) return
    if (!draft.name.trim()) { toast('请填写风格名称。', true); return }
    if (!draft.description.trim()) { toast('请填写一句话风格简介。', true); return }
    if (slots.length < CUSTOM_COVER_STYLE_LIMITS.minSlots) {
      toast(`提示词模板至少需要包含 ${CUSTOM_COVER_STYLE_LIMITS.minSlots} 个 {{...}} 占位符。`, true)
      return
    }
    setBusy('save')
    try {
      const saved = await saveCustomCoverStyle(buildSavePayload(draft, mode))
      toast(mode === 'edit' ? `已更新「${saved.style.name}」` : `已保存自定义封面风格「${saved.style.name}」`)
      closeCustomCoverStyleWizard({ preserveSession: false })
    } catch (err) {
      toast(err.message, true)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      className="ws-scrim"
      onMouseDown={event => { if (event.target === event.currentTarget) handleClose() }}
    >
      <section
        className="ws-dialog ws-custom-cover-wizard"
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'edit' ? '编辑自定义封面风格' : '新建自定义封面风格'}
      >
        <div className="ws-dialog-head">
          <div>
            <h2 className="ws-dialog-title">
              {mode === 'edit' ? '编辑自定义封面风格' : '新建自定义封面风格'}
            </h2>
            <p className="ws-muted ws-small">
              {step === 1 ? '第 1 / 2 步 · 上传参考封面图或描述风格诉求' : '第 2 / 2 步 · 试生成样图、微调并保存'}
            </p>
          </div>
          <button type="button" className="ws-icon-btn" disabled={Boolean(busy)} aria-label="关闭" onClick={handleClose}>
            ✕
          </button>
        </div>

        {loading ? (
          <div className="ws-center ws-custom-cover-loading">
            <span className="ws-shimmer">正在读取自定义风格详情…</span>
          </div>
        ) : step === 1 ? (
          <form className="ws-custom-cover-step" onSubmit={onAnalyze} onPaste={e => void addFiles(extractClipboardImageFiles(e))}>
            <div className="ws-custom-cover-section">
              <div className="ws-style-field-head">
                <span>参考封面图（可选，最多 {CUSTOM_COVER_STYLE_LIMITS.maxReferenceImages} 张）</span>
                <small className="ws-muted">支持点击选择、拖拽或 ⌘V 粘贴</small>
              </div>
              {visionSupport === false ? (
                <p className="ws-warn ws-small" role="status">
                  当前文本模型不支持识图，如需模仿参考图请先在右上角切换支持视觉的多模态模型；或移除图片仅用下方文字诉求创建。
                </p>
              ) : null}
              <div
                className={`ws-ref-dropzone ${dragOver ? 'is-over' : ''}`}
                onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={e => {
                  e.preventDefault()
                  setDragOver(false)
                  void addFiles(e.dataTransfer?.files)
                }}
              >
                <div className="ws-ref-thumbs">
                  {draft.referenceImages.map((src, idx) => (
                    <figure className="ws-ref-thumb" key={`${idx}-${src.slice(0, 32)}`}>
                      <img src={src} alt={`参考图 ${idx + 1}`} />
                      <button
                        type="button"
                        aria-label={`移除参考图 ${idx + 1}`}
                        onClick={() => patchDraft(prev => ({
                          ...prev,
                          referenceImages: prev.referenceImages.filter((_, i) => i !== idx),
                        }))}
                      >
                        ×
                      </button>
                    </figure>
                  ))}
                  {draft.referenceImages.length < CUSTOM_COVER_STYLE_LIMITS.maxReferenceImages ? (
                    <button
                      type="button"
                      className="ws-ref-add"
                      disabled={Boolean(busy)}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      {busy === 'compress' ? '压缩中…' : '+ 上传参考图'}
                    </button>
                  ) : null}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  hidden
                  onChange={e => {
                    void addFiles(e.target.files)
                    e.target.value = ''
                  }}
                />
              </div>
            </div>

            <label className="ws-field">
              <span className="ws-style-field-head">
                <span>风格诉求（可选）</span>
                <small className="ws-muted">{draft.userRequirement.length} / {CUSTOM_COVER_STYLE_LIMITS.maxRequirement}</small>
              </span>
              <textarea
                rows={4}
                maxLength={CUSTOM_COVER_STYLE_LIMITS.maxRequirement}
                value={draft.userRequirement}
                placeholder="描述想要的色调、排版构图、大标题字体气质、是否放博主本人、画面禁忌等（例如：黑金科技杂志风、居中特粗宋体大字、不要人物出镜）"
                onChange={e => patchDraft({ userRequirement: e.target.value })}
              />
            </label>

            <div className="ws-dialog-foot">
              {draft.template ? (
                <button type="button" className="ws-btn" disabled={Boolean(busy)} onClick={() => setStep(2)}>返回编辑草稿</button>
              ) : null}
              <button type="button" className="ws-btn" disabled={Boolean(busy)} onClick={handleClose}>取消</button>
              <button
                type="submit"
                className="ws-btn is-primary"
                disabled={Boolean(busy) || (!draft.referenceImages.length && !draft.userRequirement.trim()) || (draft.referenceImages.length > 0 && visionSupport === false)}
              >
                {busy === 'analyze' ? '正在拆解风格…' : 'AI 拆解风格方案'}
              </button>
            </div>
          </form>
        ) : (
          <div className="ws-custom-cover-step ws-custom-cover-step2">
            <div className="ws-custom-cover-columns">
              <div className="ws-custom-cover-left">
                <label className="ws-field">
                  <span className="ws-style-field-head">
                    <span>风格名称</span>
                    <small className="ws-muted">{draft.name.length} / {CUSTOM_COVER_STYLE_LIMITS.maxName}</small>
                  </span>
                  <input
                    type="text"
                    maxLength={CUSTOM_COVER_STYLE_LIMITS.maxName}
                    value={draft.name}
                    placeholder="例如：黑金杂志风"
                    onChange={e => patchDraft({ name: e.target.value })}
                  />
                </label>

                <label className="ws-field">
                  <span className="ws-style-field-head">
                    <span>一句话简介</span>
                    <small className="ws-muted">{draft.description.length} / {CUSTOM_COVER_STYLE_LIMITS.maxDescription}</small>
                  </span>
                  <input
                    type="text"
                    maxLength={CUSTOM_COVER_STYLE_LIMITS.maxDescription}
                    value={draft.description}
                    placeholder="显示在封面风格列表底部，概括画面和适用场景"
                    onChange={e => patchDraft({ description: e.target.value })}
                  />
                </label>

                <label className="ws-check ws-custom-cover-portrait-toggle">
                  <input
                    type="checkbox"
                    checked={draft.usePortrait}
                    onChange={e => patchDraft({ usePortrait: e.target.checked })}
                  />
                  <span>包含博主本人出镜（自动使用「设置 · 封面生成」中的人物参考照与服装设定）</span>
                </label>

                {portraitMismatch ? (
                  <p className="ws-warn ws-small" role="status">
                    {draft.usePortrait
                      ? '当前模板尚未包含 [[SUBJECT]] 或 [[人物]] 占位符，可用下方「AI 微调模板」补入人物构图，或展开高级模板手动添加。'
                      : '当前已关闭博主出镜，但模板中仍含 [[SUBJECT]] / [[人物]] 占位符，建议用「AI 微调模板」移除或展开模板手改。'}
                  </p>
                ) : null}

                <div className="ws-custom-cover-refine">
                  <div className="ws-style-field-head">
                    <span>自然语言微调</span>
                    <small className="ws-muted">基于当前最新编辑内容微调</small>
                  </div>
                  <div className="ws-custom-cover-refine-row">
                    <input
                      type="text"
                      maxLength={CUSTOM_COVER_STYLE_LIMITS.maxRequirement}
                      value={adjustment}
                      placeholder="哪里不像或想改？例如：背景更暖一点、去掉英文小标签、中文大字更粗"
                      onChange={e => setAdjustment(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          void onRefine()
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="ws-btn"
                      disabled={Boolean(busy) || !adjustment.trim()}
                      onClick={() => void onRefine()}
                    >
                      {busy === 'refine' ? '微调中…' : 'AI 微调模板'}
                    </button>
                  </div>
                </div>

                <details className="ws-custom-cover-advanced">
                  <summary>
                    <span>高级：查看 / 编辑提示词模板</span>
                    <small className={slots.length < CUSTOM_COVER_STYLE_LIMITS.minSlots ? 'ws-warn' : 'ws-muted'}>
                      已识别 {slots.length} 个动态槽位
                    </small>
                  </summary>
                  <div className="ws-custom-cover-advanced-body">
                    <label className="ws-field">
                      <span className="ws-style-field-head">
                        <span>提示词模板正文（template.txt）</span>
                        <small className="ws-muted">{draft.template.length} / {CUSTOM_COVER_STYLE_LIMITS.maxTemplate}</small>
                      </span>
                      <textarea
                        rows={8}
                        maxLength={CUSTOM_COVER_STYLE_LIMITS.maxTemplate}
                        value={draft.template}
                        onChange={e => patchDraft({ template: e.target.value })}
                      />
                    </label>
                    {slots.length < CUSTOM_COVER_STYLE_LIMITS.minSlots ? (
                      <p className="ws-warn ws-small">
                        模板至少需要包含 {CUSTOM_COVER_STYLE_LIMITS.minSlots} 个 {'{{...}}'} 占位符（覆盖标题与视觉核心元素）。
                      </p>
                    ) : (
                      <p className="ws-muted ws-small">动态槽位：{slots.join('、')}</p>
                    )}
                    <label className="ws-field">
                      <span className="ws-style-field-head">
                        <span>填空指引（guidance.txt，可选）</span>
                        <small className="ws-muted">{draft.guidance.length} / {CUSTOM_COVER_STYLE_LIMITS.maxGuidance}</small>
                      </span>
                      <textarea
                        rows={3}
                        maxLength={CUSTOM_COVER_STYLE_LIMITS.maxGuidance}
                        value={draft.guidance}
                        onChange={e => patchDraft({ guidance: e.target.value })}
                      />
                    </label>
                  </div>
                </details>
              </div>

              <div className="ws-custom-cover-right">
                <div className="ws-custom-cover-preview-box">
                  <div className="ws-custom-cover-preview-frame">
                    {draft.previewUrl ? (
                      <img src={draft.previewUrl} alt={draft.name || '样图预览'} />
                    ) : (
                      <div className="ws-cover-placeholder-art">
                        <span>{draft.name || '21:9 样例预览'}</span>
                      </div>
                    )}
                    {draft.previewStale ? (
                      <span className="ws-cover-stale-badge" role="status">样图已过期，建议重新试生成</span>
                    ) : null}
                  </div>
                  {testRunning ? (
                    <p className="ws-shimmer ws-small" role="status">
                      {TEST_STAGE_LABEL[activeTestJob.stage] ?? '正在试生成样图…'}
                    </p>
                  ) : null}
                  {activeTestJob?.status === 'failed' && activeTestJob.error ? (
                    <p className="ws-warn ws-small" role="status">{activeTestJob.error}</p>
                  ) : null}
                </div>

                <label className="ws-field">
                  <span>测试标题</span>
                  <input
                    type="text"
                    maxLength={120}
                    value={testTitle}
                    placeholder={DEFAULT_TEST_COVER_TITLE}
                    onChange={e => setTestTitle(e.target.value)}
                  />
                </label>

                <div className="ws-custom-cover-test-bar">
                  <div className="ws-cover-segments" role="radiogroup" aria-label="试生成分辨率">
                    {COVER_RESOLUTIONS.map(res => (
                      <label key={res}>
                        <input
                          type="radio"
                          name="custom-cover-res"
                          value={res}
                          checked={resolution === res}
                          disabled={testRunning || Boolean(busy)}
                          onChange={() => setResolution(res)}
                        />
                        <span>{res}</span>
                      </label>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="ws-btn"
                    disabled={testRunning || Boolean(busy) || slots.length < CUSTOM_COVER_STYLE_LIMITS.minSlots}
                    onClick={() => void onTestGenerate()}
                  >
                    {testRunning ? '正在试生成…' : draft.previewDraftToken ? '重新试生成样图' : '试生成样图'}
                  </button>
                </div>

                <p className="ws-muted ws-small">
                  {draft.previewDraftToken
                    ? '保存后将使用当前试生成的样图作为风格缩略图。'
                    : draft.referenceImages.length > 0
                      ? '可跳过试生成直接保存，将用第 1 张参考图自动裁切为 21:9 缩略图。'
                      : mode === 'edit' && draft.previewUrl
                        ? '未重新试生成时，保存将保留原有预览缩略图。'
                        : '也可跳过试生成直接保存，列表将先展示文字预览卡。'}
                </p>
              </div>
            </div>

            <div className="ws-dialog-foot">
              <button type="button" className="ws-link" disabled={Boolean(busy)} onClick={() => setStep(1)}>
                重新上传参考图重构
              </button>
              <div className="ws-custom-cover-foot-right">
                <button type="button" className="ws-btn" disabled={Boolean(busy)} onClick={handleClose}>取消</button>
                <button
                  type="button"
                  className="ws-btn is-primary"
                  disabled={Boolean(busy) || !draft.name.trim() || !draft.description.trim() || slots.length < CUSTOM_COVER_STYLE_LIMITS.minSlots}
                  onClick={() => void onSave()}
                >
                  {busy === 'save' ? '保存中…' : '保存风格'}
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
