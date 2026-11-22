// 调模型和读 skill。写作、标题、去 AI 味都由 skills/ 里的 Markdown 驱动，
// 用户可以在 <DSH_HOME>/wechat-studio/skills/ 放同名文件覆盖。
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUNDLED = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
const SESSION_ID = `dsh-wechat-studio-${randomUUID()}`
export const SKILL_NAMES = ['writer', 'headline', 'humanizer', 'zhuque', 'banner', 'repurpose-thread', 'repurpose-xhs']
export const COVER_SKILL_DIR = join(BUNDLED, 'linyuebanzi-cover-banner')
export const INLINE_DIAGRAM_SKILL_DIR = join(BUNDLED, 'linyuebanzi-inline-diagram')
export const SVG_CARDS_SKILL_DIR = join(BUNDLED, 'wechat-svg-cards')

/** 最近一次模型调用的结果。选了模型不等于能用，比如还没配密钥。 */
export const modelStatus = { ok: null, error: null }

export async function loadSkill(name, overrideDir) {
  if (!SKILL_NAMES.includes(name)) throw new Error(`未知的 skill：${name}`)
  for (const dir of [overrideDir, BUNDLED]) {
    if (!dir) continue
    try {
      const raw = await readFile(join(dir, `${name}.md`), 'utf8')
      return raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim()
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
  }
  throw new Error(`找不到 skill 文件：${name}.md`)
}

/**
 * 每份 skill 当前用的是哪一份：用户在覆盖目录放了同名文件就用它，否则用插件内置的。
 * @param {string} overrideDir - 覆盖目录。
 * @returns {Promise<Array<{name: string, source: 'user'|'bundled', path: string, chars: number}>>} 列表。
 */
export async function skillSources(overrideDir) {
  const entries = SKILL_NAMES.map(name => ({
    name, file: `${name}.md`, sources: [[overrideDir, 'user'], [BUNDLED, 'bundled']],
  }))
  entries.push({ name: 'cover', file: 'SKILL.md', sources: [[COVER_SKILL_DIR, 'bundled']] })
  entries.push({
    name: 'inline-diagram', file: 'SKILL.md',
    sources: [[overrideDir ? join(overrideDir, 'linyuebanzi-inline-diagram') : null, 'user'], [INLINE_DIAGRAM_SKILL_DIR, 'bundled']],
  })
  entries.push({
    name: 'wechat-svg-cards', file: 'SKILL.md',
    sources: [[overrideDir ? join(overrideDir, 'wechat-svg-cards') : null, 'user'], [SVG_CARDS_SKILL_DIR, 'bundled']],
  })
  return Promise.all(entries.map(async ({ name, file, sources }) => {
    const displayPath = name === 'cover' ? `linyuebanzi-cover-banner/${file}` : name === 'inline-diagram' ? `linyuebanzi-inline-diagram/${file}` : name === 'wechat-svg-cards' ? `wechat-svg-cards/${file}` : file
    for (const [dir, source] of sources) {
      if (!dir) continue
      const path = join(dir, file)
      try {
        const info = await stat(path)
        if (info.isFile()) return { name, source, path, displayPath, chars: info.size }
      } catch {
        // 没有就看下一个
      }
    }
    return { name, source: 'missing', path: '', displayPath, chars: 0 }
  }))
}

// 用户在插件里指定的模型；null 表示跟随 DeepSeek Harness 的默认模型
let override = null

export function setModelOverride(selection) {
  override = selection?.provider && selection?.model ? { provider: selection.provider, model: selection.model } : null
}

export function modelOverride() {
  return override
}

export function defaultSelection(ctx) {
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection()
    return selection?.provider && selection?.model ? { provider: selection.provider, model: selection.model } : null
  } catch {
    return null
  }
}

/** 实际要用的模型：指定了就用指定的，否则跟随 DSH 默认。 */
export function modelInfo(ctx) {
  if (!ctx.get('llm')) return null
  return override ?? defaultSelection(ctx)
}

/**
 * 列出 DSH 里已接入的提供方和它们公布的模型，给模型选择器用。某个提供方读失败就跳过，不影响其他的。
 * @param {object} ctx - Cordis 上下文。
 */
export async function listModels(ctx) {
  const llm = ctx.get('llm')
  const providers = llm ? await llm.listProviders() : []
  const settled = await Promise.allSettled(providers.map(async p => ({
    provider: p.id, name: p.name || p.id,
    models: (await llm.listModels(p.id)).map(m => ({ id: m.id, name: m.name || m.id })),
  })))
  return settled.filter(r => r.status === 'fulfilled').map(r => r.value).filter(p => p.models.length)
}

/**
 * 调一次模型并流式回传文本。插件在会话之外调模型，所以自己带一个会话标识。
 * @param {object} ctx - Cordis 上下文。
 * @param {{system: string, user: string, task: string, maxTokens?: number, signal?: AbortSignal, onText?: (delta: string) => void}} request - 请求。
 * @returns {Promise<string>} 完整文本。
 */
export async function callModel(ctx, { system, user, task, maxTokens = 8000, signal, onText }) {
  const info = modelInfo(ctx)
  if (!info) throw new Error('当前没有可用模型，请先在 DeepSeek Harness 里配置好模型')
  const llm = ctx.get('llm')
  try {
    const call = await llm.prepareCall({ provider: info.provider, model: info.model, maxTokens }, signal, controls => controls)
    let text = ''
    for await (const chunk of call.stream({
      ...call.config,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }], source: { kind: 'dsh-wechat-studio', task } }],
      sessionId: SESSION_ID,
      signal,
    })) {
      if (chunk.type === 'text-delta') {
        text += chunk.text
        onText?.(chunk.text)
      } else if (chunk.type === 'finish' && ['error', 'aborted'].includes(chunk.reason?.kind)) {
        throw new Error(chunk.reason.failure?.message || '模型调用失败')
      }
    }
    modelStatus.ok = true
    modelStatus.error = null
    return text
  } catch (err) {
    modelStatus.ok = false
    modelStatus.error = err.message
    throw err
  }
}

/** 从模型输出里取出 JSON，容忍外面包了代码块或前后有说明文字。 */
export function extractJson(text) {
  const source = String(text ?? '')
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(source)
  const candidates = [fenced?.[1], source]
  for (const candidate of candidates) {
    if (!candidate) continue
    const start = candidate.search(/[{[]/)
    if (start === -1) continue
    const open = candidate[start]
    const end = candidate.lastIndexOf(open === '{' ? '}' : ']')
    if (end <= start) continue
    try {
      return JSON.parse(candidate.slice(start, end + 1))
    } catch {
      // 换下一个候选
    }
  }
  return null
}

/** 模型常把整篇包在 ```markdown 里，或者在前面加一句「好的，以下是……」。 */
export function cleanMarkdown(text) {
  let out = String(text ?? '').trim()
  const fenced = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/.exec(out)
  if (fenced) out = fenced[1].trim()
  return out
}
