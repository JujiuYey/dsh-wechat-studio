// 浏览器端图片读取、参考图压缩（≤ 960px、≤ 420 KB JPEG Data URL）与剪贴板图片提取。

export function loadBrowserImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('无法读取该图片文件'))
    img.src = src
  })
}

export async function compressReferenceImageFile(file) {
  if (!file) return ''
  if (file.size > 6 * 1024 * 1024) {
    throw new Error('参考图超过 6MB，请换一张小一点的图片')
  }
  const rawUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('读取参考图失败'))
    reader.readAsDataURL(file)
  })
  const img = await loadBrowserImage(rawUrl)
  if (
    /^data:image\/(?:png|jpeg|jpg);base64,/i.test(rawUrl)
    && rawUrl.length <= 320_000
    && img.width <= 960
    && img.height <= 960
  ) {
    return rawUrl
  }
  const scale = Math.min(1, 960 / Math.max(1, img.width, img.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.width * scale))
  canvas.height = Math.max(1, Math.round(img.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器不支持画布压缩')
  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  for (const quality of [0.82, 0.68, 0.54]) {
    const out = canvas.toDataURL('image/jpeg', quality)
    if (out.length <= 420_000) return out
  }
  throw new Error('参考图压缩后仍过大，请换一张或裁剪后重试')
}

export function extractClipboardImageFiles(event) {
  const dt = event?.clipboardData
  if (!dt) return []
  const files = []
  if (dt.items?.length) {
    for (const item of dt.items) {
      if (item.kind === 'file' && item.type?.startsWith('image/')) {
        const f = item.getAsFile()
        if (f) files.push(f)
      }
    }
  } else if (dt.files?.length) {
    for (const f of dt.files) {
      if (f.type?.startsWith('image/')) files.push(f)
    }
  }
  return files
}
