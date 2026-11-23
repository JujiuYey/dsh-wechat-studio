import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  applyTestJobToDraft,
  buildRefinePayload,
  buildSavePayload,
  createWizardDraft,
  isWizardDirty,
  markPreviewStaleOnDraftChange,
} from '../client/custom-cover-style-model.js'

test('custom-cover-style-model.js 保持浏览器安全无 node:* 引用', async () => {
  const source = await readFile(new URL('../client/custom-cover-style-model.js', import.meta.url), 'utf8')
  assert.ok(!/from\s+['"]node:/.test(source))
})

test('isWizardDirty：初始状态为 false，改动任意输入或产生新草稿样图后变为 true', () => {
  const initial = createWizardDraft({
    id: 'custom-11223344',
    name: '黑金杂志风',
    description: '深炭黑底与香槟金大字',
    usePortrait: false,
    userRequirement: '黑金质感',
    template: '21:9 标题 {{主标题}} 视觉 {{视觉}}',
    guidance: '限 10 字',
    previewUrl: 'wechat-studio/cover-styles/preview?id=custom-11223344',
  })
  assert.equal(isWizardDirty(initial, createWizardDraft(initial)), false)
  assert.equal(isWizardDirty(initial, { ...initial, name: '改名' }), true)
  assert.equal(isWizardDirty(initial, { ...initial, usePortrait: true }), true)
  assert.equal(isWizardDirty(initial, { ...initial, userRequirement: '新诉求' }), true)
  assert.equal(isWizardDirty(initial, { ...initial, template: '改模板 {{a}} {{b}}' }), true)
  assert.equal(isWizardDirty(initial, { ...initial, referenceImages: ['data:image/jpeg;base64,AA=='] }), true)
  assert.equal(isWizardDirty(initial, { ...initial, previewDraftToken: '00000000-0000-4000-8000-000000000001' }), true)
})

test('markPreviewStaleOnDraftChange 与 applyTestJobToDraft：改模板/开关/指引/参考图后标过期，新样图清除过期', () => {
  const withPreview = createWizardDraft({
    name: '杂志风',
    template: '21:9 标题 {{主标题}} 视觉 {{视觉}}',
    guidance: '旧指引',
    usePortrait: false,
    previewUrl: 'wechat-studio/cover-styles/preview?id=custom-11223344',
  })
  const noPreview = createWizardDraft({ name: '无图风', template: '21:9 {{a}} {{b}}' })

  // 仅改名称不标过期；无预览图时不标过期
  assert.equal(markPreviewStaleOnDraftChange(withPreview, { ...withPreview, name: '新名' }), false)
  assert.equal(markPreviewStaleOnDraftChange(noPreview, { ...noPreview, template: '21:9 {{c}} {{d}}' }), false)

  // 修改模板、指引、usePortrait、替换参考图时标过期
  assert.equal(markPreviewStaleOnDraftChange(withPreview, { ...withPreview, template: '21:9 {{c}} {{d}}' }), true)
  assert.equal(markPreviewStaleOnDraftChange(withPreview, { ...withPreview, guidance: '新指引' }), true)
  assert.equal(markPreviewStaleOnDraftChange(withPreview, { ...withPreview, usePortrait: true }), true)
  assert.equal(markPreviewStaleOnDraftChange(withPreview, { ...withPreview, referenceImages: ['data:image/jpeg;base64,BB=='] }), true)

  // 收到新试生成 succeeded 结果后清除过期标记并更新 previewDraftToken 与 previewUrl
  const stale = { ...withPreview, previewStale: true }
  const applied = applyTestJobToDraft(stale, {
    jobId: 'job-1',
    status: 'succeeded',
    result: {
      draftToken: '11111111-1111-4111-8111-111111111111',
      previewUrl: 'wechat-studio/cover-styles/draft-preview?token=11111111-1111-4111-8111-111111111111',
      prompt: 'final prompt',
    },
  })
  assert.equal(applied.previewStale, false)
  assert.equal(applied.previewDraftToken, '11111111-1111-4111-8111-111111111111')
  assert.equal(applied.previewUrl, 'wechat-studio/cover-styles/draft-preview?token=11111111-1111-4111-8111-111111111111')
  assert.equal(applied.lastTestPrompt, 'final prompt')

  // 跨会话隔离：当 expectedJobId 不匹配或为 null/空字符串时，不污染无关草稿
  const untouched = applyTestJobToDraft(withPreview, {
    jobId: 'job-other',
    status: 'succeeded',
    result: { draftToken: '99999999-9999-4999-8999-999999999999', previewUrl: 'wechat-studio/cover-styles/draft-preview?token=9999' },
  }, 'job-mine')
  assert.equal(untouched, withPreview)
  assert.equal(createWizardDraft(null).name, '')
})

test('buildRefinePayload：强制使用用户当前最新编辑态草稿并携带会话参考图', () => {
  const current = createWizardDraft({
    name: '用户手改名',
    description: '用户手改简介',
    usePortrait: true,
    userRequirement: '原始诉求',
    template: '用户手改模板 {{主标题}} {{视觉}} [[SUBJECT]] [[OUTFIT]]',
    guidance: '用户手改指引',
    referenceImages: ['data:image/jpeg;base64,CC=='],
  })
  const payload = buildRefinePayload(current, '背景改暖白一点')
  assert.deepEqual(payload, {
    referenceImages: ['data:image/jpeg;base64,CC=='],
    requirement: '原始诉求',
    adjustment: '背景改暖白一点',
    draft: {
      name: '用户手改名',
      description: '用户手改简介',
      usePortrait: true,
      template: '用户手改模板 {{主标题}} {{视觉}} [[SUBJECT]] [[OUTFIT]]',
      guidance: '用户手改指引',
    },
  })
})

test('buildSavePayload：严格按 试生成样图 > 本次新上传参考图 > 编辑保留旧预览 优先级构建保存载荷', () => {
  const ref1 = 'data:image/jpeg;base64,R1=='
  const ref2 = 'data:image/jpeg;base64,R2=='

  // 1. 有 previewDraftToken 时优先传 previewDraftToken，不传 fallbackReferenceImage
  const withDraftToken = createWizardDraft({
    name: '新风格',
    description: '描',
    usePortrait: false,
    template: '21:9 {{a}} {{b}}',
    referenceImages: [ref1, ref2],
    previewDraftToken: '22222222-2222-4222-8222-222222222222',
  })
  const p1 = buildSavePayload(withDraftToken, 'create')
  assert.equal(p1.previewDraftToken, '22222222-2222-4222-8222-222222222222')
  assert.equal('fallbackReferenceImage' in p1, false)

  // 2. 新建无试生成但有参考图 -> 取第 1 张作为 fallbackReferenceImage
  const createWithRef = createWizardDraft({
    name: '参考图兜底',
    description: '描',
    template: '21:9 {{a}} {{b}}',
    referenceImages: [ref1, ref2],
  })
  const p2 = buildSavePayload(createWithRef, 'create')
  assert.equal(p2.fallbackReferenceImage, ref1)
  assert.equal('previewDraftToken' in p2, false)

  // 3. 编辑模式未重新试生成且未新上传参考图 -> 两者都不传（服务端保留原预览），带 id
  const editKeep = createWizardDraft({
    id: 'custom-abcd1234',
    name: '编辑保留原图',
    description: '描',
    template: '21:9 {{a}} {{b}}',
    previewUrl: 'wechat-studio/cover-styles/preview?id=custom-abcd1234',
  })
  const p3 = buildSavePayload(editKeep, 'edit')
  assert.equal(p3.id, 'custom-abcd1234')
  assert.equal('previewDraftToken' in p3, false)
  assert.equal('fallbackReferenceImage' in p3, false)

  // 4. 编辑模式在 Step 1 新上传了参考图且未重新试图 -> 用新上传第 1 张做 fallbackReferenceImage
  const editNewRef = createWizardDraft({
    ...editKeep,
    referenceImages: [ref2],
  })
  const p4 = buildSavePayload(editNewRef, 'edit')
  assert.equal(p4.id, 'custom-abcd1234')
  assert.equal(p4.fallbackReferenceImage, ref2)
  assert.equal(p4.styleReferenceImage, ref2)

  // 5. useStyleReference 与 usePortrait 互斥，且 dirty/stale 正确追踪
  const styleRefDraft = createWizardDraft({
    name: '红黑风',
    description: '描',
    usePortrait: false,
    useStyleReference: true,
    template: '21:9 {{a}} {{b}}',
    referenceImages: [ref1],
    previewUrl: 'wechat-studio/cover-styles/draft-preview?token=1',
  })
  assert.equal(isWizardDirty(createWizardDraft({ ...styleRefDraft, useStyleReference: false }), styleRefDraft), true)
  assert.equal(markPreviewStaleOnDraftChange(createWizardDraft({ ...styleRefDraft, useStyleReference: false }), styleRefDraft), true)
  const p5 = buildSavePayload(styleRefDraft, 'create')
  assert.equal(p5.useStyleReference, true)
  assert.equal(p5.styleReferenceImage, ref1)

  const portraitDraft = createWizardDraft({ ...styleRefDraft, usePortrait: true, useStyleReference: true })
  assert.equal(portraitDraft.useStyleReference, false)
  const p6 = buildSavePayload(portraitDraft, 'create')
  assert.equal(p6.useStyleReference, false)
  assert.equal('styleReferenceImage' in p6, false)
})
