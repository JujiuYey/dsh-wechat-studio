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
    const meta = {
      deckStyle: 'tech',
      tweaks: { preset: 'claude' },
      title: '排版外包给 AI 后真香',
      body: '以前写完一篇文章，最消耗耐心的反而是最后半小时的排版调样式。后来我干脆把排版固定成一条流水线：写完 Markdown 直接导出成稿，不再手动调字号、行距和配色。这套流程最大的好处是稳定，不用每次重来，也不必纠结样式细节，欢迎自取尝试。',
      tags: ['内容创作', '公众号排版', '效率工具', 'Markdown'],
      cards: [
        { kind: 'cover', layoutArchetype: 'editorial-hero-band', badge: '排版流水线 · 实测有效', heading: '别再手动调排版了', accent: '写完 Markdown 一键出稿', lines: ['样式表自动锁定 | 零手工返工'], tags: ['主题固定', '代码块对齐', '体检清单', '一次过稿'], source: ids.slice(0, 1) },
        { kind: 'compare', layoutArchetype: 'before-after-table', badge: '前后对比', heading: '手调排版 vs 流水线出稿', lines: ['以前手调 | 写完再调字号、行距、配色，半小时起', '现在自动 | 丢进固定主题模板，30 秒直接定稿'], callout: '核心不是工具多花哨，而是把风格先写死。', source: ids.slice(0, 2) },
        { kind: 'steps', layoutArchetype: 'manual-giant-steps', badge: '三步跑通', heading: '固定排版的三个动作', lines: ['锁定样式表 | 确定主色、圆角与字号比例', '结构化渲染 | 标题、引用块、代码块自动配齐', '导出前体检 | 过一遍图片比例和结尾固定行'], callout: '写完正文的精力留给内容本身，不再耗在格式细节。', source: ids.slice(1, 3) },
        { kind: 'metrics', layoutArchetype: 'kpi-telemetry-board', badge: '实测变化', heading: '切流水线后的真实变化', lines: ['30s | 单篇导出耗时 | 比手动缩短 90%', '0 次 | 格式返工次数 | 粘贴进后台不跑版', '100% | 多平台复用 | 一稿直出即刻与小红书'], source: ids.slice(1, 3) },
        { kind: 'grid', layoutArchetype: 'asymmetric-bento-quad', badge: '四个省心点', heading: '用起来最稳的四个设计', lines: ['主题隔离 | 一键切换配色不改内容', '配图留档 | 首图与插图集中追踪状态', '派生长出 | 串推与卡片共用母稿锚点', '本地草稿 | 切 Tab 不丢未保存编辑'], source: ids.slice(1, 3) },
        { kind: 'end', layoutArchetype: 'dark-action-checklist', badge: '抄作业清单', heading: '用好这条工作流的 3 个原则', lines: ['先定规则 | 选定一套主题后坚持用 10 篇以上', '再做派生 | 先过母稿结构，再一键拆出社媒卡片', '最后复核 | 发前花 1 分钟对照体检提醒逐条打钩'], callout: '先收藏，下次写完长文直接按这套步骤出稿', source: [] },
      ],
    }
    return `<xhs-meta>${JSON.stringify(meta)}</xhs-meta>
<xhs-style>
.dev-kicker { display:inline-flex; align-items:center; gap:10px; font-size:22px; font-weight:800; color:var(--xhs-accent); letter-spacing:0.06em; }
.dev-hero-box { background:var(--xhs-dark); color:#FFFFFF; border-radius:var(--xhs-radius); padding:34px; display:flex; flex-direction:column; gap:18px; flex:1; justify-content:space-between; }
.dev-split { display:grid; grid-template-columns:1.15fr 0.85fr; gap:18px; flex:1; }
</xhs-style>`
  },
  'derive-xhs-cards': user => {
    const req = JSON.parse(user)
    const styleNote = [
      req.designPrompt ? req.designPrompt.slice(0, 14) : '',
      req.referenceImageCount ? `参考图×${req.referenceImageCount}` : '',
    ].filter(Boolean).join(' · ')
    const styleSuffix = styleNote ? ` · ${styleNote}` : ''
    const byPage = {
      1: `<xhs-card page="1" kind="cover" heading="别再手动调排版了">
  <div class="cd-header"><div class="dev-kicker">实测复盘${styleSuffix}</div><h1 class="cd-title-xl">别再手动调<span class="cd-hl">排版</span>了</h1><p class="cd-sub">写完 Markdown 一键出稿，样式表自动锁定</p></div>
  <div class="cd-main">
    <div class="dev-hero-box">
      <div style="font-size:22px; color:var(--xhs-accent-line); font-weight:800;">EDITORIAL PIPELINE · 01</div>
      <div style="font-size:44px; font-weight:900; line-height:1.25;">好排版，是让读者根本感觉不到排版。</div>
      <div class="cd-code-strip"><span class="cd-code-pill">主题固定</span><span class="cd-code-pill">代码块对齐</span><span class="cd-code-pill">一次过稿</span></div>
    </div>
  </div>
  <div class="cd-footer"><span>@林月半子 · 实操复盘</span><span>左滑看对比 →</span></div>
</xhs-card>`,
      2: `<xhs-card page="2" kind="compare" heading="手调排版 vs 流水线出稿">
  <div class="cd-header"><div class="dev-kicker">02 / 前后对比</div><h2 class="cd-title">手调排版 vs 流水线出稿</h2></div>
  <div class="cd-main">
    <div class="cd-table-card"><table class="cd-table"><thead><tr><th>方式</th><th>耗时与痛点</th></tr></thead><tbody><tr><td class="is-bold">以前手调</td><td>写完再调字号、行距、配色，半小时起</td></tr><tr><td class="is-bold">现在自动</td><td>丢进固定主题模板，30 秒直接定稿</td></tr></tbody></table></div>
    <div class="cd-callout"><div class="cd-callout-line">核心不是工具多花哨，而是把风格先写死。</div></div>
  </div>
  <div class="cd-footer"><span>@林月半子</span><span>02 / 06</span></div>
</xhs-card>`,
      3: `<xhs-card page="3" kind="steps" heading="固定排版的三个动作">
  <div class="cd-header"><div class="mn-topbar"><span>实操步骤</span><span>03 / 06</span></div><h2 class="cd-title">固定排版的三个动作</h2></div>
  <div class="cd-main">
    <ol class="cd-step-list" style="list-style:none;">
      <li class="cd-step-item"><span class="cd-step-num">1</span><div class="cd-step-content"><div class="cd-step-title">锁定样式表</div><div class="cd-step-desc">确定主色、圆角与字号比例</div></div></li>
      <li class="cd-step-item"><span class="cd-step-num">2</span><div class="cd-step-content"><div class="cd-step-title">结构化渲染</div><div class="cd-step-desc">标题、引用块、代码块自动配齐</div></div></li>
      <li class="cd-step-item"><span class="cd-step-num">3</span><div class="cd-step-content"><div class="cd-step-title">导出前体检</div><div class="cd-step-desc">过一遍图片比例和结尾固定行</div></div></li>
    </ol>
  </div>
  <div class="cd-footer"><span>@林月半子</span><span>03 / 06</span></div>
</xhs-card>`,
      4: `<xhs-card page="4" kind="metrics" heading="切流水线后的真实变化">
  <div class="cd-header"><div class="dev-kicker">04 / REAL DATA</div><h2 class="cd-title">切流水线后的真实变化</h2></div>
  <div class="cd-main">
    <div class="dev-split">
      <div class="cd-bento is-tint"><span class="cd-metric-label">单篇导出耗时</span><div class="cd-metric-num">30s</div><span class="cd-metric-sub">比手动缩短 90%</span></div>
      <div style="display:flex; flex-direction:column; gap:16px;">
        <div class="cd-bento" style="flex:1;"><span class="cd-metric-label">格式返工次数</span><div class="cd-metric-num">0 次</div></div>
        <div class="cd-bento" style="flex:1;"><span class="cd-metric-label">多平台复用</span><div class="cd-metric-num">100%</div></div>
      </div>
    </div>
  </div>
  <div class="cd-footer"><span>@林月半子</span><span>04 / 06</span></div>
</xhs-card>`,
      5: `<xhs-card page="5" kind="grid" heading="用起来最稳的四个设计">
  <div class="cd-header"><div class="dev-kicker">05 / HIGHLIGHTS</div><h2 class="cd-title">用起来最稳的四个设计</h2></div>
  <div class="cd-main">
    <div class="cd-col-grid" style="--cols:2;">
      <div class="cd-bento"><strong class="cd-bento-title">主题隔离</strong><p class="cd-bento-body">一键切换配色不改内容</p></div>
      <div class="cd-bento"><strong class="cd-bento-title">配图留档</strong><p class="cd-bento-body">首图与插图集中追踪状态</p></div>
      <div class="cd-bento"><strong class="cd-bento-title">派生长出</strong><p class="cd-bento-body">串推与卡片共用母稿锚点</p></div>
      <div class="cd-bento"><strong class="cd-bento-title">本地草稿</strong><p class="cd-bento-body">切 Tab 不丢未保存编辑</p></div>
    </div>
  </div>
  <div class="cd-footer"><span>@林月半子</span><span>05 / 06</span></div>
</xhs-card>`,
      6: `<xhs-card page="6" kind="end" heading="用好这条工作流的 3 个原则">
  <div class="cd-header"><span class="cd-accent-pill">抄作业清单</span><h2 class="cd-title">用好这条工作流的 3 个原则</h2></div>
  <div class="cd-main">
    <div class="cd-card cd-grow"><p class="cd-bento-body">1. 先定规则：选定一套主题坚持用 10 篇以上</p><p class="cd-bento-body">2. 再做派生：先过母稿再拆社媒卡片</p><p class="cd-bento-body">3. 最后复核：发前花 1 分钟对照体检提醒打钩</p></div>
  </div>
  <div class="cd-footer"><span>@林月半子</span><span>06 / 06</span></div>
</xhs-card>`,
    }
    return (req.targetCards || []).map(c => byPage[c.page] || '').filter(Boolean).join('\n')
  },
  'derive-xhs-card': user => {
    const req = JSON.parse(user)
    const page = req.page || 1
    const heading = req.targetCard?.heading || `第 ${page} 页重设计`
    const note = [
      req.cardPrompt ? `按想法「${req.cardPrompt}」重设计` : '全新差异化排版构图',
      req.referenceImageCount ? `参考图×${req.referenceImageCount}` : '',
    ].filter(Boolean).join(' · ')
    return `<xhs-page-style page="${page}">
.redesign-banner { background: var(--xhs-dark); color: #FFFFFF; padding: 26px 30px; border-radius: var(--xhs-radius); display: flex; justify-content: space-between; align-items: center; }
.redesign-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; flex: 1; }
</xhs-page-style>
<xhs-card page="${page}">
  <div class="cd-header"><span class="cd-accent-pill">✨ 单页重设计 · 第 ${page} 页</span><h2 class="cd-title">${heading}</h2><p class="cd-sub">${note}</p></div>
  <div class="cd-main">
    <div class="redesign-banner"><strong>全新信息层级</strong><span>0${page} / REDESIGN</span></div>
    <div class="redesign-cols">
      <div class="cd-bento is-tint"><strong class="cd-bento-title">核心要点</strong><p class="cd-bento-body">${(req.targetCard?.lines || ['关键动作拆解'])[0]}</p></div>
      <div class="cd-bento"><strong class="cd-bento-title">落地提醒</strong><p class="cd-bento-body">${req.targetCard?.callout || '配色主题完全正交，可随时切换换肤'}</p></div>
    </div>
  </div>
  <div class="cd-footer"><span>已局部重设计（其他页未动）</span><span>0${page}</span></div>
</xhs-card>`
  },
}

const llm = {
  listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'kimi', name: 'kimi-coding' }, { id: 'broken', name: '读不到的提供方' }],
  async listModels(id) {
    if (id === 'broken') throw new Error('offline')
    return id === 'deepseek'
      ? [
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', inputModalities: ['text', 'image'] },
        { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', inputModalities: ['text'] },
      ]
      : [{ id: 'kimi-k3', name: 'Kimi K3', inputModalities: ['text', 'image'] }]
  },
  async prepareCall() {
    return {
      config: {},
      async *stream({ messages }) {
        const { task } = messages[0].source
        const parts = Array.isArray(messages[0].content) ? messages[0].content : []
        const userText = parts.find(p => p?.type === 'text')?.text ?? String(messages[0].content ?? '')
        const text = replies[task](userText)
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
