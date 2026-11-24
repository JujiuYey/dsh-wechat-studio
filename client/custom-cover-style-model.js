// 自定义封面风格向导纯状态机模型（浏览器安全，供 React 组件与 node:test 共享）。

export const DEFAULT_TEST_COVER_TITLE = '我用 AI 搭了一套自动化写作流'

export function canUseStyleReference(draft) {
  if (!draft || draft.usePortrait) return false
  const refCount = Array.isArray(draft.referenceImages) ? draft.referenceImages.length : 0
  if (refCount > 1) return false
  return refCount === 1 || Boolean(draft.hasStyleReference)
}

export function createWizardDraft(initial = {}) {
  const src = initial && typeof initial === 'object' ? initial : {}
  const usePortrait = Boolean(src.usePortrait)
  const referenceImages = Array.isArray(src.referenceImages) ? [...src.referenceImages] : []
  return {
    id: typeof src.id === 'string' ? src.id : '',
    name: typeof src.name === 'string' ? src.name : '',
    description: typeof src.description === 'string' ? src.description : '',
    usePortrait,
    useStyleReference: !usePortrait && referenceImages.length <= 1 && Boolean(src.useStyleReference),
    hasStyleReference: Boolean(src.hasStyleReference),
    userRequirement: typeof src.userRequirement === 'string' ? src.userRequirement : '',
    template: typeof src.template === 'string' ? src.template : '',
    guidance: typeof src.guidance === 'string' ? src.guidance : '',
    referenceImages,
    previewUrl: typeof src.previewUrl === 'string' ? src.previewUrl : null,
    previewDraftToken: typeof src.previewDraftToken === 'string' ? src.previewDraftToken : null,
    previewStale: Boolean(src.previewStale),
    lastTestPrompt: typeof src.lastTestPrompt === 'string' ? src.lastTestPrompt : '',
  }
}

function sameStringArray(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export function isWizardDirty(initial, current) {
  if (!initial || !current) return false
  if (initial.name !== current.name) return true
  if (initial.description !== current.description) return true
  if (Boolean(initial.usePortrait) !== Boolean(current.usePortrait)) return true
  if (Boolean(initial.useStyleReference) !== Boolean(current.useStyleReference)) return true
  if (initial.userRequirement !== current.userRequirement) return true
  if (initial.template !== current.template) return true
  if (initial.guidance !== current.guidance) return true
  if ((initial.previewDraftToken ?? null) !== (current.previewDraftToken ?? null)) return true
  if (!sameStringArray(initial.referenceImages ?? [], current.referenceImages ?? [])) return true
  return false
}

export function markPreviewStaleOnDraftChange(prev, next) {
  const hasPreview = Boolean(prev?.previewUrl || next?.previewUrl || prev?.previewDraftToken || next?.previewDraftToken)
  if (!hasPreview) return false
  if (prev?.template !== next?.template) return true
  if (prev?.guidance !== next?.guidance) return true
  if (Boolean(prev?.usePortrait) !== Boolean(next?.usePortrait)) return true
  if (Boolean(prev?.useStyleReference) !== Boolean(next?.useStyleReference)) return true
  if (!sameStringArray(prev?.referenceImages ?? [], next?.referenceImages ?? [])) return true
  return false
}

export function applyTestJobToDraft(current, job, expectedJobId = null) {
  if (!current || !job || job.status !== 'succeeded' || !job.result?.draftToken) return current
  if (expectedJobId !== null && job.jobId !== expectedJobId) return current
  return {
    ...current,
    previewDraftToken: job.result.draftToken,
    previewUrl: job.result.previewUrl ?? current.previewUrl,
    previewStale: false,
    lastTestPrompt: typeof job.result.prompt === 'string' ? job.result.prompt : current.lastTestPrompt,
  }
}

export function buildRefinePayload(current, adjustment) {
  return {
    referenceImages: Array.isArray(current?.referenceImages) ? [...current.referenceImages] : [],
    requirement: typeof current?.userRequirement === 'string' ? current.userRequirement.trim() : '',
    adjustment: typeof adjustment === 'string' ? adjustment.trim() : '',
    draft: {
      name: typeof current?.name === 'string' ? current.name.trim() : '',
      description: typeof current?.description === 'string' ? current.description.trim() : '',
      usePortrait: Boolean(current?.usePortrait),
      template: typeof current?.template === 'string' ? current.template : '',
      guidance: typeof current?.guidance === 'string' ? current.guidance : '',
    },
  }
}

export function buildSavePayload(current, mode = 'create') {
  const usePortrait = Boolean(current?.usePortrait)
  const useStyleReference = canUseStyleReference(current) && Boolean(current?.useStyleReference)
  const payload = {
    name: typeof current?.name === 'string' ? current.name.trim() : '',
    description: typeof current?.description === 'string' ? current.description.trim() : '',
    usePortrait,
    useStyleReference,
    userRequirement: typeof current?.userRequirement === 'string' ? current.userRequirement.trim() : '',
    template: typeof current?.template === 'string' ? current.template : '',
    guidance: typeof current?.guidance === 'string' ? current.guidance : '',
  }
  if (mode === 'edit' && current?.id) {
    payload.id = current.id
  }
  if (Array.isArray(current?.referenceImages) && current.referenceImages.length === 1 && !usePortrait) {
    payload.styleReferenceImage = current.referenceImages[0]
  }
  if (current?.previewDraftToken) {
    payload.previewDraftToken = current.previewDraftToken
  } else if (Array.isArray(current?.referenceImages) && current.referenceImages.length > 0) {
    payload.fallbackReferenceImage = current.referenceImages[0]
  }
  return payload
}
