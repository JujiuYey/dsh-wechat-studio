# 排版预览：信息流卡片模拟（Feed Card Preview）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 DSH 插件的「排版预览」视图中新增轻量切换（`正文预览` | `信息流卡片`），按微信发表预览截图进行视觉模拟，展示「订阅号信息流大图卡」与「转发给好友卡片」，帮助作者在发稿前即时检查 `375px` / `414px` 屏宽下的封面构图、标题二行断句与摘要截断效果，并确保预览所使用的标题、摘要、封面与真实草稿箱推送逻辑保持同一数据源。

**Architecture:**
- 严格保持 `vendor/layout/layout.js` 的 `renderPage` 逐字节不变。
- 新增零依赖共享模块 `src/wechat-meta.js`，统一提供 `MAX_TITLE`、`MAX_DIGEST`、`deriveDigest(article)` 与 `latestCover(article)`，供后端草稿推送（`src/wechat.js`）与前端卡片数据模型（`client/feed-preview-model.js`）共同调用，消除预览与推送的数据漂移。
- 公众号头像与名称改为独立的公众号配置来源：`settings.mp` 新增 `headImg` 字段（`POST /wechat-studio/wechat/verify` 验证通过且命中已保存 `appId` 时自动缓存），`snapshotState` 仅透出 `mp: { name, headImg }`（不含 `appId`/`appSecret`，绝不复用封面生图人物参考图 `portraitUrl`）。
- 在 React 外壳 `LayoutView` 中增加顶部模式切换与独立组件 `client/feed-preview.jsx`；切到 `feed` 模式时整体隐藏正文预览容器（含降级横幅条、关注卡条、自查报告与 `iframe`），保留 `iframe` 挂载不重载。

**Tech Stack:** Node.js `>=20` ESM、React 18（esbuild 打包至 `dist/client.js`）、`node:test`、`node:assert/strict`。

## Global Constraints

- **零运行时依赖**：不引入任何第三方 npm 依赖（`npm run check:package` 必须通过）。
- **不改动排版引擎**：严禁修改 `vendor/layout/layout.js`，`test/layout-golden.test.js` 必须继续逐字节通过。
- **推送与预览同源**：标题上限（`MAX_TITLE = 32`）、摘要派生（`deriveDigest`）与封面选择（`latestCover`）在前后端共享同一纯函数实现。
- **浅色微信画布隔离**：模拟卡片区域固定使用微信真实浅色底（`#EDEDED` 画布 + `#FFFFFF` 卡片 + `#191919` 标题 + `#576B95` 公众号名），不受 DSH 深色主题反转影响。
- **不修改 CLI 命令和参数、不新增后端路由**：仅扩展 `settings.mp.headImg`、`wechat/verify` 缓存逻辑与 `state` 快照的 `mp` 公开字段（`pushWechatDraft` 被 CLI 共用，接入 `deriveDigest` 后 CLI 推送草稿的摘要行为会同步生效）。

## Review Focus

1. **摘要预览与实际推送一致**：`pushWechatDraft` 不再硬编码 `digest: ''`，改用与前端共享的 `deriveDigest(article)`（优先 `article.summary`，为空时跳过标题/图片/代码块取第一段普通正文 `para` 的纯文本，按微信 120 字上限截断）。
2. **公众号名称与头像来源准确**：名称按 `mp.name → brand.author → '公众号'` 回退；头像只使用公众号独立缓存的 `mp.headImg`，绝不使用封面参考图 `portraitUrl`；未配置、非 `http(s)://` 或加载失败时降级为名称首字圆形徽章（按 Unicode 码点取首字，不拆代理对）。
3. **封面回退与推送一致**：前端预览复用 `latestCover(article)`，当 `article.cover` 为空但 `article.coverRuns` 有历史图片时，仍展示与实际推送相同的封面图；无封面或图片加载失败时展示 2.35:1 / 1:1 占位块，不出现裂图。
4. **真实屏宽与准确截断检测**：`375px` / `414px` 模拟容器保持真实固定 CSS 宽度（不用 `max-width: 100%` 压缩），窄窗格下横向滚动（`overflow-x: auto`）；2 行标题截断检测结合 `ResizeObserver` 与 `document.fonts?.ready` 重新测量。
5. **切换视图范围明确且不丢排版状态**：`feed` 模式下隐藏整个正文预览块（含 `BannerBar`、关注卡开关、自查报告与 `iframe`），仅通过 `hidden` 隐藏容器保留 `iframe` 挂载，来回切换不重新触发 `loadLayout()`。

---

### Task 1: 前后端共享元数据派生模块与草稿推送对齐（`src/wechat-meta.js`、`src/wechat.js`）

**Files:**
- Create: `src/wechat-meta.js`
- Modify: `src/wechat.js`（复用并重导出 `latestCover`，`pushWechatDraft` 使用 `deriveDigest(article).text`）
- Test: `test/wechat.test.js`

**Interfaces:**
- Consumes: `blockKind`, `plainOf` from `./article.js`
- Produces (`src/wechat-meta.js`):
  - `MAX_TITLE = 32`
  - `MAX_DIGEST = 120`
  - `deriveDigest(article, maxChars = MAX_DIGEST): { text: string, fallback: boolean }`
  - `latestCover(article): { id: string, format: string } | null`
- Re-exports (`src/wechat.js`): 保持 `export { latestCover }` 与现有调用方（`src/host.js`、`test/wechat.test.js`）完全兼容。

- [ ] **Step 1: 在 `test/wechat.test.js` 补充失败的回归测试**

新增 2 个测试用例：
1. `pushWechatDraft` 发送 `digest` 与 `article.summary` 对齐（去除首尾空白并截断至 120 字）。
2. `article.summary` 为空时，`pushWechatDraft` 跳过 `heading` / `media` / `code` 块，取第一个普通正文段 `plainOf` 文本作为 `digest`；全文无普通段落时发送空字符串 `''`。

- [ ] **Step 2: 运行测试确认失败**

Run: `export PATH="/opt/homebrew/opt/nodejs/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" && node --test test/wechat.test.js`
Expected: FAIL（`pushWechatDraft` 当前硬编码 `digest: ''`）

- [ ] **Step 3: 实现 `src/wechat-meta.js` 并接入 `src/wechat.js`**

- `src/wechat-meta.js` 实现：
  - `deriveDigest(article, maxChars = MAX_DIGEST)`：
    - 若 `String(article?.summary ?? '').replace(/\s+/g, ' ').trim()` 非空，返回 `{ text: value.slice(0, maxChars), fallback: false }`。
    - 否则遍历 `article?.blocks ?? []`，跳过 `kind`（或 `blockKind(block.text)`）不等于 `'para'` 的块，取第一个 `plainOf(block.text).replace(/\s+/g, ' ').trim()` 非空的文本，返回 `{ text: text.slice(0, maxChars), fallback: true }`。
    - 找不到普通段落时返回 `{ text: '', fallback: true }`。
  - `latestCover(article)`：从 `src/wechat.js:257-263` 迁移过来，保持完全一致的逻辑（优先 `article.cover?.id`，否则取 `article.coverRuns` 中最后一个非空批次的最后一张）。
- `src/wechat.js`：
  - 导入并重导出 `latestCover`，导入 `deriveDigest` 与 `MAX_TITLE`。
  - `pushWechatDraft` 中将 `digest: ''` 替换为 `digest: deriveDigest(article).text`。

- [ ] **Step 4: 运行测试确认通过**

Run: `export PATH="/opt/homebrew/opt/nodejs/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" && node --test test/wechat.test.js`
Expected: PASS

---

### Task 2: 公众号头像独立缓存与 Host 快照透出 `mp`（`src/settings.js`、`src/host.js`）

**Files:**
- Modify: `src/settings.js:12-16`, `src/settings.js:104-109`, `src/settings.js:187-196`, `src/settings.js:221-226`
- Modify: `src/host.js:405-420`, `src/host.js:1115-1126`
- Test: `test/wechat.test.js`, `test/host.test.js`

**Interfaces:**
- `settings.mp`: `{ name: string, appId: string, appSecret: string, headImg: string }`
- `publicSettings(settings).mp`: `{ name: string, appId: string, appSecretSet: boolean, headImg: string }`
- `GET /wechat-studio/state`: 顶层新增 `mp: { name: string, headImg: string }`（不透出 `appId`、`appSecret`，不透出 `portraitUrl`）
- `POST /wechat-studio/wechat/verify`: 验证成功且验证的 `appId === settings.mp.appId` 且返回了合法 `headImg` 时，自动写入 `settings.mp.headImg`。

- [ ] **Step 1: 在 `test/wechat.test.js` 与 `test/host.test.js` 补充失败断言**

- `test/wechat.test.js`：
  - `mp` 设置默认 `headImg: ''`；保存合法 `http(s)://` `headImg` 后持久化并在 `publicSettings` 中返回；修改 `mp.appId` 时自动清空旧 `headImg`；非法协议（如 `javascript:`）被忽略或拒绝。
- `test/host.test.js`：
  - `GET /wechat-studio/state` 返回 `mp: { name: '', headImg: '' }` 且不含 `appId` / `appSecret`。
  - 保存 `mp.name` + `mp.appId` + `mp.appSecret` 并调用 `POST /wechat-studio/wechat/verify`（mock 返回 `head_img`）后，`GET /wechat-studio/state` 返回缓存后的 `mp: { name, headImg }`。
  - 验证一个**未保存**的临时 `appId` 时，不覆盖已保存账号的 `mp.headImg`。

- [ ] **Step 2: 运行测试确认失败**

Run: `export PATH="/opt/homebrew/opt/nodejs/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" && node --test test/wechat.test.js test/host.test.js`
Expected: FAIL

- [ ] **Step 3: 修改 `src/settings.js` 与 `src/host.js`**

- `src/settings.js`：
  - 新增小工具 `safeAvatarUrl(value)`：仅允许不带账号密码的 `https:` / `http:` URL，最长 2000 字符，其余返回 `''`。
  - `DEFAULT_MP`、`readSettings`、`publicSettings` 增加 `headImg`。
  - `updateSettings` 中：若 `body.mp.appId` 与原 `next.mp.appId` 不同且未显式传 `body.mp.headImg`，清空 `next.mp.headImg = ''`；若传入 `body.mp.headImg`，用 `safeAvatarUrl` 规范化后写入。
- `src/host.js`：
  - `snapshotState` 在 `brand: settings.brand` 旁新增 `mp: { name: settings.mp?.name ?? '', headImg: settings.mp?.headImg ?? '' }`。
  - `POST /wechat-studio/wechat/verify` 在 `verifyCredentials` 成功后，若 `appId === settings.mp.appId && headImg`，调用 `updateSettings(store.root, { mp: { headImg } })` 持久化头像。

- [ ] **Step 4: 运行测试确认通过**

Run: `export PATH="/opt/homebrew/opt/nodejs/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" && node --test test/wechat.test.js test/host.test.js`
Expected: PASS

---

### Task 3: 前端卡片数据模型与单元测试（`client/feed-preview-model.js`）

**Files:**
- Create: `client/feed-preview-model.js`
- Create: `test/feed-preview-model.test.js`

**Interfaces:**
- Consumes: `MAX_TITLE`, `deriveDigest`, `latestCover` from `../src/wechat-meta.js`
- Produces:
  - `FEED_PREVIEW_WIDTHS`: `Array<{ id: '375' | '414', label: string, width: number }>`
  - `MAX_FEED_DRAFT_TITLE_CHARS = MAX_TITLE`（`32`），`MAX_FEED_MP_TITLE_CHARS = MAX_MP_TITLE`（`64`）
  - `buildFeedCardModel({ article, brand, mp }): { accountName: string, avatarText: string, avatarUrl: string | null, title: string, titleEmpty: boolean, titleChars: number, titleOverDraftLimit: boolean, titleOverMpLimit: boolean, titleOverLimit: boolean, summary: string, summaryFallback: boolean, coverUrl: string | null }`

- [ ] **Step 1: 编写失败的单元测试 `test/feed-preview-model.test.js`**

覆盖 6 类场景：
1. 完整稿件（标题 + 摘要 + `article.cover` + `mp.name` + `mp.headImg`）返回正确 `accountName`、`avatarUrl`、`coverUrl`、`titleChars`、`titleOverLimit: false`、`summaryFallback: false`。
2. 账号名回退链路：`mp.name` 优先，其次 `brand.author`，两者都空时回退 `'公众号'`；带 emoji 账号名的 `avatarText` 按 Unicode 码点取首个字符不拆代理对。
3. `summary` 为空时与 `deriveDigest` 一致：跳过 `heading` / `media` / `code` 块取第一个 `para` 块纯文本并标记 `summaryFallback: true`；无正文段时返回空字符串。
4. 标题边界（按 UTF-16 码元计数，与 `preflight` 和草稿推送一致）：空标题 `titleEmpty: true`；32 字正常；33–64 字 `titleOverDraftLimit: true` 且 `titleOverMpLimit: false`；65 字 `titleOverMpLimit: true`。
5. 非 `http(s)://` 或带认证信息的 `mp.headImg` 统一置为 `avatarUrl: null`；不接受/不读取 `portraitUrl`。
6. **封面回退测试**：`article.cover` 为空但存在多个 `coverRuns`（含空 `images: []` 批次）时，与 `latestCover(article)` 一致，取最后一个非空批次的最后一张拼出 `coverUrl`；两者都空时返回 `coverUrl: null`。

- [ ] **Step 2: 运行测试确认失败**

Run: `export PATH="/opt/homebrew/opt/nodejs/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" && node --test test/feed-preview-model.test.js`
Expected: FAIL

- [ ] **Step 3: 实现 `client/feed-preview-model.js`**

- 直接调用 `deriveDigest(article)` 与 `latestCover(article)`，不重复实现摘要和封面回退逻辑。
- `accountName = (mp?.name ?? '').trim() || (brand?.author ?? '').trim() || '公众号'`。
- `avatarUrl` 校验 `protocol === 'https:' || protocol === 'http:'` 且无 `username`/`password`（WeChat `wx.qlogo.cn` 返回的 `http://` 可按原样或升级 `https://` 使用，这里在 `http://wx.qlogo.cn/` 下可安全升级为 `https://`，其余合法 `https:` 保留）。
- `cover = latestCover(article)`，当 `article?.id && cover?.id` 时构造 `` `wechat-studio/cover/image?${new URLSearchParams({ id: article.id, asset: cover.id })}` ``。

- [ ] **Step 4: 运行测试确认通过**

Run: `export PATH="/opt/homebrew/opt/nodejs/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" && node --test test/feed-preview-model.test.js`
Expected: PASS（6/6）

---

### Task 4: 信息流卡片预览组件与排版预览接入（`client/feed-preview.jsx`、`client/app.jsx`、`client/styles.css`）

**Files:**
- Create: `client/feed-preview.jsx`
- Modify: `client/state.js`（`testWechat` 在 `result.ok` 后调用 `await refresh()` 同步最新 `data.mp`）
- Modify: `client/app.jsx:694-766`, `client/app.jsx:2190-2200`
- Modify: `client/styles.css`（文末追加 `.ws-layout-modebar`、`.ws-layout-article:not([hidden])` 与 `.ws-feed-*` 样式）
- Rebuild: `dist/client.js`

**Interfaces:**
- Consumes: `buildFeedCardModel`, `FEED_PREVIEW_WIDTHS`, `MAX_FEED_TITLE_CHARS` from `./feed-preview-model.js`
- Produces: `FeedCardPreview({ article, brand, mp })` exported from `client/feed-preview.jsx`

- [ ] **Step 1: 实现 `client/feed-preview.jsx`**

导出 `FeedCardPreview({ article, brand, mp })`：
- 状态：`widthId`（默认 `'375'`）、`avatarFailed`（随 `model.avatarUrl` 重置）、`coverFailed`（随 `model.coverUrl` 重置）、`titleClamped`。
- **2 行截断检测**：
  - 绑定 `titleRef` 到大图卡标题元素，通过 `measure()` 检查 `el.scrollHeight > el.clientHeight + 1`。
  - 在 `useLayoutEffect` 中立即执行一次 `measure()`，并挂载 `ResizeObserver` 监听 `titleRef.current` 尺寸变化；同时在 `document.fonts?.ready` resolve 后再次 `measure()`（带 `cancelled` 标记防止卸载后 setState），确保字体加载完成与容器变化都能准确更新状态。
- 顶部控制栏：
  - 屏宽切换分段按钮（`375px · 标准屏` / `414px · 大屏`）
  - 标题状态胶囊：1–32 字显示 `标题 {titleChars} / 32 字`；33–64 字黄色提醒 `超出草稿箱推送 32 字上限（后台手动可填 64 字）`；空标题或 `> 64` 字红色告警；`titleClamped` 为 `true` 时显示 `当前屏宽下第 2 行已触发截断`。
- 横向滚动浅灰模拟画布（`.ws-feed-stage`，`background: #EDEDED`，`overflow-x: auto`）：
  - 内层 `.ws-feed-phone` 固定 `width: ${selectedWidth}px; flex: 0 0 auto;`（**绝不使用 `max-width: 100%` 压缩**，窄窗格下自动横向滚动，保证断行模拟不失真）。
  - 卡片 1：**订阅号信息流大图卡**（按微信发表预览截图进行视觉模拟）：
    - 顶部账号行：28px 圆形头像（`<img>` 加载失败或为空时降级首字徽章）+ `#576B95` 公众号名称。
    - 中间封面：全宽 `aspect-ratio: 2.35`（无左右内边距）；无封面或 `onError` 时显示浅灰 2.35:1 占位提示「暂未生成封面 · 可在稿面右侧配图栏生成」。
    - 底部标题：`16px / 1.45`，`#191919`，`-webkit-line-clamp: 2`，不显示摘要。
  - 卡片 2：**转发给好友卡片**：
    - 顶部标题：`15px / 1.4`，`#191919`，`-webkit-line-clamp: 2`。
    - 下方两栏：左侧摘要（`12.5px / 1.45`，`#888`，`-webkit-line-clamp: 2`，无摘要且无正文时显示「暂未填写摘要」），右侧 `52×52` 1:1 封面缩略图（`object-fit: cover`）或占位块。
    - 底部灰线 + 小字来源：`公众号 · {accountName}`。

- [ ] **Step 2: 接入 `client/app.jsx` 的 `LayoutView`**

- `PaperModule` 向 `<LayoutView article={article} brand={data.brand} mp={data.mp} />` 传参。
- `LayoutView` 内部新增 `const [previewMode, setPreviewMode] = React.useState('article')`，并在 `article.id` 变化时重置为 `'article'`。
- 在 `LayoutView` 顶部渲染 `.ws-layout-modebar`（`正文预览` | `信息流卡片`）。
- **显式切换范围**：将整个正文预览区域（含 `!enhanced` 时的 `BannerBar` 与文末关注卡条、loading/error 状态、可选 `.ws-layout-report` 及 `<iframe className="ws-frame" />`）包裹在 `<div className="ws-layout-article" hidden={previewMode !== 'article'}>` 中，确保切到 `feed` 模式时正文侧附属栏与 `iframe` 一并隐藏，但 `iframe` 保持挂载不重载。
- 当 `previewMode === 'feed'` 时渲染 `<FeedCardPreview article={article} brand={brand} mp={mp} />`。

- [ ] **Step 2b: 更新 `client/state.js` 的 `testWechat()`**

在 `POST /wechat-studio/wechat/verify` 返回 `result.ok` 后调用 `await refresh()`，确保后端缓存的 `mp.headImg` 立即同步到前端全局 `data.mp`，无需重载插件即可在信息流卡片中看到更新后的头像。

- [ ] **Step 3: 在 `client/styles.css` 追加 `.ws-layout-modebar`、`.ws-layout-article:not([hidden])` 与 `.ws-feed-*` 样式**

- 明确使用 `.ws-layout-article:not([hidden]) { flex: 1; min-height: 0; display: flex; flex-direction: column; }`，避免 `display: flex` 覆盖浏览器默认 `[hidden] { display: none }`，确保 `feed` 模式下正文区域真正隐藏且 `iframe` 在 `article` 模式下高度正常。
- 确保 `.ws-feed-stage` 在 DSH 浅色与深色主题下都保持微信浅灰画布（`#EDEDED`）与白卡（`#FFFFFF`），并且 `.ws-feed-phone` 保持真实 `375px` / `414px` 宽度，窄屏通过 `.ws-feed-stage` 横向滚动查看。

- [ ] **Step 4: 构建并运行全量自动化验证**

Run: `export PATH="/opt/homebrew/opt/nodejs/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" && npm run build && npm test && npm run check:package && git diff --check`
Expected: `dist/client.js` 构建成功，全量测试（含 `test/wechat.test.js`、`test/host.test.js`、`test/feed-preview-model.test.js`、`test/layout-golden.test.js`）全部通过，`check:package` 与 `git diff --check` 零错误。

---

### Task 5: DSH 桌面端手工验收清单

代码构建与自动化测试通过后，在 DSH 桌面端完成以下实机验证：

- [ ] **模式切换与 iframe 保活**：在「排版预览」中点击 `正文预览` ↔ `信息流卡片` 来回切换，确认 `feed` 模式下正文 `BannerBar`/关注卡条/排版 `iframe` 全部隐藏，切回 `正文预览` 时 `iframe` 未重新加载且滚动/配置状态不丢失。
- [ ] **浅色 / 深色主题隔离**：切换 DSH 浅色与深色主题，确认控制栏随主题适配，模拟卡片画布（`#EDEDED`）与卡片白底（`#FFFFFF`）、文字对比度始终正常。
- [ ] **真实屏宽与窄窗格横向滚动**：将 DSH 窗口拉窄至小于 `414px`（甚至小于 `375px`），切换 `375px` 与 `414px`，确认卡片宽度不被压缩、标题断行位置不变，画布可流畅横向滚动。
- [ ] **异常图片兜底（`onError`）**：测试无封面稿件、仅有 `coverRuns` 历史封面的稿件、以及头像/封面 URL 加载失败场景，确认均降级为占位块或名称首字徽章，无裂图图标。
- [ ] **公众号头像与名称联动**：在「设置 → 公众号凭证」中修改名称或点击「验证凭证」后，确认信息流卡片头像/名称正确更新，且与封面生成里的 `portraitUrl` 互不干扰。
- [ ] **切换稿件行为**：在 `信息流卡片` 模式下通过顶部切稿器切到另一篇文章，确认视图正常重置回 `正文预览` 且无残留上一篇的截断或图片失败状态。
