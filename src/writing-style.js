// 服务端个人写作风格模块：中性 skill 渲染、内容哈希漂移检测、安全备份、应用与一键恢复。
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { callModel, extractJson } from './ai.js'
import { HOOKS, HOOK_IDS } from './article.js'
import { extractInsightsSection, replaceInsightsSection } from './insights.js'
import { buildSampleBundle, normalizeStyleProfile } from './writing-style-shared.js'

export const MANAGED_MARKER = 'managed_by: dsh-wechat-studio-personal-style'

const BUNDLED_SKILLS = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
const PROFILE_FILE = 'style-profile.json'
const SCOPE_NAMES = ['writer', 'headline']

async function atomicWrite(filePath, content) {
  await mkdir(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${randomUUID()}.tmp`
  await writeFile(tmp, content, { mode: 0o600 })
  await rename(tmp, filePath)
}

async function readOptional(filePath) {
  try {
    return await readFile(filePath, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

async function fileExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function stripInsightsForHash(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const start = lines.findIndex(line => /^## 数据复盘规则\s*$/.test(line))
  if (start === -1) return lines.join('\n').trim()
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) { end = i; break }
  }
  lines.splice(start, end - start)
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function contentHash(name, text) {
  const normalized = name === 'headline' ? stripInsightsForHash(text) : String(text ?? '').replace(/\r\n?/g, '\n').trim()
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

function formatTimestamp(date = new Date()) {
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

async function backupExistingFile(skillsDir, name, existingText) {
  const baseName = `${name}.md.bak`
  const basePath = join(skillsDir, baseName)
  if (!(await fileExists(basePath))) {
    await atomicWrite(basePath, existingText)
    return baseName
  }
  const stamp = formatTimestamp()
  let candidate = `${baseName}.${stamp}`
  let idx = 1
  while (await fileExists(join(skillsDir, candidate))) {
    idx += 1
    candidate = `${baseName}.${stamp}-${idx}`
  }
  await atomicWrite(join(skillsDir, candidate), existingText)
  return candidate
}

function bulletList(items, fallback) {
  if (!items?.length) return `- ${fallback}`
  return items.map(item => `- ${item}`).join('\n')
}

/**
 * 渲染中性的个人 writer.md：注入结构化风格特征与原文代表句，同时强制保留管道结构契约与防 AI 味底线。
 */
export function renderWriterSkill(rawProfile) {
  const profile = normalizeStyleProfile(rawProfile)
  const sections = [
    '---',
    'name: writer',
    `description: 个人写作风格（${profile.name}）`,
    MANAGED_MARKER,
    '---',
    '',
    `# 个人写作风格：${profile.name}`,
    '',
    '## 一句话定位',
    '',
    profile.summary,
    '',
    '## 语气与读者视角',
    '',
    bulletList(profile.voice, '像跟熟人面对面聊天一样自然表达，不端着、不说教'),
    '',
    '## 开头与行文节奏',
    '',
    bulletList(profile.rhythm, '开头直接切入具体场景或问题，段落短促清晰，长短句交替'),
    '',
  ]

  if (profile.phrases.length) {
    sections.push('## 常用表达与口头禅（自然穿插，不要每段硬塞）', '', bulletList(profile.phrases, ''), '')
  }

  sections.push(
    '## 个人雷区与去 AI 味底线',
    '',
    bulletList(
      [
        ...(profile.taboos.length ? [`尽量避免使用以下词句：${profile.taboos.join('、')}`] : []),
        '避免空洞排比、宏大叙事、三段论式总结和机械过渡词（如「值得注意的是」「综上所述」「不可否认」）',
        '有具体事实、数字或亲历细节就落到实处，不靠形容词堆砌情绪',
      ],
      '',
    ),
    '',
  )

  if (profile.excerpts.length) {
    sections.push(
      '## 原文代表句（学习节奏与语感，不要照抄原文事实）',
      '',
      ...profile.excerpts.map(excerpt => `> ${excerpt}`),
      '',
    )
  }

  if (profile.userNote) {
    sections.push('## 作者补充偏好', '', `- ${profile.userNote}`, '')
  }

  sections.push(
    '## 结构与输出契约（不可破坏）',
    '',
    '- 整篇成稿第一行用 `# 标题`，正文分节使用 `## 小标题`。',
    '- 遇到缺少真实细节、数据或经历的地方，用 `[可补：具体要补什么]` 标出，绝不编造经历或数据。',
    '- 适合放配图或操作截图的位置，用 `[截图：画面内容说明]` 标出。',
    '- 保持 Markdown 干净，不输出额外解释性开场白。',
    '',
  )

  return sections.join('\n')
}

/**
 * 渲染中性的个人 headline.md：注入标题与摘要习惯，强制保留 HOOK_IDS 与 JSON 输出契约，并原样保留已有 ## 数据复盘规则。
 */
export function renderHeadlineSkill(rawProfile, existingHeadlineMd = '') {
  const profile = normalizeStyleProfile(rawProfile)
  const hookList = HOOK_IDS.map(id => `- \`${id}\`：${HOOKS[id]}`).join('\n')

  const base = [
    '---',
    'name: headline',
    `description: 个人标题与摘要风格（${profile.name}）`,
    MANAGED_MARKER,
    '---',
    '',
    `# 个人标题与摘要风格：${profile.name}`,
    '',
    '## 风格基调',
    '',
    `- 整体定位：${profile.summary}`,
    `- 标题长度偏好：${profile.headline.lengthRange}`,
    `- 标点与语气：${profile.headline.punctuation}`,
    `- 摘要风格：${profile.headline.summaryStyle}`,
    '',
    '## 偏好的开头钩子与切入角度',
    '',
    bulletList(profile.headline.hooks, '贴合正文真实看点，先给读者一个明确理由点进来'),
    '',
    '## 禁区',
    '',
    bulletList(
      [
        ...(profile.taboos.length ? [`标题和摘要中避免：${profile.taboos.join('、')}`] : []),
        '不写标题党空话，不透支正文兑现不了的承诺',
      ],
      '',
    ),
    '',
    '## 输出契约（严格遵守）',
    '',
    '必须只输出一个 JSON 对象，包含 `titles`、`summary`、`recommendationReason` 字段；其中每个标题对象的 `hook` 字段只能从以下值中选择：',
    '',
    hookList,
    '',
  ].join('\n')

  const insightsSection = extractInsightsSection(existingHeadlineMd)
  return insightsSection ? replaceInsightsSection(base, insightsSection) : base
}

async function readSavedRecord(root) {
  const raw = await readOptional(join(root, PROFILE_FILE))
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * 读取工作区当前个人写作风格状态。active 与 scopes 一律以磁盘实际托管文件为准。
 */
export async function readStyleState(root) {
  const skillsDir = join(root, 'skills')
  const [saved, writerDisk, headlineDisk, writerBak, headlineBak] = await Promise.all([
    readSavedRecord(root),
    readOptional(join(skillsDir, 'writer.md')),
    readOptional(join(skillsDir, 'headline.md')),
    fileExists(join(skillsDir, 'writer.md.bak')),
    fileExists(join(skillsDir, 'headline.md.bak')),
  ])

  const scopes = {
    writer: Boolean(writerDisk && writerDisk.includes(MANAGED_MARKER)),
    headline: Boolean(headlineDisk && headlineDisk.includes(MANAGED_MARKER)),
  }

  return {
    active: scopes.writer || scopes.headline,
    scopes,
    profile: saved?.profile ? normalizeStyleProfile(saved.profile) : null,
    sampleCount: Number(saved?.sampleCount ?? 0),
    sampleTitles: Array.isArray(saved?.sampleTitles) ? saved.sampleTitles : [],
    updatedAt: saved?.updatedAt ?? null,
    hasBackup: { writer: writerBak, headline: headlineBak },
  }
}

async function deactivateManagedHeadline(skillsDir, existingText) {
  const filePath = join(skillsDir, 'headline.md')
  const latestInsights = extractInsightsSection(existingText)
  if (!latestInsights) {
    await unlink(filePath)
    return { preservedInsights: false }
  }
  const bundled = await readFile(join(BUNDLED_SKILLS, 'headline.md'), 'utf8')
  await atomicWrite(filePath, replaceInsightsSection(bundled, latestInsights))
  return { preservedInsights: true }
}

/**
 * 启用或更新个人写作风格。
 * - 自动对客户端提交的 profile 重新规范化。
 * - 若目标文件为非托管文件或相对上次生成哈希有手改漂移，先做不覆盖旧备份的 .bak / 带时间戳备份。
 * - 若取消某个之前启用的 scope，自动清理对应的托管文件（若存在手改漂移则先备份再停用，并保留 headline.md 中的 ## 数据复盘规则）。
 */
export async function applyWritingStyle(
  root,
  rawProfile,
  { scopes = { writer: true, headline: true }, sampleTitles } = {},
) {
  const targetScopes = {
    writer: scopes?.writer !== false,
    headline: scopes?.headline !== false,
  }
  if (!targetScopes.writer && !targetScopes.headline) {
    throw Object.assign(new Error('请至少勾选一个生效范围（写正文或出标题）。'), { status: 400 })
  }

  const profile = normalizeStyleProfile(rawProfile)
  const skillsDir = join(root, 'skills')
  await mkdir(skillsDir, { recursive: true })
  const saved = (await readSavedRecord(root)) ?? {}
  const prevHashes = saved.managedHashes ?? {}
  const nextHashes = { ...prevHashes }

  const written = []
  const removed = []
  const backedUp = []

  for (const name of SCOPE_NAMES) {
    const filePath = join(skillsDir, `${name}.md`)
    const existing = await readOptional(filePath)

    if (targetScopes[name]) {
      if (existing != null) {
        const isManaged = existing.includes(MANAGED_MARKER)
        const matchesLastHash = Boolean(prevHashes[name]) && contentHash(name, existing) === prevHashes[name]
        if (!isManaged || !matchesLastHash) {
          backedUp.push(await backupExistingFile(skillsDir, name, existing))
        }
      }
      const rendered = name === 'writer'
        ? renderWriterSkill(profile)
        : renderHeadlineSkill(profile, existing ?? '')
      await atomicWrite(filePath, rendered)
      nextHashes[name] = contentHash(name, rendered)
      written.push(name)
    } else if (existing != null) {
      const isManaged = existing.includes(MANAGED_MARKER)
      const matchesLastHash = Boolean(prevHashes[name]) && contentHash(name, existing) === prevHashes[name]
      if (isManaged) {
        if (!matchesLastHash) {
          backedUp.push(await backupExistingFile(skillsDir, name, existing))
        }
        if (name === 'headline') {
          await deactivateManagedHeadline(skillsDir, existing)
        } else {
          await unlink(filePath)
        }
        nextHashes[name] = null
        removed.push(name)
      }
    }
  }

  const titles = Array.isArray(sampleTitles)
    ? sampleTitles.map(t => String(t ?? '').trim().slice(0, 60)).filter(Boolean)
    : (Array.isArray(saved.sampleTitles) ? saved.sampleTitles : [])

  const record = {
    version: profile.version,
    active: true,
    scopes: targetScopes,
    profile,
    sampleCount: titles.length || Number(saved.sampleCount ?? 0),
    sampleTitles: titles,
    managedHashes: nextHashes,
    updatedAt: new Date().toISOString(),
  }
  await atomicWrite(join(root, PROFILE_FILE), JSON.stringify(record, null, 2))

  return {
    state: await readStyleState(root),
    written,
    removed,
    backedUp,
  }
}

/**
 * 恢复默认风格（或恢复启用前的 .bak 备份），绝不触碰内置 skills/，且保留启用期间更新的 ## 数据复盘规则。
 */
export async function restoreDefaultStyle(root, { restoreBackup = false } = {}) {
  const skillsDir = join(root, 'skills')
  const saved = (await readSavedRecord(root)) ?? {}
  const prevHashes = saved.managedHashes ?? {}
  const removed = []
  const restored = []
  const backedUp = []
  let preservedInsights = false

  for (const name of SCOPE_NAMES) {
    const filePath = join(skillsDir, `${name}.md`)
    const bakPath = join(skillsDir, `${name}.md.bak`)
    const existing = await readOptional(filePath)
    const bakContent = restoreBackup ? await readOptional(bakPath) : null
    const isManaged = Boolean(existing && existing.includes(MANAGED_MARKER))
    const matchesLastHash = Boolean(existing && prevHashes[name]) && contentHash(name, existing) === prevHashes[name]
    const latestInsights = name === 'headline' && existing ? extractInsightsSection(existing) : null

    if (restoreBackup && bakContent != null) {
      if (existing != null && (!isManaged || !matchesLastHash)) {
        backedUp.push(await backupExistingFile(skillsDir, name, existing))
      }
      const finalBak = latestInsights ? replaceInsightsSection(bakContent, latestInsights) : bakContent
      await atomicWrite(filePath, finalBak)
      await unlink(bakPath).catch(() => {})
      restored.push(name)
      if (latestInsights) preservedInsights = true
      continue
    }

    if (!isManaged) continue
    if (!matchesLastHash) {
      backedUp.push(await backupExistingFile(skillsDir, name, existing))
    }
    if (name === 'headline' && latestInsights) {
      const res = await deactivateManagedHeadline(skillsDir, existing)
      removed.push(name)
      if (res.preservedInsights) preservedInsights = true
    } else {
      await unlink(filePath)
      removed.push(name)
    }
  }

  if (saved.profile) {
    const nextRecord = {
      ...saved,
      active: false,
      scopes: { writer: false, headline: false },
      managedHashes: { writer: null, headline: null },
      updatedAt: new Date().toISOString(),
    }
    await atomicWrite(join(root, PROFILE_FILE), JSON.stringify(nextRecord, null, 2))
  }

  return {
    state: await readStyleState(root),
    removed,
    restored,
    backedUp,
    preservedInsights,
  }
}

const DEFAULT_PREVIEW_TOPIC = 'AI 工具真能帮普通人省时间吗？'

const ANALYZE_SYSTEM = `你是一位资深的中文公众号编辑，擅长从作者过往文章里提炼真实、可复用的个人写作风格。
只根据提供的参考文章归纳，不要臆造作者没表现出的习惯，也不要套用模板化的空泛夸赞。
必须只返回一个 JSON 对象，字段如下：
{
  "name": "给这套风格起一个简短好懂的中文名（<= 16 字）",
  "summary": "一句话定位（<= 60 字，大白话说明读起来像什么感觉）",
  "voice": ["语气与读者视角特点，2-4 条，每条用大白话"],
  "rhythm": ["开头方式、段落长短和行文节奏，2-4 条"],
  "phrases": ["作者高频自然使用的口头禅、过渡词或句式，0-8 个"],
  "taboos": ["作者明显不爱用或与他气场冲突的词句/套路，0-8 个"],
  "headline": {
    "lengthRange": "常见标题字数范围，如 14–22 字",
    "hooks": ["偏好的标题切入方式，2-3 条"],
    "punctuation": "标题标点习惯",
    "summaryStyle": "文章摘要写法习惯"
  },
  "excerpts": ["从参考文章里原字不改摘出 3-5 句最能代表作者语气的原话，每句 35-180 字"]
}`

/**
 * 构建个人风格分析提示词（供服务端与 CLI --prompt-only 复用）。
 */
export function buildAnalyzePrompt(samples, { userNote = '', fixedLines = [] } = {}) {
  const bundle = buildSampleBundle(samples, { fixedLines })
  const noteLine = String(userNote ?? '').trim()
  const user = [
    `以下是作者提供的 ${bundle.items.length} 篇参考文章（已自动清洗代码块、链接与固定尾注）：`,
    '',
    bundle.combined,
    ...(noteLine ? ['', `作者额外补充的期望：${noteLine}`] : []),
    '',
    '请严格按要求只输出 JSON 对象。',
  ].join('\n')
  return {
    system: ANALYZE_SYSTEM,
    user,
    bundle,
    noteLine,
    meta: {
      sampleCount: bundle.items.length,
      totalChars: bundle.totalChars,
      truncated: bundle.truncated,
      sampleTitles: bundle.items.map(item => item.title),
    },
  }
}

/**
 * 分析用户提供的参考文章，提炼结构化的个人写作风格档案。
 */
export async function analyzeWritingStyle(ctx, samples, { userNote = '', fixedLines = [], signal } = {}) {
  const { system, user, bundle, noteLine, meta } = buildAnalyzePrompt(samples, { userNote, fixedLines })

  const rawText = await callModel(ctx, { system, user, task: 'style-analyze', maxTokens: 3000, signal })
  const parsed = extractJson(rawText)
  const hasSummary = typeof parsed?.summary === 'string' && parsed.summary.trim().length > 0
  const hasVoice = Array.isArray(parsed?.voice) && parsed.voice.some(item => typeof item === 'string' && item.trim())
  if (!parsed || typeof parsed !== 'object' || (!hasSummary && !hasVoice)) {
    throw Object.assign(new Error('模型没有返回可用的风格分析结果，请重试。'), { status: 502 })
  }

  const merged = noteLine ? { ...parsed, userNote: noteLine } : parsed
  const profile = normalizeStyleProfile(merged, bundle.items)
  return { profile, meta }
}

/**
 * 构建个人风格试写提示词（供服务端与 CLI --prompt-only 复用）。
 */
export function buildPreviewPrompt(rawProfile, rawTopic = '') {
  const profile = normalizeStyleProfile(rawProfile)
  const topic = String(rawTopic ?? '').trim().slice(0, 120) || DEFAULT_PREVIEW_TOPIC
  const system = [
    '你正在为作者做「写作风格现场试写」。严格按照下方个人正文风格与标题风格来写，让作者一眼听出像不像自己。',
    '必须只返回一个 JSON 对象：{"opening": "120-180字的开头试写（1-2段，纯文本）", "titles": ["标题1", "标题2", "标题3"]}',
    'titles 必须恰好包含 3 个互不重复的非空中文标题。',
    '',
    '=== 个人正文风格 ===',
    renderWriterSkill(profile),
    '',
    '=== 个人标题风格 ===',
    renderHeadlineSkill(profile),
  ].join('\n')
  const user = `请围绕选题「${topic}」，按这套风格试写一段开头和 3 个标题。只输出 JSON。`
  return { profile, topic, system, user }
}

/**
 * 现场试写：按当前风格档案针对指定选题试写一段 120-180 字的开头和 3 个标题。
 */
export async function previewWritingStyle(ctx, rawProfile, rawTopic = '', { signal } = {}) {
  const { topic, system, user } = buildPreviewPrompt(rawProfile, rawTopic)
  const rawText = await callModel(ctx, { system, user, task: 'style-preview', maxTokens: 1500, signal })
  const parsed = extractJson(rawText)
  const opening = typeof parsed?.opening === 'string' ? parsed.opening.replace(/\r\n?/g, '\n').trim().slice(0, 600) : ''
  const titles = []
  const seen = new Set()
  for (const item of Array.isArray(parsed?.titles) ? parsed.titles : []) {
    const text = typeof item === 'string' ? item.trim().slice(0, 80) : ''
    if (!text || seen.has(text)) continue
    seen.add(text)
    titles.push(text)
    if (titles.length === 3) break
  }
  if (!opening || titles.length < 3) {
    throw Object.assign(new Error('模型没有给出 3 个可用标题，请重试。'), { status: 502 })
  }
  return { topic, opening, titles }
}
