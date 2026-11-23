// 自定义封面风格向导纯状态机模型（浏览器安全，供 React 组件与 node:test 共享）。

export const DEFAULT_TEST_COVER_TITLE = '我用 AI 搭了一套自动化写作流'

export function createWizardDraft(initial = {}) {
  return {
    id: typeof initial.id === 'string' ? initial.id : '',
    name: typeof initial.name === 'string' ? initial.name : '',
    description: typeof initial.description === 'string' ? initial.description : '',
    usePortrait: Boolean(initial.usePortrait),
    userRequirement: typeof initial.userRequirement === 'string' ? initial.userRequirement : '',
    template: typeof initial.template === 'string' ? initial.template : '',
    guidance: typeof initial.guidance === 'string' ? initial.guidance : '',
    referenceImages: Array.isArray(initial.referenceImages) ? [...initial.referenceImages] : [],
    previewUrl: typeof initial.previewUrl === 'string' ? initial.previewUrl : null,
    previewDraftToken: typeof initial.previewDraftToken === 'string' ? initial.previewDraftToken : null,
    previewStale: Boolean(initial.previewStale),
    lastTestPrompt: typeof initial.lastTestPrompt === 'string' ? initial.lastTestPrompt : '',
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
  if (!sameStringArray(prev?.referenceImages ?? [], next?.referenceImages ?? [])) return true
  return false
}

export function applyTestJobToDraft(current, job) {
  if (!current || !job || job.status !== 'succeeded' || !job.result?.draftToken) return current
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
  const payload = {
    name: typeof current?.name === 'string' ? current.name.trim() : '',
    description: typeof current?.description === 'string' ? current.description.trim() : '',
    usePortrait: Boolean(current?.usePortrait),
    userRequirement: typeof current?.userRequirement === 'string' ? current.userRequirement.trim() : '',
    template: typeof current?.template === 'string' ? current.template : '',
    guidance: typeof current?.guidance === 'string' ? current.guidance : '',
  }
  if (mode === 'edit' && current?.id) {
    payload.id = current.id
  }
  if (current?.previewDraftToken) {
    payload.previewDraftToken = current.previewDraftToken
  } else if (Array.isArray(current?.referenceImages) && current.referenceImages.length > 0) {
    payload.fallbackReferenceImage = current.referenceImages[0]
  }
  return payload
}
