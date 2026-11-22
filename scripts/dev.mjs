// 不装 DSH 也能看界面：起一个本地服务，用假的宿主和假的模型把插件跑起来。
// 用法：npm run build && npm run dev，然后打开 http://127.0.0.1:4173
// 数据存在 .dev/ 里，不碰 ~/.dsh。模型回复全是写死的，只用来看流程。
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { version: currentVersion } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
process.env.DSH_HOME ||= join(root, '.dev')
const { createHandler } = await import('../src/host.js')

const DRAFT = `# 排版交给 AI 后，我再没开过编辑器

大家好，我是把排版外包给 AI 的林月半子。写完一篇文章之后，排版这件事总要再耗掉我一整晚的耐心。

## 排版本来就不该人来做

它不仅提升了效率，更重塑了创作流程，也重新定义了写作者与工具的关系。

现在我写完 Markdown 丢给它，回来就是能直接贴进公众号的版式。**标题、引用、代码块，一个都不用我碰。**

> [!QUOTE] 好排版，是让读者感觉不到排版。

值得一提的是，这套流程具有极强的可扩展性，能够适配多种多样的内容场景。

[可补：第一次用它排版那天的具体经过]
`

const replies = {
  draft: () => DRAFT,
  titles: () => JSON.stringify({ titles: [{ text: '排版交给 AI 后，我再没开过编辑器', hook: 'A' }, { text: '写完就能发：不用手动排版的公众号流程', hook: 'D' }, { text: '排版这件事，本来就不该人来做', hook: 'B' }], summary: '写完 Markdown 就能发，排版这一步交给流程。', recommendationReason: '最具体，有反差' }),
  chat: user => {
    const no = Number(/第\s*(\d+)\s*段/.exec(user.split('# 作者这次说').pop())?.[1] ?? 1)
    return JSON.stringify({ reply: `改了第 ${no} 段，其他段落没动。`, ops: [{ op: 'rewrite', block: no, text: '（演示）这一段按你的意见重写过了。' }] })
  },
  banner: user => user.includes('# 横幅脚本检查出的问题')
    ? JSON.stringify({ slug: 'demo', title: '开头横幅', style: 'poster', poster: { eyebrow: 'AI 排版实测', title1: '排版这件事', title2: '交给流程', right: 'flow', ask: '帮我排好这篇', result: '排好了', result_sub: '直接贴进公众号', tags: ['不开编辑器', '一键复制', '十套风格'], big: 'AI' } })
    : JSON.stringify({ slug: 'demo', title: '开头横幅', style: 'poster', poster: { eyebrow: 'AI 排版实测', title1: '排版交给AI以后我再也没开过编辑器', title2: '交给流程', right: 'flow', ask: '帮我排好这篇', result: '排好了', tags: ['不开编辑器', '一键复制', '十套风格'], big: 'AI' } }),
  fixall: user => {
    const numbers = [...user.split('# 要一起改写的段').pop().matchAll(/【(\d+)】/g)].map(m => Number(m[1]))
    return JSON.stringify({ paragraphs: numbers.map((n, i) => ({ block: n, text: i === 0 ? `（演示）第 ${n} 段成组改写过了，详略和前后不一样。[可补：你自己当时的原话]` : `（演示）第 ${n} 段改短了。` })) })
  },
  fix: () => '我原来排一篇要四十分钟，现在写完就丢给它，回来直接贴。[可补：你自己的真实用时]',
  cover: user => JSON.stringify({ values: JSON.parse(user).slots.map(() => '演示填充') }),
  report: user => {
    const blocks = [...user.split('# 文章段落').pop().matchAll(/【(\d+)】/g)].map(m => Number(m[1]))
    return JSON.stringify({ overall: { human: 62, suspect: 31, ai: 7 }, segments: [{ block: blocks[1], score: 0.93 }, { block: blocks.at(-2), score: 0.56 }].filter(row => row.block) })
  },
  'svg-card-draft': user => {
    const { kind } = JSON.parse(user)
    const card = kind === 'svg-phone'
      ? { title: '按规则演示提醒', lines: ['按写作流程演示', '到点提醒 | 09:00 | 该写稿了', '没回就催 | 14:30 | 还没打卡，再提醒一次', '打卡 | 我 | 已完成'] }
      : kind === 'svg-concept'
        ? { title: '什么是 Personal Agent', lines: ['一个记得你、会主动找你的 AI', '以前的 AI | 你问一句 | 它答一句', 'Personal Agent | 记住你的习惯 | 替你盯着事 | 到点主动找你', '! 关键差别：不用每次重新交代'] }
        : { title: '三步完成初剪', lines: ['打开首页 | 点「口播剪辑」', '引用素材 | 用 @ 选上一个项目', '直接发送 | 预填的要求不用改'] }
    return JSON.stringify(card)
  },
  'inline-diagrams': user => {
    const article = JSON.parse(user)
    if (article.title.includes('短稿无图')) return JSON.stringify({ suggestions: [] })
    return JSON.stringify({ suggestions: article.blocks.filter(item => item.kind === 'para').slice(0, 3).map((block, index) => ({
      anchorId: block.id, kind: ['concept', 'flow', 'architecture'][index % 3], title: ['排版概念关系', '公众号排版流程', '工具组件分工'][index % 3],
      reason: '帮读者看清关键内容和处理顺序。', brief: '三个节点：Markdown 原稿 → 排版流程 → 公众号成稿，箭头从左到右。',
    })) })
  },
  'derive-thread': user => {
    const { blocks } = JSON.parse(user)
    const ids = blocks.map(b => b.id)
    return JSON.stringify({
      posts: [
        { text: '写完公众号长文后，排版这件事我早就不自己手调了。', source: ids.slice(0, 1) },
        { text: '把 Markdown 直接交给固定排版流程，标题、引用和代码块全部自动对齐，省下整晚折腾样式的时间。', source: ids.slice(1, 3) },
        { text: '好排版，本质上是让读者根本感觉不到排版。', source: ids.slice(2, 4) },
        { text: '你平时写完一篇文章后，排版还要花多久？', source: [] },
      ],
    })
  },
  'derive-xhs': user => {
    const { blocks } = JSON.parse(user)
    const ids = blocks.map(b => b.id)
    return JSON.stringify({
      title: '排版外包给 AI 后真香',
      body: '以前写完一篇文章，最消耗耐心的反而是最后半小时的排版调样式。后来我干脆把排版固定成一条流水线：写完 Markdown 直接导出成稿，不再手动调字号、行距和配色。这套流程最大的好处是稳定，不用每次重来，也不必纠结样式细节，欢迎自取尝试。',
      tags: ['内容创作', '公众号排版', '效率工具', 'Markdown'],
      cards: [
        { kind: 'cover', heading: '别再手动排版了', lines: ['写完 Markdown 直接出稿'], source: ids.slice(0, 1) },
        { kind: 'quote', heading: '核心原则', lines: ['好排版，是让读者感觉不到排版。'], source: ids.slice(1, 3) },
        { kind: 'list', heading: '省时间的三个关键', lines: ['先定死主题和样式表', '代码块引用块自动处理', '导出前只过一遍体检清单'], source: ids.slice(0, 3) },
        { kind: 'quote', heading: '真实体验', lines: ['写完 Markdown 丢进去，回来就是能直接贴进编辑器的版式。'], source: ids.slice(1, 2) },
        { kind: 'end', heading: '收藏这条慢慢用', lines: ['公众号同款流程持续更新中'], source: [] },
      ],
    })
  },
}

const llm = {
  listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'kimi', name: 'kimi-coding' }, { id: 'broken', name: '读不到的提供方' }],
  async listModels(id) {
    if (id === 'broken') throw new Error('offline')
    return id === 'deepseek' ? [{ id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }, { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' }] : [{ id: 'kimi-k3', name: 'Kimi K3' }]
  },
  async prepareCall() {
    return {
      config: {},
      async *stream({ messages }) {
        const { task } = messages[0].source
        const text = replies[task](messages[0].content[0].text)
        for (let i = 0; i < text.length; i += 24) {
          await new Promise(resolve => setTimeout(resolve, task === 'draft' ? 40 : 8))
          yield { type: 'text-delta', text: text.slice(i, i + 24) }
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  },
}

const services = {
  llm,
  agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-v4-pro' }) },
  connection: { requestRejection: () => undefined },
}
// 假的朱雀接口：密钥填 bad 报 401；含「不仅」的那行判 AI，含「值得一提」的判疑似，其余判人工
const fetchImpl = async (url, init) => {
  const send = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) })
  if (url === 'https://registry.npmjs.org/dsh-wechat-studio/latest' || url === 'https://registry.npmmirror.com/dsh-wechat-studio/latest') {
    return Response.json({ version: process.env.DEV_LATEST_VERSION || currentVersion })
  }
  if (url === 'https://ark.cn-beijing.volces.com/api/v3/images/generations') {
    // 94x40 纯色 PNG，够 saveCover 裁切；慢一点返回，让界面上的生成进度看得见
    await new Promise(resolve => setTimeout(resolve, Number(process.env.DEV_COVER_DELAY || 2500)))
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAF4AAAAoCAIAAAD4y9rlAAAAWUlEQVR4nO3QMQ0AIADAMPwrRAIfFjDAw8WOJhOwdOw1dW18P8iGBg0aNGjQNEODBg0aNGiaoUGDBg0aNM3QoEGDBg2aZmjQoEGDBk0zNGjQoEGDphkaNO8dEZFsmj6pfb8AAAAASUVORK5CYII='
    return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: png }] }) }
  }
  if (url === 'https://api.cloudinary.com/v1_1/demo/image/upload') {
    return Response.json({ secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/inline-demo.png' })
  }
  if (init.headers?.authorization === 'Bearer bad') return send(401, { error: { message: 'invalid api key' } })
  const lines = JSON.parse(init.body).text.split('\n').filter(line => line.trim())
  const segment_labels = lines.map((text, order) => ({ text, order, label: text.includes('不仅') ? 1 : text.includes('值得一提') ? 2 : 0, conf: text.includes('不仅') ? 0.97 : text.includes('值得一提') ? 0.71 : 0.9 }))
  return send(200, { status: 'success', labels_ratio: { 0: 0.62, 1: 0.21, 2: 0.17 }, segment_labels, makers_models_usage: { total_tokens: Math.round(JSON.parse(init.body).text.length * 1.2) } })
}
const handler = createHandler({ get: name => services[name] }, { fetchImpl })

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>公众号成稿台（本地预览）</title>
<style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div>
<script src="/react.js"></script><script src="/react-dom.js"></script>
<script>
window.__ModuleLoader__ = { load({ factory }) {
  const mod = factory(() => window.React)
  const slots = { inject: (name, fn) => fn(), register: (desc, Component) => { if (desc.name === 'main') ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Component)) } }
  mod.apply({ slots, effect: fn => fn() })
} }
</script><script src="/client.js"></script></body></html>`

const FILES = {
  '/react.js': 'node_modules/react/umd/react.development.js',
  '/react-dom.js': 'node_modules/react-dom/umd/react-dom.development.js',
  '/client.js': 'dist/client.js',
}

const port = Number(process.env.PORT || 4173)
createServer(async (req, res) => {
  const path = new URL(req.url, 'http://local').pathname
  if (path.startsWith('/wechat-studio')) return handler(req, res)
  if (FILES[path]) {
    res.setHeader('content-type', 'text/javascript; charset=utf-8')
    return res.end(await readFile(join(root, FILES[path])))
  }
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(PAGE)
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}`))
