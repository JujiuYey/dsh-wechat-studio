import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createArticle } from '../src/article.js'
import { portableBlocks, toPortableMarkdown } from '../src/derive-markdown.js'

function makeArticle(markdown, front = '') {
  const article = createArticle({ markdown })
  if (front) article.front = front
  return article
}

test('toPortableMarkdown 剥离 front matter、fixedLines、公众号引导语与行内高亮下划线', () => {
  const article = makeArticle(
    `# 我的文章标题

第一段保留 ==重点高亮== 和 ++底部划线++ 以及 <u>HTML下划线</u>，但 \`==代码里的不变==\` 和 \`<u>标签</u>\` 不动。

第二段保留正文
设为「星标」

教你用AI干掉90%的重复劳动

点个赞、在看支持一下`,
    '---\nauthor: 测试\n---',
  )

  const fixedLines = ['设为「星标」', '教你用AI干掉90%的重复劳动']
  const out = toPortableMarkdown(article, { target: 'blog', fixedLines })
  assert.equal(out.title, '我的文章标题')
  assert.ok(!out.markdown.includes('author: 测试'))
  assert.ok(!out.markdown.includes('设为「星标」'))
  assert.ok(!out.markdown.includes('重复劳动'))
  assert.ok(!out.markdown.includes('点个赞'))
  assert.ok(out.markdown.includes('**重点高亮**'))
  assert.ok(out.markdown.includes('**底部划线**'))
  assert.ok(out.markdown.includes('**HTML下划线**'))
  assert.ok(out.markdown.includes('`==代码里的不变==`'))
  assert.ok(out.markdown.includes('`<u>标签</u>`'))
  assert.match(out.markdown, /^# 我的文章标题\n\n第一段保留/)
  assert.ok(out.markdown.endsWith('\n'))
  assert.ok(!out.markdown.endsWith('\n\n'))
})

test('toPortableMarkdown 将 svg-* 动画卡降级为可读 Markdown，损坏卡省略并告警', () => {
  const article = makeArticle(`# 动画卡测试

\`\`\`svg-steps 三步流程
打开首页 | 点击新建
粘贴正文 | 不要改动
确认插入 | 检查位置
> 越简单越稳定
\`\`\`

\`\`\`svg-table 参数对比
| 工具 | 速度 |
| --- | --- |
| A | 快 |
| B | 慢 |
\`\`\`

\`\`\`svg-compare 新旧方式
手动排版 | 耗时长且易错
一键导出 | 三秒出稿
\`\`\`

\`\`\`svg-steps 坏掉的卡片
只有一列缺少分隔符
\`\`\``)

  const out = toPortableMarkdown(article, { target: 'blog' })
  assert.ok(!out.markdown.includes('```svg-'))
  assert.match(out.markdown, /\*\*三步流程\*\*\n1\. 打开首页：点击新建\n2\. 粘贴正文：不要改动\n3\. 确认插入：检查位置\n\n> 越简单越稳定/)
  assert.match(out.markdown, /\*\*参数对比\*\*\n\| 工具 \| 速度 \|\n\| --- \| --- \|\n\| A \| 快 \|\n\| B \| 慢 \|/)
  assert.match(out.markdown, /\*\*新旧方式\*\*\n\| 对比项 \| 说明 \|\n\| --- \| --- \|\n\| 手动排版 \| 耗时长且易错 \|\n\| 一键导出 \| 三秒出稿 \|/)
  assert.ok(out.warnings.some(w => w.includes('1 张动画卡无法解析')))
})

test('toPortableMarkdown 删除视频与未填占位并生成对应告警', () => {
  const article = makeArticle(`# 媒体测试

正文第一段。

[demo.mp4]

[截图：这里放后台截图]

结尾段落。`)

  const out = toPortableMarkdown(article, { target: 'juejin' })
  assert.ok(!out.markdown.includes('demo.mp4'))
  assert.ok(!out.markdown.includes('截图：'))
  assert.equal(out.warnings.length, 2)
  assert.match(out.warnings[0], /第 2 段.*demo\.mp4/)
  assert.match(out.warnings[1], /第 3 段.*\[截图：/)
})

test('target 差异：zhihu 不带一级标题并转换 callout，juejin/blog 保留原样', () => {
  const article = makeArticle(`# 标题文字

> [!NOTE] 注意事项说明
> 补充第二行

> [!TIP] 实用技巧`)

  const zhihu = toPortableMarkdown(article, { target: 'zhihu' })
  assert.equal(zhihu.title, '标题文字')
  assert.ok(!zhihu.markdown.startsWith('# 标题文字'))
  assert.ok(zhihu.markdown.includes('> **提示**：注意事项说明\n> 补充第二行'))
  assert.ok(zhihu.markdown.includes('> **技巧**：实用技巧'))

  const juejin = toPortableMarkdown(article, { target: 'juejin' })
  assert.ok(juejin.markdown.startsWith('# 标题文字\n\n'))
  assert.ok(juejin.markdown.includes('> [!NOTE] 注意事项说明'))
})

test('portableBlocks 保留原始 block id 且过滤已删除段落，检测未转存飞书图片告警', () => {
  const article = makeArticle(`# 飞书测试

设为「星标」

![封面](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=abc)

![第二张](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=def)`)

  const { blocks, warnings } = portableBlocks(article, { fixedLines: ['设为「星标」'] })
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].id, article.blocks[1].id)
  assert.equal(blocks[1].id, article.blocks[2].id)
  assert.ok(warnings.some(w => w.includes('2 张飞书图片')))
})

test('空文章和代码块保护及非法 target 校验', () => {
  const empty = createArticle({ markdown: '' })
  assert.equal(toPortableMarkdown(empty, { target: 'zhihu' }).markdown, '')
  assert.equal(toPortableMarkdown(makeArticle('# 只有标题')).markdown, '# 只有标题\n')

  const withCode = makeArticle('# 代码\n\n```js\nconst a = "==不变=="\n// 设为「星标」\n```')
  const codeOut = toPortableMarkdown(withCode, { fixedLines: ['设为「星标」'] })
  assert.ok(codeOut.markdown.includes('const a = "==不变=="'))

  assert.throws(
    () => toPortableMarkdown(empty, { target: 'invalid' }),
    err => err.status === 400,
  )
})
