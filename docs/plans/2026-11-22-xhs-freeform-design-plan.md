# 小红书 AI 自由视觉与差异化排版（Claude Design / OpenDesign 模式）实施计划（v2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让小红书图文派生具备 **Claude Design / OpenDesign** 的按篇定制视觉与每页差异化排版能力，同时在**生成 Token 预算、Shadow DOM + CSS 严格隔离、单页重设计并发写回、配色正交与 DOM 拓扑防重样代码验收、以及真实渲染导出**五条底层契约上做到工程级稳健：
1. **分阶段生成与现实容量预算**：先生成「笔记文案 + 全套版式蓝图 + 文章级 `customCss`」，再分批生成每页 HTML（`card.html + card.pageCss`）；单页失败只重试或回退该页，绝不因 8192 Token 截断而整套报错。
2. **Shadow DOM 物理隔离 + 白名单清洗**：每张交互画布运行在独立 Shadow DOM 中；HTML 标签/属性/内联样式走严格白名单，CSS 选择器强制重写限定在 `.xhs-artboard` 内并拦截一切外部资源请求（`url()`、`@import`、`@font-face`、`image-set()`）与 `position: fixed`，彻底杜绝污染宿主插件 UI。
3. **单页重设计双契约（`card.html + pageCss` + 并发版本保护）**：单页重设计允许同时返回该页专属 `pageCss`；写回时在 `store.update` 中基于最新状态**只局部替换目标页**，校验 `baseCardHash` 防止覆盖生成期间用户对其他页或本页的新修改。
4. **代码级「配色正交」与「DOM 拓扑骨架防重样」验收**：代码扫描非中性硬编码颜色并提示/归一化为 CSS 变量；通过忽略文本、class 与内联样式后的 **DOM 拓扑签名（`computeDomTopologySignature`）** 检测重复版式，撞车时仅对重复页触发单页重设计。
5. **自定义 HTML 金句 `sourceOverlap` 校验与真实渲染/PNG IHDR 端到端验收**：对自定义 HTML 金句卡同样执行原文二元组重合度检查，并通过真实浏览器/Canvas 验证 Shadow DOM 样式隔离、离线图片降级、`1080×1440` PNG 头尺寸与并发编辑保留。

**Implementation Order（先单页闭环，再整套分阶段生成）：**
- **Task 1**：底层安全清洗、CSS 作用域重写、DOM 拓扑签名、硬编码颜色检测与容量预算（`src/derive-shared.js`）
- **Task 2**：Shadow DOM 画布隔离、纯粹配色主题恢复、`customCss + pageCss` 注入与离线安全 PNG 导出（`client/xhs-card-html.js` & `client/xhs-card-render.js`）
- **Task 3**：单页重设计（`redesignXhsCard`）协议、页面级 `pageCss` 与并发局部写回保护（`src/derive.js`、`src/host.js`、`client/state.js`）
- **Task 4**：分阶段整套自由生成（Stage 1 蓝图+文案+`customCss` → Stage 2 分页 HTML 生成 → DOM 拓扑查重与单页定向修复，`skills/repurpose-xhs.md` & `src/derive.js`）
- **Task 5**：前端「设计想法（快捷标签+自由输入）」+ 单页「✨ 重设计此页」草稿合并 + 纯粹配色切换（`client/derive.jsx`、`client/styles.css`、`scripts/dev.mjs`）
- **Task 6**：真实浏览器渲染、Shadow DOM 隔离、PNG `1080×1440` IHDR 二进制校验与并发编辑保留端到端验收

**Tech Stack:** Node.js `>=20` ESM、React 18（esbuild 打包至 `dist/client.js`）、Shadow DOM、SVG `<foreignObject>` + Canvas 2D、`node:test`、`node:assert/strict`。

## Global Constraints

- **零运行时依赖**：不引入任何第三方 npm 依赖，`npm run check:package` 必须通过。
- **不改排版引擎**：严禁修改 `vendor/layout/*`。
- **浏览器安全边界**：`src/derive-shared.js`、`client/xhs-card-html.js`、`client/xhs-dom-inspector.js`、`client/xhs-card-layout.js`、`client/zip.js` 禁止任何 `node:*` 导入。
- **现实容量预算**：
  - 单页 `card.html` ≤ `6,000` 字符（`DERIVE_LIMITS.xhs.cardHtml = 6000`）
  - 单页 `card.pageCss` ≤ `2,000` 字符（`DERIVE_LIMITS.xhs.pageCss = 2000`）
  - 文章级 `customCss` ≤ `4,000` 字符（`DERIVE_LIMITS.xhs.customCss = 4000`）
  - 整套卡片 `html + pageCss + customCss` 总量 ≤ `48,000` 字符（`DERIVE_LIMITS.xhs.totalDeckMarkup = 48000`）
- **测试命令**：`export PATH="/opt/homebrew/opt/nodejs/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" && npm test`

---

### Task 1: HTML/CSS 白名单清洗、CSS 作用域重写、DOM 拓扑签名与色彩正交检查（`src/derive-shared.js`）

**Files:**
- Modify: `src/derive-shared.js`
- Test: `test/derive-shared.test.js`

**Interfaces & Rules:**
1. **恢复 6 套纯粹配色主题 ID**：
   - `XHS_STYLE_PRESETS = ['claude', 'editorial', 'tech', 'emerald', 'bold', 'theme']`（若历史数据传入 `'manual' | 'notebook' | 'chalkboard'`，在 `normalizeXhsTweaks` 中平滑映射为 `'editorial'` 或 `'claude'`）。
2. **HTML 标签、属性与内联样式白名单（`sanitizeXhsCardHtml(rawHtml)`）**：
   - **允许标签白名单**：`div, span, p, h1, h2, h3, h4, h5, h6, strong, b, em, i, u, s, mark, small, sub, sup, code, pre, blockquote, ul, ol, li, dl, dt, dd, table, thead, tbody, tfoot, tr, th, td, hr, br, img, svg, g, path, rect, circle, ellipse, line, polyline, polygon`。
     - `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`, `<form>`, `<svg><foreignObject>` 等整块剥离；其余不在白名单中的标签剥离标签外壳。
   - **允许属性白名单**：`class, style, src, alt, title, width, height, colspan, rowspan, viewBox, fill, stroke, stroke-width, stroke-linecap, stroke-linejoin, d, cx, cy, r, rx, ry, x, y, x1, y1, x2, y2, points, opacity, transform` 以及 `data-xhs-*`、`data-img-*`。
     - 拒绝一切 `on*`、`href`、`xlink:href`、`srcdoc`、`formaction` 属性；
     - `img[src]` 必须通过 `sanitizeCardImageUrl(src)` 校验，不合法则移除 `src`。
   - **内联 `style` 清洗（`sanitizeInlineStyle(styleStr)`）**：
     - 剔除含 `url(...)`、`image-set(...)`、`expression(...)`、`javascript:`、`vbscript:`、`-moz-binding`、`behavior` 的声明；
     - 将 `position:\s*fixed` 强制替换为 `position:absolute`。
   - 单卡截断上限：`DERIVE_LIMITS.xhs.cardHtml = 6000`。
3. **CSS 作用域强制重写与白名单清洗（`sanitizeXhsCss(rawCss, { scope = '.xhs-artboard', maxChars = 4000 } = {})`）**：
   - 剥离 `<style>` 标签、注释、`@import`、`@font-face`、`@charset`、`@namespace`；
   - 剥离任何含 `url(...)`、`image-set(...)`、`expression(...)`、`javascript:`、`vbscript:` 的属性值；将 `position:\s*fixed` 替换为 `position:absolute`；
   - **选择器强制限定在 `.xhs-artboard` 内**：
     - 解析每条 CSS 规则 `selectors { declarations }`；
     - 将选择器列表按逗号拆分，对每个子选择器：
       - 若为 `body`、`html`、`:root`、`:host` 或 `*`，重写为 `${scope}`（或 `${scope} *`）；
       - 若已以 `${scope}` 开头则保持，否则前置 `${scope} `（如 `.my-box` → `.xhs-artboard .my-box`）；
     - 丢弃未闭合或声明为空的规则，总长度限制在 `maxChars`。
4. **色彩正交检测（`findHardcodedBrandColors(cssOrHtml)`）**：
   - 允许的中性色与语义功能色白名单：`#fff/#ffffff`, `#000/#000000`, `#0a0a0a`–`#2e3247`（深浅灰黑阶）、`#f1f1f6`–`#fcfbf6`（浅灰/纸白底阶）、`#e4e4ee`（边框灰）、状态绿（`#15803d`, `#16a34a`, `#e5f7ed`, `#27c93f`）、警示红（`#e11d48`, `#fff1f0`, `#ff5f56`）、窗口黄（`#ffbd2e`）。
   - 返回不属于中性/语义白名单且未使用 `var(--xhs-*)` 的硬编码十六进制色值列表；在 `normalizeXhs` 中若检测到硬编码主色，记入 `warnings`（`第 X 页存在硬编码色彩，切换配色主题时可能不联动`）。
5. **DOM 拓扑骨架签名（`computeDomTopologySignature(html)`）**：
   - 忽略所有文本内容、内联 `style` 与普通装饰 class，仅提取 DOM 结构特征：
     - 识别结构性语义地标（`table`、`col-grid-2`/`col-grid-3`、`kv-grid`、`step-list`、`shot-window`/`slot`、`quote-block`、`dark-panel`、`sticky-note`）与标签嵌套树骨架（如 `div>table+div+div>div*2`）；
     - 返回归一化的拓扑签名字符串，供生成阶段与 `normalizeXhs` 判断不同页面是否“换了 class 名但 DOM 拓扑完全雷同”。
   - 在 `normalizeXhs` 中：若中间页（不含 `cover` 和 `end`）的 `computeDomTopologySignature` 出现相邻两页签名完全相同，或中间页总签名种类 `< 2`，记入 `warnings` 并暴露重复页索引 `duplicateTopologyPages`。
6. **自定义 HTML 金句 `sourceOverlap` 校验与 `<xhs-deck>` 解析器**：
   - 在 `normalizeXhs` 中：当 `kind === 'quote'` 且带有 `card.html` 时，提取 `stripHtmlToText(card.html)`（剔除短角标 `badge` 与页码 `02 / 07` 后）与 `sourceText` 计算 `sourceOverlap`，低于 `0.6` 时同样触发 `第 X 页金句偏离原文较多` 告警！
   - 新增 `parseXhsDeckMarkup(rawText)` 與 `parseSingleXhsCardMarkup(rawText)`：解析 `<xhs-meta>`、`<xhs-style>`、`<xhs-card>` 与 `<xhs-page-style>` 标签块。
   - 在 `normalizeXhs` 中校验整套卡片 `customCss + sum(card.html + card.pageCss)` ≤ `DERIVE_LIMITS.xhs.totalDeckMarkup`（48,000 字符），超限时按比例裁剪或报错。

- [ ] **Step 1: 在 `test/derive-shared.test.js` 编写失败测试**
  - 测试 `sanitizeXhsCss` 将 `body { display:none } * { color:red } .hero { background: url(//evil.com/a.png); position: fixed; border: 1px solid var(--xhs-accent); }` 重写为仅作用在 `.xhs-artboard` 内且不含 `url()` 与 `fixed` 的安全 CSS；
  - 测试 `sanitizeXhsCardHtml` 过滤 `<script>`、`<style>`、`<iframe>`、`onclick`、`href="javascript:..."`、非法 `img[src]` 及内联 `style="background:image-set(...)"`；
  - 测试 `computeDomTopologySignature` 能识别出「虽然 class 名不同但 DOM 拓扑完全相同」的两张卡片，以及区分「表格+横幅」与「2×2 网格」两种不同拓扑；
  - 测试带自定义 `html` 的 `quote` 卡偏离原文时触发 `金句偏离原文较多` 告警；
  - 测试 `parseXhsDeckMarkup` 与 `parseSingleXhsCardMarkup`。
- [ ] **Step 2: 运行测试确认失败** — `node --test test/derive-shared.test.js`
- [ ] **Step 3: 在 `src/derive-shared.js` 实现上述功能**
- [ ] **Step 4: 运行测试确认通过** — `node --test test/derive-shared.test.js`

---

### Task 2: Shadow DOM 交互画布隔离、纯粹配色主题恢复与离线安全 PNG 导出（`client/xhs-card-html.js` & `client/xhs-card-render.js`）

**Files:**
- Modify: `client/xhs-card-html.js`
- Modify: `client/xhs-card-render.js`
- Test: `test/xhs-card-html.test.js`

**Interfaces & Rules:**
1. **`client/xhs-card-html.js`**：
   - `XHS_STYLE_PRESETS` 恢复为 6 套纯粹的**配色主题**（`claude`、`editorial`、`tech`、`emerald`、`bold`、`theme`），不再将 `preset` 绑死到单一的说明书/备课本/黑板内页模板；
   - `XHS_ARTBOARD_CSS` 同时保留 `.cd-*`、`.mn-*`、`.nb-*`、`.cb-*` 等丰富原子与装饰组件类，作为 AI 自由组合每页 HTML 时的基础样式库；
   - 新增 `buildCardStyleText({ customCss = '', pageCss = '' })`：返回 `XHS_ARTBOARD_CSS + '\n' + sanitizeXhsCss(customCss) + '\n' + sanitizeXhsCss(pageCss)`。
2. **`client/xhs-card-render.js`**：
   - `renderCardToBlob(card, opts)` 接收 `opts.customCss` 并读取 `card.pageCss`，通过 `buildCardStyleText({ customCss: opts.customCss, pageCss: card.pageCss })` 注入 SVG `<foreignObject>` 内部的 `<style>`；
   - 强化外部图片离线/超时降级：当 `<img src="https://...">` 在离线或超时（2.5s）无法转 DataURL 时，自动替换为优雅的内置占位块且绝不污染 Canvas，确保离线环境下 100% 导出有效的 `1080×1440` PNG。

- [ ] **Step 1: 更新 `test/xhs-card-html.test.js` 编写测试**
  - 验证 6 套纯粹配色主题、`buildCardStyleText` 对 `customCss` 与 `pageCss` 的作用域隔离合并、以及 8 种 `kind` 具有各自不同的 DOM 拓扑签名（`computeDomTopologySignature` 互不相同）。
- [ ] **Step 2: 修改 `client/xhs-card-html.js` 与 `client/xhs-card-render.js`**
- [ ] **Step 3: 运行测试确认通过** — `node --test test/xhs-card-html.test.js`

---

### Task 3: 单页重设计（`redesignXhsCard`）协议、`card.html + pageCss` 与并发局部写回保护（`src/derive.js`、`src/host.js`、`client/state.js`）

**Files:**
- Modify: `src/derive.js`
- Modify: `src/host.js`
- Modify: `client/state.js`
- Test: `test/derive.test.js`、`test/derive-routes.test.js`

**Interfaces & Rules:**
1. **单页重设计协议（`redesignXhsCard` in `src/derive.js`）**：
   - 入参：`{ id, cardIndex, cardPrompt = '', baseCardHash = '', root }`
   - 新增 `computeCardHash(card) -> string`（对目标页的 `kind, heading, badge, accent, callout, lines, imageUrl, html, pageCss` 计算 SHA-256 前 16 位指纹，也在 `src/derive-shared.js` 提供纯 JS 版本 `cardContentVersion(card)` 供前端传参）。
   - Prompt 构造：
     - 输入母稿段落 `blocks`、整套卡片的 `customCss`、**其余页面的布局拓扑与标题摘要（明确要求新设计的这一页不得与相邻页使用相同的 DOM 拓扑结构）**、当前第 `cardIndex + 1` 页的原始信息、以及用户输入的 `cardPrompt`（若为空，则指令为“换一种更有设计感、视觉层次更丰富的排版结构重新设计此页”）；
     - 要求模型只输出单个页面的标签块：
       ```html
       <xhs-page-style>/* 可选：仅作用于当前页的补充 CSS，使用 var(--xhs-*) 变量 */</xhs-page-style>
       <xhs-card kind="..." heading="..." badge="..." accent="..." callout="..." source="...">
         <!-- 1080×1440 .xhs-artboard 内部 HTML -->
       </xhs-card>
       ```
   - **并发安全的局部写回（Store Transaction）**：
     - 在模型返回后进入 `store.update(state => ...)` 时，**重新读取数据库中最新的 `article.derivatives.xhs`**；
     - 校验目标页 `cards[cardIndex]`：若调用方传入了 `baseCardHash`，且数据库最新 `cards[cardIndex]` 的版本与 `baseCardHash` 不一致，抛出 `409 Conflict`（`该页卡片在重设计期间已被修改，请刷新后重试`，附带 `code: 'card_conflict'`），绝不静默覆盖！
     - 若校验通过，**仅替换 `latest.payload.cards[cardIndex]`**（写入新的 `html`、`pageCss` 及更新后的字段，同时保留原有的 `imageFraming` 和未变更的 `imageUrl`），**100% 保留其他页（`i !== cardIndex`）在生成期间可能发生的新修改与保存结果**！
     - 重新运行 `normalizeXhs(nextPayload, { blockIds, sourceText, status: 502, strictCardLength: false })` 更新 `warnings` 与 `editedAt`。
2. **宿主路由与前端状态（`src/host.js` & `client/state.js`）**：
   - `POST /wechat-studio/derive/redesign-card`：与 `derive/generate` 共用文章级 `deriveLocks` 互斥锁；
   - `client/state.js` 新增 `redesignXhsCard({ id, cardIndex, cardPrompt, baseCardHash })`：
     - 请求成功后，若前端 `deriveDrafts[deriveDraftKey(id, 'xhs')]` 存在其它页的未保存草稿，**只将服务端返回的最新 `cards[cardIndex]` 合并进本地草稿的 `cards[cardIndex]`**，绝不丢弃用户在等待 AI 返回期间对第 3 页、第 4 页或笔记正文所做的未保存编辑！

- [ ] **Step 1: 在 `test/derive.test.js` 和 `test/derive-routes.test.js` 编写失败测试**
  - 测试 `redesignXhsCard` 解析 `<xhs-page-style>` + `<xhs-card>`，产出 `card.html` 与作用域隔离的 `card.pageCss`；
  - 测试并发写回保护：在 `redesignXhsCard` 模型流式返回期间，模拟用户修改并保存了第 3 页，验证 `redesignXhsCard` 完成后第 2 页更新为新设计、且第 3 页的新修改完好无损；
  - 测试当第 2 页自身在生成期间被抢先修改且 `baseCardHash` 不匹配时返回 409。
- [ ] **Step 2: 运行测试确认失败** — `node --test test/derive.test.js test/derive-routes.test.js`
- [ ] **Step 3: 实现 `redesignXhsCard`、路由 `derive/redesign-card` 与前端局部草稿合并逻辑**
- [ ] **Step 4: 运行测试确认通过** — `node --test test/derive.test.js test/derive-routes.test.js`

---

### Task 4: 分阶段整套自由生成与 DOM 拓扑查重定向修复（`skills/repurpose-xhs.md` & `src/derive.js`）

**Files:**
- Modify: `skills/repurpose-xhs.md`
- Modify: `src/derive.js`
- Test: `test/derive.test.js`

**Interfaces & Rules:**
1. **分阶段生成流水线（解决单次 8192 Token 预算不足问题）**：
   - **Stage 1 — 整套视觉企划、文案与蓝图（1 次模型调用，`maxTokens: 4096`）**：
     - 根据母稿 `blocks`、`images` 以及用户可选输入的 `designPrompt`（设计想法），输出：
       - `<xhs-meta>`：`title`（≤20字）、`body`（300–700字）、`tags`（3–10个）、`tweaks.preset`（6 套配色主题之一）以及 5–8 页的**结构化分镜蓝图 `cards`**（每页包含 `kind`、各不相同的 `layoutArchetype` 如 `hero-cover | before-after-table | step-flow-timeline | kpi-dashboard | terminal-sticky | dual-column-clash | bento-matrix | dark-checklist-end`、`badge`、`heading`、`accent`、`lines`、`callout`、`tags`、`imageUrl`、`source`）；
       - `<xhs-style>`：为当前文章量身定制的 `customCss`（≤ 4,000 字符，所有颜色使用 `var(--xhs-*)` 变量）。
     - 若模型在 Stage 1 已经顺带输出了完整的 `<xhs-card>` HTML 且未截断、通过校验，则直接进入查重阶段（兼容单次高速返回与测试 Mock）。
   - **Stage 2 — 分批生成每页自由 HTML（按每批 2–3 页调用，`maxTokens: 4096`）**：
     - 对尚未生成自定义 `html` 的卡片，按每批 2–3 页传入该页的蓝图、`layoutArchetype`、`customCss` 与相邻页已用结构，生成每页专属的 `<xhs-card page="N">...</xhs-card>`（及可选 `<xhs-page-style page="N">`）；
     - **单页容错兜底**：若某批或某页 HTML 解析失败，只对该页单独重试一次；若仍失败，仅该页回退使用 `synthesizeCardHtml(card)`，绝不丢弃整套已生成的文案与其他页成果！
   - **Stage 3 — DOM 拓扑骨架查重与定向单页重设计**：
     - 用 `computeDomTopologySignature(card.html)` 检查所有中间页；
     - 若发现相邻两页 DOM 拓扑签名完全一致，自动对重复页调用一次 `redesignSingleCardInternal` 要求换用未使用的布局拓扑（如表格、双栏对撞、时间轴、便利贴+指令框、2×2 仪表盘）。

- [ ] **Step 1: 在 `test/derive.test.js` 编写分阶段生成与拓扑查重修复测试**
  - 测试 Stage 1 蓝图 + Stage 2 分批 HTML 合成完整落盘，且总体积受 `totalDeckMarkup` 约束；
  - 测试当 Stage 2 某两张中间页返回了相同 DOM 拓扑（虽然 class 名不同）时，自动触发针对重复页的单页重设计并消除重复。
- [ ] **Step 2: 运行测试确认失败** — `node --test test/derive.test.js`
- [ ] **Step 3: 更新 `skills/repurpose-xhs.md` 与 `src/derive.js` 实现分阶段生成与查重修复**
- [ ] **Step 4: 运行测试确认通过** — `node --test test/derive.test.js`

---

### Task 5: 前端 Shadow DOM 画布组件、「设计想法（快捷标签+自由输入）」工具栏与单页「✨ 重设计此页」（`client/derive.jsx`、`client/styles.css`、`scripts/dev.mjs`）

**Files:**
- Modify: `client/derive.jsx`
- Modify: `client/styles.css`
- Modify: `scripts/dev.mjs`

**UI & UX Details:**
1. **`<XhsArtboardShadow>` Shadow DOM 隔离画布容器（`client/derive.jsx`）**：
   - 为每张卡片创建独立的 Shadow Root（`attachShadow({ mode: 'open' })`）；
   - Shadow Root 内部挂载 `<style>{buildCardStyleText({ customCss: draft.customCss, pageCss: card.pageCss })}</style>` 与 `<div class="xhs-artboard ..." style={themeVars}>`；
   - `artboardRefs.current[index]` 指向 Shadow Root 内的 `.xhs-artboard` 元素，使得点击拾取元素（使用 `event.composedPath()` 穿透 Shadow DOM 精确命中 `[data-cd-id]`）、蓝色四角选中框、`Properties` 面板实时改字/改样式、以及按住插图左右拖拽平移全部无缝工作！
2. **顶部常驻「设计想法（可选）」输入栏（`.ws-cd-prompt-bar`）**：
   - 包含 6 个预设快捷灵感标签（点击可切换选中/追加到输入框）：
     - `+ 工具说明书感（大数字+黑框表）`
     - `+ 手账批注感（红笔圈画+便利贴）`
     - `+ 极客终端感（命令行+架构看板）`
     - `+ 瑞士杂志画报（粗黑大字+几何网格）`
     - `+ 课堂黑板板书（粉笔字+磁吸白卡）`
     - `+ 多用对比表与数据指标卡`
   - 自由文本输入框：可输入任何个性化排版要求，留空则由 AI 根据文章内容自主设计；
   - 点击「生成小红书图文」或「重新生成」时携带 `designPrompt`。
3. **单页「✨ 重设计此页」控制栏**：
   - 在右侧 `Properties` 面板顶部（以及每张卡片右上角 `✨` 快捷按钮）提供单页重设计输入框与 **「✨ 重设计此页」** 按钮；
   - 重设计进行中仅锁定该页重设计按钮，用户仍可自由浏览或编辑其他页；返回后仅局部更新该页草稿。
4. **纯粹配色切换**：
   - 顶部「配色主题」下拉框与 `Tweaks` 面板中的 6 套配色主题只更新 `tweaks.preset` CSS 变量，**绝不覆盖或重置 `card.html`**。

- [ ] **Step 1: 修改 `client/derive.jsx`、`client/styles.css` 与 `scripts/dev.mjs`**
- [ ] **Step 2: 构建前端 bundle 并运行单元测试** — `npm run build && npm test`

---

### Task 6: 真实浏览器渲染、Shadow DOM 隔离、离线 PNG IHDR 校验与并发编辑保留端到端验收

**Files:**
- Create or Modify: `test/xhs-e2e-verify.test.js`（或通过真实服务 + 浏览器/Canvas 端到端测试）

**Verification Checklist:**
- [ ] **1. Shadow DOM 恶意 CSS 隔离验收**：传入 `customCss: "body { display: none !important; } .ws-derive-bar { opacity: 0 !important; } .custom-box { border: 3px solid var(--xhs-accent); }"`，验证宿主页面 `body` 与 `.ws-derive-bar` 的计算样式不受任何影响，而 Shadow Root 内的 `.custom-box` 边框样式正常生效。
- [ ] **2. 离线/不可达外部图片降级导出验收**：卡片包含指向不可达端口 `https://127.0.0.1:1/ dead.png` 的 `<img>`，验证导出 PNG 不卡死、不抛 Canvas Tainted 错误，在超时内成功产出 PNG。
- [ ] **3. PNG 与 ZIP 二进制格式及 `1080×1440` IHDR 尺寸校验**：解析导出的 PNG / `.zip` 中每张图片的 PNG 签名（`89 50 4E 47 0D 0A 1A 0A`）与 `IHDR` 块宽高（`width === 1080`, `height === 1440`）。
- [ ] **4. 单页重设计并发编辑不丢稿验收**：启动第 2 页 `derive/redesign-card`，在等待返回期间修改第 3 页文案/草稿，验证返回后第 2 页更新为新 HTML + `pageCss`，第 3 页修改完整保留。
- [ ] **5. 全量检查与提交**：`npm run build && npm test && npm run check:package` 全部通过并提交 Git。
