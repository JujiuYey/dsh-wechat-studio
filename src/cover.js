import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BAILIAN_SIZES, MINIMAX_SIZES } from './cover-options.js'
import { resolveCoverStyleName } from './cover-styles.js'
export { coverPrompt } from './cover-prompt.js'

const MAX_IMAGE = 24 * 1024 * 1024
const MAX_B64_CHARS = Math.ceil(MAX_IMAGE * 4 / 3) + 16
const MINIMAX_GENERATIONS = 'https://api.minimax.cn/v1/images/generations'
const MINIMAX_EDITS = 'https://api.minimax.cn/v1/images/edits'
const MINIMAX_TIMEOUT_MS = 600_000

function providerDetail(value, limit, apiKey) {
  if (typeof value !== 'string') return ''
  let text = value.replace(/\s+/g, ' ').trim()
  if (apiKey) text = text.split(apiKey).join('[已隐藏]')
  return text.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]').slice(0, limit)
}

function decodeBase64Image(encoded, format, providerLabel, subject, requestSuffix = '') {
  if (typeof encoded !== 'string') throw new Error(`${providerLabel}未返回可保存的${subject}。${requestSuffix}`)
  const normalized = encoded.trim()
  if (!normalized) throw new Error(`${providerLabel}未返回可保存的${subject}。${requestSuffix}`)
  if (normalized.length > MAX_B64_CHARS) {
    throw new Error(`${providerLabel}${subject}超过 24 MB，试试降低分辨率。${requestSuffix}`)
  }
  const image = Buffer.from(normalized, 'base64')
  if (!image.length) throw new Error(`${providerLabel}未返回可保存的${subject}。${requestSuffix}`)
  if (image.length > MAX_IMAGE) {
    throw new Error(`${providerLabel}${subject}超过 24 MB，试试降低分辨率。${requestSuffix}`)
  }
  const valid = format === 'jpeg'
    ? image.toString('hex', 0, 3) === 'ffd8ff'
    : image.toString('hex', 0, 8) === '89504e470d0a1a0a'
  if (!valid) throw new Error(`生成结果与所选图片格式不符。${requestSuffix}`)
  return image
}

export async function generateArkCover(prompt, { apiKey, model, resolution, format, referenceImage = null, subject = '封面' }, fetchImpl = fetch) {
  const res = await fetchImpl('https://ark.cn-beijing.volces.com/api/v3/images/generations', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180_000),
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model, prompt, ...(referenceImage ? { image: referenceImage } : {}), size: resolution,
      response_format: 'b64_json', output_format: format, background: 'opaque', watermark: false,
    }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const code = providerDetail(body?.error?.code, 120, apiKey)
    const message = providerDetail(body?.error?.message, 400, apiKey)
    const requestId = [
      body?.request_id, body?.error?.request_id,
      res.headers?.get?.('x-request-id'), res.headers?.get?.('x-tt-logid'),
    ].map(value => providerDetail(value, 120, apiKey)).find(Boolean) ?? ''
    const requestSuffix = requestId ? ` 请求 ID：${requestId}` : ''
    if (code === 'ModelNotOpen') throw new Error('当前火山方舟账号尚未开通 Doubao Seedream 5.5，请在方舟控制台的「开通管理」中开通。' + requestSuffix)
    if (code === 'InvalidEndpointOrModel.NotFound') throw new Error('火山方舟找不到 Seedream 5.5 或当前 API Key 无权调用，请检查项目和模型权限。' + requestSuffix)
    if (code === 'InvalidEndpointOrModel.ModelIDAccessDisabled') throw new Error('当前火山方舟账号不允许通过模型 ID 调用，需要使用有权限的推理接入点。' + requestSuffix)
    if (res.status === 401 || res.status === 403) throw new Error('火山方舟鉴权失败，请检查 API Key 和模型权限。' + requestSuffix)
    const details = [code && `错误码：${code}`, message && `原因：${message}`, requestId && `请求 ID：${requestId}`].filter(Boolean).join('；')
    throw new Error(`火山方舟生成失败（HTTP ${res.status}）${details ? `：${details}` : '，请重试。'}`)
  }
  const { data } = await res.json()
  return decodeBase64Image(data?.[0]?.b64_json, format, '火山方舟', subject)
}

function minimaxRequestId(body, res, apiKey) {
  return [
    body?.request_id,
    body?.error?.request_id,
    res?.headers?.get?.('trace_id'),
    res?.headers?.get?.('x-request-id'),
  ].map(value => providerDetail(value, 120, apiKey)).find(Boolean) ?? ''
}

function minimaxErrorCode(body, itemError) {
  const direct = itemError?.code ?? body?.error?.code
  if (direct !== undefined && direct !== null && String(direct).trim()) return String(direct).trim()
  const message = typeof itemError?.message === 'string' ? itemError.message
    : typeof body?.error?.message === 'string' ? body.error.message : ''
  return message.match(/\((\d+)\)\s*$/)?.[1] ?? ''
}

function minimaxErrorMessage({ status, body, requestId, apiKey, itemError = null, subject = '封面' }) {
  const code = minimaxErrorCode(body, itemError)
  const type = providerDetail(body?.error?.type, 120, apiKey)
  const message = providerDetail(itemError?.message ?? body?.error?.message, 400, apiKey)
  const requestSuffix = requestId ? ` 请求 ID：${requestId}` : ''
  if (status === 401 || code === '1004' || code === '2049') {
    return 'MiniMax 鉴权失败或 API Key 无效，请检查是否使用国内平台（platform.minimax.cn）的有效密钥。' + requestSuffix
  }
  if (code === '2022') return 'MiniMax 模型不存在或当前账号无权使用，请检查模型配置。' + requestSuffix
  if (code === '2069') return '当前所选 MiniMax 模型已下线，请切换其他可用模型。' + requestSuffix
  if (code === '2068' || code === '2061') return '当前 MiniMax 套餐等级不支持该模型，请升级套餐或切换模型。' + requestSuffix
  if (code === '1008' || code === '2053' || code === '2067' || status === 402) {
    return 'MiniMax 余额、积分或套餐额度不足，请充值或检查额度后再试。' + requestSuffix
  }
  if (status === 422 || code === '1026' || code === '1027') {
    return '提示词或生成结果未通过 MiniMax 内容安全审核，请调整后重试。' + requestSuffix
  }
  if (status === 429 || code === '1002' || code === '2056' || code === '2062') {
    return 'MiniMax 触发速率限制或套餐用量达到上限，请稍后再试。' + requestSuffix
  }
  if (code === '1001') return 'MiniMax 服务端等待超时，请稍后再试。' + requestSuffix
  const details = [
    code && `错误码：${code}`,
    type && `类型：${type}`,
    message && `原因：${message}`,
    requestId && `请求 ID：${requestId}`,
  ].filter(Boolean).join('；')
  return `MiniMax ${subject}生成失败（HTTP ${status}）${details ? `：${details}` : '。'}`
}

export async function generateMinimaxCover(prompt, { apiKey, model, resolution, format = 'png', referenceImage = null, size: explicitSize, subject = '封面' }, fetchImpl = fetch) {
  const hasRef = Boolean(referenceImage)
  const endpoint = hasRef ? MINIMAX_EDITS : MINIMAX_GENERATIONS
  // 文生图关闭服务端 Prompt 增强，避免改写模板排版或引入禁用词；图片编辑官方固定开启增强，不传该字段。
  const payload = {
    model,
    prompt,
    size: explicitSize ?? MINIMAX_SIZES[resolution],
    n: 1,
    output_format: format,
    response_format: 'b64_json',
    aigc_watermark: false,
    ...(hasRef ? { images: [{ image_url: referenceImage }] } : { disable_prompt_enhanced: true }),
  }
  let res
  try {
    // MiniMax H3 服务端最长等待 600 秒且非幂等；绝不自动重试，超时后提示避免立即重复提交。
    res = await fetchImpl(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(MINIMAX_TIMEOUT_MS),
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (err) {
    if (err?.name === 'TimeoutError') {
      throw Object.assign(
        new Error(`MiniMax ${subject}生成已等待 600 秒并断开，服务端仍可能完成并计费；请避免立即重复提交。`),
        { code: 'MINIMAX_TIMEOUT', nonRetryable: true, cause: err },
      )
    }
    throw err
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const requestId = minimaxRequestId(body, res, apiKey)
    throw new Error(minimaxErrorMessage({ status: res.status, body, requestId, apiKey, subject }))
  }
  const body = await res.json().catch(() => null)
  const requestId = minimaxRequestId(body, res, apiKey)
  const requestSuffix = requestId ? ` 请求 ID：${requestId}` : ''
  if (!body || typeof body !== 'object') {
    throw new Error(`MiniMax 返回了无效响应，无法保存${subject}。${requestSuffix}`)
  }
  const first = body.data?.[0]
  if (first?.error) {
    throw new Error(minimaxErrorMessage({ status: res.status, body, requestId, apiKey, itemError: first.error, subject }))
  }
  return decodeBase64Image(first?.b64_json, format, 'MiniMax', subject, requestSuffix)
}

export async function generateCoverImage(provider, prompt, options, fetchImpl = fetch) {
  if (provider === 'ark') return generateArkCover(prompt, options, fetchImpl)
  if (provider === 'bailian') return generateBailianCover(prompt, options, fetchImpl)
  if (provider === 'minimax') return generateMinimaxCover(prompt, options, fetchImpl)
  throw Object.assign(new Error('请选择有效的生图提供方。'), { status: 400 })
}

export async function generateBailianCover(prompt, { apiKey, model, resolution, referenceImage = null, size: explicitSize, subject = '封面' }, fetchImpl = fetch) {
  // 万相和千问图像共用同一个多模态同步接口，换 model 即可；万相不支持 prompt_extend，只给千问关掉自动扩写。
  const parameters = { size: explicitSize ?? BAILIAN_SIZES[resolution], n: 1, watermark: false }
  if (model.startsWith('qwen-image')) parameters.prompt_extend = false
  const content = [...(referenceImage ? [{ image: referenceImage }] : []), { text: prompt }]
  const res = await fetchImpl('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180_000),
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      input: { messages: [{ role: 'user', content }] },
      parameters,
    }),
  })
  if (!res.ok) {
    const code = (await res.json().catch(() => null))?.code
    if (code === 'InvalidApiKey' || res.status === 401 || res.status === 403) throw new Error('百炼鉴权失败，请检查 API Key 是否属于中国内地（北京）及是否有模型权限。')
    if (code === 'Throttling' || res.status === 429) throw new Error('百炼限流，请稍后重试。')
    if (code === 'DataInspectionFailed') throw new Error('提示词未通过百炼内容审核，请调整后重试。')
    throw new Error(`百炼生成失败（HTTP ${res.status}），请重试。`)
  }
  const data = await res.json()
  // 百炼回的是 24 小时有效的 PNG 链接，要再下载成字节才能落盘裁切。
  const url = data?.output?.choices?.[0]?.message?.content?.find(part => typeof part?.image === 'string')?.image
  if (typeof url !== 'string') throw new Error(`百炼未返回可保存的${subject}。`)
  const imageUrl = URL.canParse(url) ? new URL(url) : null
  if (imageUrl?.protocol !== 'https:' || imageUrl.username || imageUrl.password) throw new Error(`百炼返回了无效的 HTTPS ${subject}地址。`)
  const imageRes = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) })
  if (!imageRes.ok || !imageRes.body) {
    await imageRes.body?.cancel().catch(() => {})
    throw new Error(`百炼${subject}下载失败，请重试。`)
  }
  const tooLarge = () => new Error(`百炼${subject}超过 24 MB，试试降低分辨率。`)
  if (Number(imageRes.headers.get('content-length')) > MAX_IMAGE) {
    await imageRes.body.cancel().catch(() => {})
    throw tooLarge()
  }
  const chunks = []
  let size = 0
  // 提前退出迭代会取消下载；即使服务端没提供 Content-Length 也能限制大小。
  for await (const chunk of imageRes.body) {
    size += chunk.byteLength
    if (size > MAX_IMAGE) throw tooLarge()
    chunks.push(chunk)
  }
  const image = Buffer.concat(chunks, size)
  if (image.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw new Error(`百炼未返回有效的 PNG ${subject}。`)
  return image
}

export async function saveCover(root, image, format) {
  const dir = join(root, 'covers')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const id = randomUUID()
  try {
    const { cropCover } = await import('../dist/image-crop.mjs')
    const cropped = cropCover(image, format)
    await writeFile(join(dir, `${id}.${format}`), cropped, { mode: 0o600 })
    return id
  } catch {
    throw new Error('封面裁切或保存失败，请重试。')
  }
}

export function readCover(root, id, format = 'png') {
  if (!/^[a-f0-9-]{36}$/.test(id ?? '')) throw new Error('无效的封面 ID。')
  return readFile(join(root, 'covers', `${id}.${format}`))
}

export function coverDownloadName(article, run, imageId, styleNameOverride = '') {
  const clean = value => String(value ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '')
  const title = clean(article.title).slice(0, 48) || '未命名文章'
  const style = clean(resolveCoverStyleName(run.style, null, styleNameOverride || run.styleName)) || '封面'
  const createdAt = new Date(run.createdAt)
  const date = Number.isNaN(createdAt.getTime()) ? '' : [
    [createdAt.getFullYear(), String(createdAt.getMonth() + 1).padStart(2, '0'), String(createdAt.getDate()).padStart(2, '0')].join('-'),
    [createdAt.getHours(), createdAt.getMinutes(), createdAt.getSeconds()].map(value => String(value).padStart(2, '0')).join(''),
  ].join('-')
  const index = Math.max(0, run.images.findIndex(image => image.id === imageId)) + 1
  return `${[title, style, date].filter(Boolean).join('-')}-${String(index).padStart(2, '0')}.${run.format ?? 'png'}`
}
