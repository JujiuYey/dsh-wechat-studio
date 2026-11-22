import { CARD_SIZE, FONT_STACK, layoutCard } from './xhs-card-layout.js'

function createCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height)
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function drawRoundedRect(ctx, x, y, w, h, radius) {
  const r = Math.min(radius, w / 2, h / 2)
  ctx.beginPath()
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r)
  } else {
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
  }
  ctx.closePath()
  ctx.fill()
}

function canvasToBlob(canvas) {
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type: 'image/png' })
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob)
      else reject(new Error('生成图片失败'))
    }, 'image/png')
  })
}

export async function renderCardToBlob(card, opts) {
  try {
    await document.fonts?.ready
  } catch {
    // 忽略字体就绪异常，继续使用兜底字体栈渲染
  }

  const canvas = createCanvas(CARD_SIZE.width, CARD_SIZE.height)
  const ctx = canvas.getContext('2d')
  const measure = (text, fontPx, weight = 400) => {
    ctx.font = `${weight} ${fontPx}px ${FONT_STACK}`
    return ctx.measureText(text).width
  }

  const { ops, overflow } = layoutCard(card, opts, measure)
  ctx.textBaseline = 'top'

  for (const op of ops) {
    if (op.type === 'rect') {
      ctx.fillStyle = op.fill
      if (op.radius) drawRoundedRect(ctx, op.x, op.y, op.w, op.h, op.radius)
      else ctx.fillRect(op.x, op.y, op.w, op.h)
    } else if (op.type === 'text') {
      ctx.font = `${op.weight} ${op.fontPx}px ${FONT_STACK}`
      ctx.fillStyle = op.color
      ctx.textAlign = op.align ?? 'left'
      ctx.fillText(op.text, op.x, op.y)
    }
  }

  const blob = await canvasToBlob(canvas)
  return { blob, overflow }
}

export async function renderCardToDataUrl(card, opts) {
  const { blob, overflow } = await renderCardToBlob(card, opts)
  return { url: URL.createObjectURL(blob), overflow }
}
