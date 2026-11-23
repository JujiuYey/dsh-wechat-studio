import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { test } from 'node:test'
import { renderFragment, renderPage, STYLES } from '../vendor/layout/layout.js'
import { build, checkSpec } from '../vendor/layout/banner.js'

// 期望值由原 Python 版 layout.py / banner.py 生成，JS 引擎必须逐字节一致
const dir = new URL('./fixtures/layout-golden/', import.meta.url)
const expected = JSON.parse(await readFile(new URL('expected.json', dir), 'utf8'))
const sha256 = s => createHash('sha256').update(s).digest('hex')

test('排版引擎输出与原 Python 版逐字节一致', async () => {
  const md = await readFile(new URL('article.md', dir), 'utf8')
  const banner = JSON.parse(await readFile(new URL('banner.json', dir), 'utf8'))
  const page = renderPage(md, { banner, outro: 'true', name: 'article.md' })
  assert.equal(page.filename, expected.page.filename)
  assert.equal(Buffer.byteLength(page.html), expected.page.bytes)
  assert.equal(sha256(page.html), expected.page.sha256)
  assert.match(page.report, /统计：图片 2，图注 3，视频占位 1，动画卡 4，滑动卡 1/)
})

test('开头横幅各版式与原 Python 版逐字节一致', () => {
  for (const { spec, sha256: want, issues } of expected.banners) {
    const svg = build(structuredClone(spec))
    const name = spec.style || spec.scene.layout
    assert.equal(sha256(svg), want, `${name} 横幅输出变了`)
    assert.deepEqual(checkSpec(structuredClone(spec), [svg]), issues, `${name} 横幅自查结果变了`)
  }
})

test('排版不再依赖 Python', async () => {
  const files = await readdir(new URL('../vendor/layout/', import.meta.url))
  assert.deepEqual(files.filter(f => f.endsWith('.py')), [])
  const src = await readFile(new URL('../src/layout.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /child_process|python/)
})

test('头像留空自动注入作者首字徽章兜底逻辑与获取指引', async () => {
  const banner = JSON.parse(await readFile(new URL('banner.json', dir), 'utf8'))
  const page = renderPage('# 标题\n\n一段正文。', { banner, outro: 'true', brandAuthor: 'alex的笔记', name: 'demo.md' })
  assert.match(page.html, /<meta name="referrer" content="no-referrer">/)
  assert.match(page.html, /"avatar_initial":\s*"A"/)
  assert.match(page.html, /function avatarBadgeHtml\(\)/)
  assert.match(page.html, /function avatarBadgeSvg\(/)
  assert.match(page.html, /改用默认徽章直接复制/)
  assert.match(page.html, /内容管理 → 素材库/)
  assert.doesNotMatch(page.html, /本地图片预览/)
  assert.doesNotMatch(page.html, /请填写头像的公众号图片地址/)
})

test('所有风格的正文图片均使用 inline-block 以便在公众号缩小后居中及自由对齐', () => {
  const md = '# 标题\n\n![设置页截图](https://mmbiz.qpic.cn/demo.png)\n'
  for (const style of Object.keys(STYLES)) {
    const { html } = renderFragment(md, { style, theme: 'orange', outro: 'false' })
    const match = html.match(/<section style="margin:2[46]px 0;text-align:center;"><img src="https:\/\/mmbiz\.qpic\.cn\/demo\.png" style="([^"]+)"\/>/)
    assert.ok(match, `${style} 风格未按预期输出图片容器`)
    assert.match(match[1], /display:inline-block;/, `${style} 风格图片应使用 display:inline-block`)
    assert.match(match[1], /vertical-align:top;/, `${style} 风格图片应使用 vertical-align:top`)
    assert.doesNotMatch(match[1], /display:block/, `${style} 风格图片不应使用 display:block`)
  }
})
