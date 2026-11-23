// 本地自定义封面风格模块：独立风格包存储、两阶段原子落盘、路径/软链/魔数安全预览 IO 与草稿清理。
import { randomBytes, randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { COVER_STYLES, CUSTOM_COVER_STYLE_LIMITS, extractTemplateSlots, isCustomStyleId } from './cover-styles.js'
import { findBlocked, loadCoverBlocklist } from './cover-prompt.js'
import { parseDataImageUri } from './derive-shared.js'
import { withFileLock } from './store.js'

export const CUSTOM_STYLE_PREVIEW_FILES = new Set(['preview.png', 'preview.jpg', 'preview.jpeg'])
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PREVIEW_EXTS = ['png', 'jpg', 'jpeg']

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra })
}

function stylesRoot(root) {
  return join(root, 'cover-styles')
}

function draftsRoot(root) {
  return join(root, 'cover-styles', '_drafts')
}

function isInsideDir(parentReal, childReal) {
  const prefix = parentReal.endsWith(sep) ? parentReal : `${parentReal}${sep}`
  return childReal.startsWith(prefix)
}

async function assertRegularNoSymlink(filePath, parentDirReal) {
  const st = await lstat(filePath)
  if (st.isSymbolicLink() || !st.isFile()) {
    throw httpError(400, '非法的文件路径或符号链接。')
  }
  const real = await realpath(filePath)
  if (!isInsideDir(parentDirReal, real)) {
    throw httpError(400, '文件路径超出允许范围。')
  }
  return real
}

async function assertDirNoSymlink(dirPath, parentDirReal) {
  const st = await lstat(dirPath)
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw httpError(400, '非法的风格目录或符号链接。')
  }
  const real = await realpath(dirPath)
  if (parentDirReal && !isInsideDir(parentDirReal, real)) {
    throw httpError(400, '风格目录超出允许范围。')
  }
  return real
}

export function detectImageContentType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return null
  if (buffer.toString('hex', 0, 8) === '89504e470d0a1a0a') return 'image/png'
  if (buffer.toString('hex', 0, 3) === 'ffd8ff') return 'image/jpeg'
  return null
}

function normalizeMultiline(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim()
}

export function validateCustomStyleInput(input, blocklistTerms = []) {
  const name = typeof input?.name === 'string' ? input.name.trim() : ''
  if (!name || name.length > CUSTOM_COVER_STYLE_LIMITS.maxName) {
    throw httpError(400, `风格名称不能为空，且不超过 ${CUSTOM_COVER_STYLE_LIMITS.maxName} 字。`)
  }
  const description = typeof input?.description === 'string' ? input.description.trim() : ''
  if (!description || description.length > CUSTOM_COVER_STYLE_LIMITS.maxDescription) {
    throw httpError(400, `风格简介不能为空，且不超过 ${CUSTOM_COVER_STYLE_LIMITS.maxDescription} 字。`)
  }
  const userRequirement = typeof input?.userRequirement === 'string' ? input.userRequirement.trim() : ''
  if (userRequirement.length > CUSTOM_COVER_STYLE_LIMITS.maxRequirement) {
    throw httpError(400, `风格诉求不能超过 ${CUSTOM_COVER_STYLE_LIMITS.maxRequirement} 字。`)
  }
  const template = normalizeMultiline(input?.template)
  if (!template) {
    throw httpError(400, '提示词模板不能为空。')
  }
  if (template.length > CUSTOM_COVER_STYLE_LIMITS.maxTemplate) {
    throw httpError(400, `提示词模板不能超过 ${CUSTOM_COVER_STYLE_LIMITS.maxTemplate} 字。`)
  }
  const slots = extractTemplateSlots(template)
  if (slots.length < CUSTOM_COVER_STYLE_LIMITS.minSlots) {
    throw httpError(400, `提示词模板至少需要包含 ${CUSTOM_COVER_STYLE_LIMITS.minSlots} 个 {{...}} 占位符（例如标题与视觉核心元素）。`)
  }
  const guidance = normalizeMultiline(input?.guidance)
  if (guidance.length > CUSTOM_COVER_STYLE_LIMITS.maxGuidance) {
    throw httpError(400, `填空指引不能超过 ${CUSTOM_COVER_STYLE_LIMITS.maxGuidance} 字。`)
  }
  const blocked = findBlocked(blocklistTerms, template)
  if (blocked) {
    throw httpError(400, `提示词模板包含封面禁用词「${blocked}」，请换成克制的正面描述后再保存。`)
  }
  return {
    name,
    description,
    usePortrait: Boolean(input?.usePortrait),
    userRequirement,
    template,
    guidance,
    slots,
  }
}

function safePreviewFileName(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') return null
  if (value.includes('/') || value.includes('\\') || value.includes('..')) return null
  return CUSTOM_STYLE_PREVIEW_FILES.has(value) ? value : null
}

async function readStyleDirEntry(stylesDirReal, dirName) {
  if (!isCustomStyleId(dirName)) return { skip: true }
  const styleDir = join(stylesDirReal, dirName)
  let styleDirReal
  try {
    styleDirReal = await assertDirNoSymlink(styleDir, stylesDirReal)
  } catch {
    return { warning: `自定义封面风格 ${dirName} 目录无效或为符号链接，已跳过。` }
  }
  try {
    const metaPath = join(styleDirReal, 'meta.json')
    const templatePath = join(styleDirReal, 'template.txt')
    const guidancePath = join(styleDirReal, 'guidance.txt')
    await assertRegularNoSymlink(metaPath, styleDirReal)
    await assertRegularNoSymlink(templatePath, styleDirReal)
    const [rawMeta, rawTemplate] = await Promise.all([
      readFile(metaPath, 'utf8'),
      readFile(templatePath, 'utf8'),
    ])
    const meta = JSON.parse(rawMeta)
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      return { warning: `自定义封面风格 ${dirName} 的 meta.json 格式无效，已跳过。` }
    }
    if (meta.id !== dirName || typeof meta.name !== 'string' || !meta.name.trim() || typeof meta.description !== 'string' || !meta.description.trim()) {
      return { warning: `自定义封面风格 ${dirName} 的元数据不完整，已跳过。` }
    }
    const template = normalizeMultiline(rawTemplate)
    if (!template) {
      return { warning: `自定义封面风格 ${dirName} 的模板为空，已跳过。` }
    }
    let guidance = ''
    try {
      await assertRegularNoSymlink(guidancePath, styleDirReal)
      guidance = normalizeMultiline(await readFile(guidancePath, 'utf8'))
    } catch (err) {
      if (err.code !== 'ENOENT') {
        return { warning: `自定义封面风格 ${dirName} 的填空指引读取失败，已跳过。` }
      }
    }
    const previewFile = safePreviewFileName(meta.previewFile)
    const slots = extractTemplateSlots(template)
    return {
      style: {
        version: 1,
        id: dirName,
        source: 'custom',
        name: meta.name.trim(),
        description: meta.description.trim(),
        usePortrait: Boolean(meta.usePortrait),
        userRequirement: typeof meta.userRequirement === 'string' ? meta.userRequirement : '',
        previewFile,
        createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : '',
        updatedAt: typeof meta.updatedAt === 'string' ? meta.updatedAt : '',
        template,
        guidance,
        slots,
      },
    }
  } catch {
    return { warning: `自定义封面风格 ${dirName} 读取失败或已损坏，已跳过。` }
  }
}

export async function listCoverStyles(root) {
  const builtins = COVER_STYLES.map(item => ({ ...item }))
  const dir = stylesRoot(root)
  let entries
  try {
    const st = await lstat(dir)
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return { styles: builtins, warnings: ['自定义封面风格目录无效，已跳过。'] }
    }
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return { styles: builtins, warnings: [] }
    return { styles: builtins, warnings: [`自定义封面风格目录读取失败（${err.code ?? '未知错误'}）。`] }
  }

  const dirReal = await realpath(dir)
  const warnings = []
  const custom = []
  for (const entry of entries) {
    const name = entry.name
    if (name === '_drafts' || name.startsWith('.')) continue
    if (!isCustomStyleId(name)) continue
    const res = await readStyleDirEntry(dirReal, name)
    if (res.warning) warnings.push(res.warning)
    else if (res.style) {
      const { template: _t, guidance: _g, slots: _s, ...summary } = res.style
      custom.push(summary)
    }
  }
  custom.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  return { styles: [...builtins, ...custom], warnings }
}

export async function readCustomCoverStyle(root, id) {
  if (!isCustomStyleId(id)) return null
  const dir = stylesRoot(root)
  let dirReal
  try {
    const st = await lstat(dir)
    if (st.isSymbolicLink() || !st.isDirectory()) return null
    dirReal = await realpath(dir)
  } catch {
    return null
  }
  const res = await readStyleDirEntry(dirReal, id)
  return res.style ?? null
}

export async function resolveCoverStyle(root, id) {
  if (typeof id !== 'string' || !id.trim()) return null
  const builtin = COVER_STYLES.find(item => item.id === id)
  if (builtin) return { ...builtin }
  return readCustomCoverStyle(root, id)
}

export async function pruneExpiredDrafts(root, nowMs = Date.now(), ttlMs = DRAFT_TTL_MS) {
  const dir = draftsRoot(root)
  let entries
  try {
    const st = await lstat(dir)
    if (st.isSymbolicLink() || !st.isDirectory()) return 0
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return 0
    return 0
  }
  let removed = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const filePath = join(dir, entry.name)
    try {
      const st = await lstat(filePath)
      if (!st.isSymbolicLink() && nowMs - st.mtimeMs > ttlMs) {
        await unlink(filePath)
        removed++
      }
    } catch {
      // 忽略并发已被删的文件
    }
  }
  return removed
}

export async function saveDraftPreview(root, imageBuffer, format = 'png') {
  const detected = detectImageContentType(imageBuffer)
  if (!detected) throw httpError(400, '试生成样图不是有效的 PNG 或 JPEG 图片。')
  const actualFormat = detected === 'image/jpeg' ? 'jpeg' : 'png'
  const ext = actualFormat === 'jpeg' ? 'jpg' : 'png'
  const dir = draftsRoot(root)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const draftToken = randomUUID()
  await writeFile(join(dir, `${draftToken}.${ext}`), imageBuffer, { mode: 0o600 })
  await pruneExpiredDrafts(root).catch(() => {})
  return { draftToken, format: actualFormat }
}

async function resolveDraftPath(root, token) {
  if (typeof token !== 'string' || !UUID_RE.test(token)) {
    throw httpError(400, '无效的试生成样图标识。')
  }
  const dir = draftsRoot(root)
  let dirReal
  try {
    dirReal = await assertDirNoSymlink(dir, null)
  } catch {
    throw httpError(404, '试生成样图不存在或已过期。')
  }
  for (const ext of PREVIEW_EXTS) {
    const candidate = join(dirReal, `${token}.${ext}`)
    try {
      const real = await assertRegularNoSymlink(candidate, dirReal)
      return { path: real, ext }
    } catch (err) {
      if (err.code === 'ENOENT') continue
      throw err
    }
  }
  throw httpError(404, '试生成样图不存在或已过期。')
}

export async function readDraftPreview(root, token) {
  const { path } = await resolveDraftPath(root, token)
  const buffer = await readFile(path)
  const contentType = detectImageContentType(buffer)
  if (!contentType) throw httpError(415, '试生成样图文件格式无效。')
  return {
    buffer,
    contentType,
    format: contentType === 'image/jpeg' ? 'jpeg' : 'png',
  }
}

export async function readCustomStylePreview(root, id) {
  if (!isCustomStyleId(id)) throw httpError(400, '无效的自定义封面风格 ID。')
  const stylesDir = stylesRoot(root)
  let stylesDirReal
  try {
    stylesDirReal = await assertDirNoSymlink(stylesDir, null)
  } catch {
    throw httpError(404, '封面风格预览图不存在。')
  }
  const styleDir = join(stylesDirReal, id)
  let styleDirReal
  try {
    styleDirReal = await assertDirNoSymlink(styleDir, stylesDirReal)
  } catch (err) {
    if (err.code === 'ENOENT') throw httpError(404, '自定义封面风格不存在。')
    throw err
  }
  const metaPath = join(styleDirReal, 'meta.json')
  await assertRegularNoSymlink(metaPath, styleDirReal)
  let meta
  try {
    meta = JSON.parse(await readFile(metaPath, 'utf8'))
  } catch {
    throw httpError(404, '自定义封面风格元数据已损坏。')
  }
  const previewName = meta?.previewFile
  if (typeof previewName !== 'string' || !previewName) {
    throw httpError(404, '该自定义风格暂无预览图。')
  }
  if (previewName.includes('/') || previewName.includes('\\') || previewName.includes('..') || !CUSTOM_STYLE_PREVIEW_FILES.has(previewName)) {
    throw httpError(400, '非法的预览图文件名。')
  }
  const previewPath = join(styleDirReal, previewName)
  let previewReal
  try {
    previewReal = await assertRegularNoSymlink(previewPath, styleDirReal)
  } catch (err) {
    if (err.code === 'ENOENT') throw httpError(404, '封面风格预览图文件不存在。')
    throw err
  }
  const buffer = await readFile(previewReal)
  const contentType = detectImageContentType(buffer)
  if (!contentType) throw httpError(415, '预览图文件格式无效。')
  return { buffer, contentType }
}

async function prepareFallbackPreview(dataUrl) {
  const parsed = parseDataImageUri(dataUrl)
  if (!parsed) throw httpError(400, '参考图不是有效的图片 Data URL。')
  const raw = Buffer.from(parsed.data, 'base64')
  if (raw.length > CUSTOM_COVER_STYLE_LIMITS.maxReferenceBytes) {
    throw httpError(400, '参考图体积超过 2 MB 上限。')
  }
  const detected = detectImageContentType(raw)
  if (!detected) return null
  const format = detected === 'image/jpeg' ? 'jpeg' : 'png'
  try {
    const { cropCover } = await import('../dist/image-crop.mjs')
    const cropped = cropCover(raw, format)
    return { buffer: cropped, previewFile: format === 'jpeg' ? 'preview.jpg' : 'preview.png' }
  } catch {
    // 极端尺寸无法按 47:20 裁切时降级为无预览图，不阻断保存
    return null
  }
}

async function countCustomStyles(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter(e => e.isDirectory() && isCustomStyleId(e.name)).length
  } catch (err) {
    if (err.code === 'ENOENT') return 0
    throw err
  }
}

async function generateUniqueId(dir) {
  for (let attempt = 0; attempt < 16; attempt++) {
    const id = `custom-${randomBytes(4).toString('hex')}`
    try {
      await lstat(join(dir, id))
    } catch (err) {
      if (err.code === 'ENOENT') return id
    }
  }
  throw httpError(500, '无法生成唯一的自定义风格 ID，请重试。')
}

export async function saveCustomCoverStyle(root, input, opts = {}) {
  const terms = await loadCoverBlocklist()
  const validated = validateCustomStyleInput(input, terms)
  const isUpdate = input?.id !== undefined && input?.id !== null && input?.id !== ''
  if (isUpdate && !isCustomStyleId(input.id)) {
    throw httpError(400, '只能编辑自定义封面风格，不能修改系统内置风格或非法 ID。')
  }

  // 解析预览图输入（在锁外先读草稿或裁切参考图，失败不持锁）
  let newPreview = null
  let consumedDraftPath = null
  if (input?.previewDraftToken) {
    const draftInfo = await resolveDraftPath(root, input.previewDraftToken)
    const draft = await readDraftPreview(root, input.previewDraftToken)
    newPreview = {
      buffer: draft.buffer,
      previewFile: draft.format === 'jpeg' ? 'preview.jpg' : 'preview.png',
    }
    consumedDraftPath = draftInfo.path
  } else if (input?.fallbackReferenceImage) {
    newPreview = await prepareFallbackPreview(input.fallbackReferenceImage)
  }

  const dir = stylesRoot(root)
  await mkdir(dir, { recursive: true, mode: 0o700 })

  const savedStyle = await withFileLock(join(dir, '.lock'), async () => {
    const dirReal = await assertDirNoSymlink(dir, null)
    const now = new Date().toISOString()

    if (!isUpdate) {
      const existingCount = await countCustomStyles(dirReal)
      if (existingCount >= CUSTOM_COVER_STYLE_LIMITS.maxStyles) {
        throw httpError(400, `本地自定义封面风格已达上限（${CUSTOM_COVER_STYLE_LIMITS.maxStyles} 套），请先删除不需要的风格再新建。`)
      }
      const id = await generateUniqueId(dirReal)
      const meta = {
        version: 1,
        id,
        name: validated.name,
        description: validated.description,
        usePortrait: validated.usePortrait,
        userRequirement: validated.userRequirement,
        previewFile: newPreview ? newPreview.previewFile : null,
        createdAt: now,
        updatedAt: now,
      }
      const stagingDir = join(dirReal, `.staging-${randomUUID()}`)
      const targetDir = join(dirReal, id)
      try {
        await mkdir(stagingDir, { mode: 0o700 })
        await writeFile(join(stagingDir, 'template.txt'), validated.template, { mode: 0o600 })
        await writeFile(join(stagingDir, 'guidance.txt'), validated.guidance, { mode: 0o600 })
        if (newPreview) {
          await writeFile(join(stagingDir, newPreview.previewFile), newPreview.buffer, { mode: 0o600 })
        }
        await writeFile(join(stagingDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 })
        if (opts._testFailBeforeCommit) throw new Error('simulated failure before create commit')
        await rename(stagingDir, targetDir)
      } catch (err) {
        await rm(stagingDir, { recursive: true, force: true }).catch(() => {})
        throw err
      }
      return { ...meta, source: 'custom', template: validated.template, guidance: validated.guidance, slots: validated.slots }
    }

    // 更新已有风格：同目录临时文件准备 -> 顺序替换 -> meta 提交
    const id = input.id
    const targetDir = join(dirReal, id)
    let targetDirReal
    try {
      targetDirReal = await assertDirNoSymlink(targetDir, dirReal)
    } catch (err) {
      if (err.code === 'ENOENT') throw httpError(404, '要编辑的自定义封面风格不存在。')
      throw err
    }

    const metaPath = join(targetDirReal, 'meta.json')
    const templatePath = join(targetDirReal, 'template.txt')
    const guidancePath = join(targetDirReal, 'guidance.txt')
    await assertRegularNoSymlink(metaPath, targetDirReal)
    await assertRegularNoSymlink(templatePath, targetDirReal)
    const oldMetaRaw = await readFile(metaPath, 'utf8')
    const oldTemplateRaw = await readFile(templatePath, 'utf8')
    const oldGuidanceRaw = await readFile(guidancePath, 'utf8').catch(err => (err.code === 'ENOENT' ? null : Promise.reject(err)))
    const prevMeta = JSON.parse(oldMetaRaw)
    const oldPreviewFile = safePreviewFileName(prevMeta?.previewFile)
    const oldPreviewBuf = newPreview && oldPreviewFile === newPreview.previewFile
      ? await readFile(join(targetDirReal, oldPreviewFile)).catch(() => null)
      : null

    const nextPreviewFile = newPreview ? newPreview.previewFile : oldPreviewFile
    const meta = {
      version: 1,
      id,
      name: validated.name,
      description: validated.description,
      usePortrait: validated.usePortrait,
      userRequirement: validated.userRequirement,
      previewFile: nextPreviewFile,
      createdAt: typeof prevMeta?.createdAt === 'string' && prevMeta.createdAt ? prevMeta.createdAt : now,
      updatedAt: now,
    }

    const token = randomUUID()
    const tmpFiles = []
    const tmpTemplate = join(targetDirReal, `.template.${token}.tmp`)
    const tmpGuidance = join(targetDirReal, `.guidance.${token}.tmp`)
    const tmpMeta = join(targetDirReal, `.meta.${token}.tmp`)
    const tmpPreview = newPreview ? join(targetDirReal, `.preview.${token}.tmp`) : null

    let previewReplaced = false
    let templateReplaced = false
    let guidanceReplaced = false
    let metaReplaced = false
    try {
      if (tmpPreview) {
        await writeFile(tmpPreview, newPreview.buffer, { mode: 0o600 })
        tmpFiles.push(tmpPreview)
      }
      await writeFile(tmpTemplate, validated.template, { mode: 0o600 })
      tmpFiles.push(tmpTemplate)
      await writeFile(tmpGuidance, validated.guidance, { mode: 0o600 })
      tmpFiles.push(tmpGuidance)
      await writeFile(tmpMeta, JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 })
      tmpFiles.push(tmpMeta)

      if (opts._testFailBeforeCommit) throw new Error('simulated failure before update commit')

      if (tmpPreview) {
        await rename(tmpPreview, join(targetDirReal, newPreview.previewFile))
        previewReplaced = true
      }
      await rename(tmpTemplate, templatePath)
      templateReplaced = true
      await rename(tmpGuidance, guidancePath)
      guidanceReplaced = true
      await rename(tmpMeta, metaPath)
      metaReplaced = true

      if (newPreview && oldPreviewFile && oldPreviewFile !== newPreview.previewFile) {
        await unlink(join(targetDirReal, oldPreviewFile)).catch(() => {})
      }
    } catch (err) {
      for (const tmp of tmpFiles) await unlink(tmp).catch(() => {})
      if (!metaReplaced) {
        if (previewReplaced && newPreview) {
          if (oldPreviewBuf !== null) await writeFile(join(targetDirReal, newPreview.previewFile), oldPreviewBuf, { mode: 0o600 }).catch(() => {})
          else if (oldPreviewFile !== newPreview.previewFile) await unlink(join(targetDirReal, newPreview.previewFile)).catch(() => {})
        }
        if (templateReplaced) await writeFile(templatePath, oldTemplateRaw, { mode: 0o600 }).catch(() => {})
        if (guidanceReplaced && oldGuidanceRaw !== null) await writeFile(guidancePath, oldGuidanceRaw, { mode: 0o600 }).catch(() => {})
      }
      throw err
    }
    return { ...meta, source: 'custom', template: validated.template, guidance: validated.guidance, slots: validated.slots }
  })

  if (consumedDraftPath) {
    await unlink(consumedDraftPath).catch(() => {})
  }
  await pruneExpiredDrafts(root).catch(() => {})

  const { styles, warnings } = await listCoverStyles(root)
  return { style: savedStyle, styles, warnings }
}

export async function deleteCustomCoverStyle(root, id) {
  if (!isCustomStyleId(id)) {
    throw httpError(400, '只能删除自定义封面风格，不能删除系统内置风格或非法 ID。')
  }
  const dir = stylesRoot(root)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await withFileLock(join(dir, '.lock'), async () => {
    const dirReal = await assertDirNoSymlink(dir, null)
    const targetDir = join(dirReal, id)
    try {
      await assertDirNoSymlink(targetDir, dirReal)
    } catch (err) {
      if (err.code === 'ENOENT') throw httpError(404, '要删除的自定义封面风格不存在。')
      throw err
    }
    await rm(targetDir, { recursive: true, force: true })
  })
  return listCoverStyles(root)
}
