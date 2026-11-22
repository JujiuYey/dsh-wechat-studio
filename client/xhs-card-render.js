import { balanceXhsArtboard } from './xhs-card-balance.js'
// 浏览器侧小红书 1080×1440 PNG 渲染器：
// 优先使用 SVG <foreignObject> 将 Claude Design / OpenDesign 风格的 HTML/CSS 画布直接光栅化为 1080×1440 PNG，
// 自动将外部图片内联为 DataURL 以避免 Canvas 污染；若极端环境不支持 foreignObject，则无缝回退到 Canvas 2D 指令渲染。

import { CARD_SIZE, FONT_STACK, layoutCard } from './xhs-card-layout.js'
import {
  buildCardStyleText,
  ensureCardHtml,
  resolveArtboardClassName,
  resolveXhsThemeVars,
  themeVarsToCssText,
} from './xhs-card-html.js'

const imageCache = new Map()
const inlinedUrlCache = new Map()

function loadExternalImage(url, timeoutMs = 2500) {
  if (!url) return Promise.resolve(null)
  if (imageCache.has(url)) return imageCache.get(url)

  const promise = new Promise(resolve => {
    const img = new Image()
    let settled = false
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!result) imageCache.delete(url)
      resolve(result)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    if (/^https?:\/\//i.test(url)) {
      img.crossOrigin = 'anonymous'
    }
    img.onload = () => finish(img)
    img.onerror = () => finish(null)
    img.src = url
  })

  imageCache.set(url, promise)
  return promise
}

async function inlineImageUrl(url) {
  if (!url) return ''
  if (url.startsWith('data:')) return url
  if (inlinedUrlCache.has(url)) return inlinedUrlCache.get(url)

  const img = await loadExternalImage(url)
  if (!img) return ''
  try {
    const w = Math.min(1080, img.naturalWidth || img.width || 800)
    const scale = w / Math.max(1, img.naturalWidth || img.width || w)
    const h = Math.max(1, Math.round((img.naturalHeight || img.height || 600) * scale))
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0, w, h)
    const dataUrl = c.toDataURL('image/png')
    inlinedUrlCache.set(url, dataUrl)
    return dataUrl
  } catch {
    return ''
  }
}

async function renderHtmlArtboardToCanvas(canvas, card, opts = {}) {
  if (typeof document === 'undefined' || typeof XMLSerializer === 'undefined') {
    return null
  }
  const themeVars = resolveXhsThemeVars({
    deckStyle: opts.deckStyle,
    palette: opts.palette,
    tweaks: opts.tweaks,
  })
  const html = ensureCardHtml(card, opts)
  const host = document.createElement('div')
  host.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml')
  host.style.cssText = `width:${CARD_SIZE.width}px;height:${CARD_SIZE.height}px;overflow:hidden;margin:0;padding:0;`

  const styleEl = document.createElement('style')
  styleEl.textContent = buildCardStyleText({
    customCss: opts.customCss || '',
    pageCss: card?.pageCss || '',
  })
  host.appendChild(styleEl)

  const artboard = document.createElement('div')
  artboard.className = resolveArtboardClassName(card, opts)
  artboard.style.cssText = themeVarsToCssText(themeVars)
  artboard.innerHTML = html
  host.appendChild(artboard)

  // 将所有 <img> 的外部 URL 内联为 DataURL，防止 foreignObject 污染或无法加载外部资源
  const imgs = Array.from(artboard.querySelectorAll('img'))
  await Promise.all(
    imgs.map(async imgEl => {
      const src = imgEl.getAttribute('src') || ''
      const inlined = await inlineImageUrl(src)
      if (inlined) {
        imgEl.setAttribute('src', inlined)
      } else {
        const placeholder = document.createElement('div')
        placeholder.className = 'cd-slot'
        const titleEl = document.createElement('div')
        titleEl.className = 'cd-slot-title'
        titleEl.textContent = imgEl.getAttribute('alt') || '配图预览'
        placeholder.appendChild(titleEl)
        imgEl.replaceWith(placeholder)
      }
    }),
  )

  const measurementHost = document.createElement('div')
  measurementHost.style.cssText = 'position:fixed;left:-20000px;top:0;visibility:hidden'
  const shadow = measurementHost.attachShadow({ mode: 'open' })
  shadow.appendChild(host)
  document.body.appendChild(measurementHost)
  try {
    await Promise.all([...artboard.querySelectorAll('img')].map(img => img.decode().catch(() => {})))
    const balanceSheet = document.createElement('style')
    host.appendChild(balanceSheet)
    balanceXhsArtboard(artboard, balanceSheet)
  } finally {
    measurementHost.remove()
  }

  const serializer = new XMLSerializer()
  const xhtml = serializer.serializeToString(host)
  const svgMarkup = `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_SIZE.width}" height="${CARD_SIZE.height}" viewBox="0 0 ${CARD_SIZE.width} ${CARD_SIZE.height}"><foreignObject x="0" y="0" width="${CARD_SIZE.width}" height="${CARD_SIZE.height}">${xhtml}</foreignObject></svg>`
  const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgMarkup)}`

  const svgImg = await loadExternalImage(svgUrl, 5000)
  if (!svgImg) return null

  canvas.width = CARD_SIZE.width
  canvas.height = CARD_SIZE.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.clearRect(0, 0, CARD_SIZE.width, CARD_SIZE.height)
  ctx.drawImage(svgImg, 0, 0, CARD_SIZE.width, CARD_SIZE.height)
  return { overflow: false }
}

function roundedRectPath(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r || 0, Math.min(w, h) / 2))
  ctx.beginPath()
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, radius)
    return
  }
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

function drawCoverImage(ctx, img, x, y, w, h, radius = 0) {
  const iw = img.naturalWidth || img.width || w
  const ih = img.naturalHeight || img.height || h
  const scale = Math.max(w / iw, h / ih)
  const sw = w / scale
  const sh = h / scale
  const sx = Math.max(0, (iw - sw) / 2)
  const sy = Math.max(0, (ih - sh) / 2)

  ctx.save()
  roundedRectPath(ctx, x, y, w, h, radius)
  ctx.clip()
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h)
  ctx.restore()
}

async function drawCardFallbackToCanvas(canvas, card, opts) {
  canvas.width = CARD_SIZE.width
  canvas.height = CARD_SIZE.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器不支持 Canvas 2D 渲染')

  if (typeof document !== 'undefined' && document.fonts?.ready) {
    try { await document.fonts.ready } catch {}
  }

  const measure = (text, fontPx, weight = 500, family = FONT_STACK) => {
    ctx.font = `${weight} ${fontPx}px ${family}`
    return ctx.measureText(text).width
  }

  const plan = layoutCard(card, opts, measure)
  const imageOps = plan.ops.filter(op => op.op === 'image' && op.url)
  const loadedImages = new Map()
  if (imageOps.length) {
    await Promise.all(
      imageOps.map(async op => {
        const img = await loadExternalImage(op.url)
        if (img) loadedImages.set(op.url, img)
      }),
    )
  }

  for (const item of plan.ops) {
    if (item.op === 'rect') {
      ctx.save()
      roundedRectPath(ctx, item.x, item.y, item.w, item.h, item.radius || 0)
      if (item.fill) {
        ctx.fillStyle = item.fill
        ctx.fill()
      }
      if (item.stroke) {
        ctx.strokeStyle = item.stroke
        ctx.lineWidth = item.lineWidth || 1
        ctx.stroke()
      }
      ctx.restore()
    } else if (item.op === 'line') {
      ctx.save()
      ctx.beginPath()
      ctx.moveTo(item.x1, item.y1)
      ctx.lineTo(item.x2, item.y2)
      ctx.strokeStyle = item.stroke || '#000'
      ctx.lineWidth = item.lineWidth || 1
      ctx.stroke()
      ctx.restore()
    } else if (item.op === 'text') {
      ctx.save()
      ctx.font = `${item.weight || 400} ${item.fontPx}px ${item.family || FONT_STACK}`
      ctx.fillStyle = item.color || '#18181B'
      ctx.textAlign = item.align || 'left'
      ctx.textBaseline = 'alphabetic'
      ctx.fillText(item.text, item.x, item.y)
      ctx.restore()
    } else if (item.op === 'image') {
      const img = loadedImages.get(item.url)
      if (img) drawCoverImage(ctx, img, item.x, item.y, item.w, item.h, item.radius || 0)
    }
  }

  return plan
}

export async function renderCardToBlob(card, opts = {}) {
  const canvas = document.createElement('canvas')
  let plan = await renderHtmlArtboardToCanvas(canvas, card, opts)
  if (!plan) {
    plan = await drawCardFallbackToCanvas(canvas, card, opts)
  }
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(result => {
      if (result) resolve(result)
      else reject(new Error('卡片导出 PNG 失败'))
    }, 'image/png')
  })
  return { blob, overflow: Boolean(plan.overflow) }
}

export async function renderCardToDataUrl(card, opts = {}) {
  const { blob, overflow } = await renderCardToBlob(card, opts)
  const url = URL.createObjectURL(blob)
  return { url, blob, overflow }
}
