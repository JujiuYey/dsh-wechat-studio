# 自定义封面风格 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `dsh-wechat-studio` 新增本地「自定义封面风格」能力：用户可通过 1–3 张封面参考图和/或文字诉求由视觉大模型拆解出可复用的 21:9 提示词模板，支持异步试生成样图、基于最新编辑草稿的自然语言微调与折叠区手改模板，并以独立风格包目录持久化到本地，在文章封面选择弹窗、「技能」页管理卡片、封面历史记录与 CLI 中全链路复用。

**Architecture:** 沿用方案 A，将本地自定义风格作为独立风格包存放在 `<root>/cover-styles/<id>/`（`meta.json` + `template.txt` + `guidance.txt` + 可选 `preview.png|jpg`），在服务端统一合并 7 套内置风格与本地自定义风格。自定义风格走中性填词系统提示词（不加载内置 `SKILL.md`），按 `usePortrait` 决定是否传入用户肖像照；试生成复用现有生图管线并以内存异步任务 + 单活锁 + 轮询执行，规避 300s HTTP 超时并兼容 MiniMax 600s 非幂等计费保护。

**Tech Stack:** Node.js >= 20 ESM、React 18、DSH `ctx.llm` / `ctx.attachments`、esbuild、`node:test`、`node:assert/strict`，零新增运行时依赖。

**Spec:** [docs/superpowers/specs/2026-11-23-custom-cover-styles-design.md](../specs/2026-11-23-custom-cover-styles-design.md)

## Global Constraints

- Node.js >= 20 ESM，零新增 `dependencies` / `optionalDependencies` / `peerDependencies`（`npm run check:package` 必须通过）。
- `src/cover-styles.js` 与 `src/cover-options.js` 必须保持浏览器安全，不得引入任何 `node:*` 模块。
- 内置 7 套风格（`classic` / `editorial` / `campaign` / `kinetic` / `grunge` / `magenta` / `felt`）的提示词构建、模板读取与行为必须逐字不变，不允许编辑或删除内置风格。
- 封面比例严格 2.35:1（47:20），复用 `dist/image-crop.mjs` 的 `cropCover` 裁切；前端参考图压缩为长边 ≤ 960px、单张 ≤ 420 KB JPEG Data URL（最多 3 张，服务端解码后单张 ≤ 2 MB），请求体不超过 `MAX_JSON = 4_000_000`。
- 模板校验统一要求 **≥ 2 个 `{{...}}` 占位符**、`template` ≤ 8000 字、`guidance` ≤ 4000 字、`userRequirement` ≤ 1000 字、`name` 1–16 字、`description` 1–80 字、本地最多 `30` 套自定义风格，且通过 `blocklist.txt` 子串禁用词检查。
- 风格 ID 固定匹配 `/^custom-[a-z0-9-]{4,32}$/`；`previewFile` 固定白名单 `preview.png` / `preview.jpg` / `preview.jpeg`；`draftToken` 固定标准 UUID；所有文件读取拒绝符号链接、验证 `realpath` 位于目标目录内，并按文件头魔数输出 `Content-Type`。
- MiniMax 600s 超时直接复用 `src/cover.js` 既有 `MINIMAX_TIMEOUT`（`nonRetryable: true`）与专属计费提示文案，绝不自动重试。

## Review Focus

1. **符号链接或篡改 `meta.json` 指向目录外文件 / 伪造扩展名**：`readCustomStylePreview` 与 `readDraftPreview` 必须同时拦截非法 basename、软链接、`realpath` 逃逸以及魔数不匹配文件（在 Task 2 钉死测试）。
2. **多文件保存中途失败破坏已有风格或留下半成品目录**：新建使用 `.staging-<uuid>` 整体原子 rename、更新使用 `.tmp` 全部落盘后再按 `preview` → `template.txt` → `guidance.txt` → `meta.json` 顺序替换并失败回滚（在 Task 2 钉死测试）。
3. **纯文本模型带参考图被静默降级瞎编**：无论是 `modelVisionSupport === false` 还是 `null` 时运行时抛出识图不支持错误，`callModel(..., { strictImages: true })` 都必须直接抛错中止，而无参考图纯文字创建仍正常工作（在 Task 1 和 Task 3 钉死测试）。
4. **并发重复点击试生成或关闭向导再打开导致 MiniMax 重复付费**：服务端单活锁返回 `409` + `activeJobId`，`GET cover-styles` 暴露 `activeTestJob` 供关闭向导后恢复轮询，已完成内存任务 30 分钟 TTL 自动回收（在 Task 4 和 Task 6 钉死测试）。
5. **删除自定义风格或旧历史记录缺少 `styleName` 时封面历史/下载崩溃**：`coverRuns` 写入 `styleName`；删除风格后下载名与历史面板优先实时目录 → `run.styleName` → `COVER_STYLES` → `'封面'`（在 Task 1 和 Task 4 钉死测试）。

---

## File Structure

- Modify: `src/cover-styles.js` — 内置风格补 `source: 'builtin'` 与 `usePortrait`，导出浏览器安全常量与纯函数（`CUSTOM_COVER_STYLE_LIMITS`、`extractTemplateSlots`、`hasPortraitMarkers`、`isCustomStyleId`、`resolveCoverStyleName`）。
- Modify: `src/ai.js` — `callModel` 增加可选参数 `strictImages = false`，禁用不支持识图时的静默降级。
- Modify: `src/cover.js` — `coverDownloadName` 支持 `styleNameOverride` 与 `run.styleName` 回退。
- Create: `src/custom-cover-styles.js` — 自定义封面风格存储 CRUD、两阶段原子落盘、路径/软链/魔数安全预览 IO、`_drafts` TTL 清理、视觉拆解/微调与试生成执行。
- Modify: `src/cover-prompt.js` — 支持 `options.customStyle` 走中性填词系统提示词（不加载内置 `SKILL.md`），内置风格逐字不变。
- Modify: `src/host.js` — 接入 `resolveCoverStyle` 与 `usePortrait`、记录 `styleName`、新增单活异步试生成任务表（30 min TTL）与 9 个 `cover-styles/*` HTTP 路由。
- Modify: `src/cli.js` — `cover` 子命令兼容本地自定义风格 ID 与 `--prompt-only`。
- Create: `client/image-input.js` — 抽出 `compressReferenceImageFile` 与 `extractClipboardImageFiles`，供 `client/derive.jsx` 与 `client/custom-cover-style.jsx` 复用。
- Create: `client/custom-cover-style-model.js` — 浏览器安全的向导纯状态机模型（脏检查、旧预览过期标记、最新草稿微调载荷构建、保存预览优先级、后台试生成任务挂接恢复），供 `node:test` 直接单测。
- Modify: `client/derive.jsx` — 复用 `client/image-input.js`。
- Modify: `client/state.js` — 新增封面风格列表、向导与异步试生成轮询状态及请求动作。
- Create: `client/custom-cover-style.jsx` — `CustomCoverStyleCard`（「技能」页管理卡片）与 `CustomCoverStyleWizard`（2 步创建/编辑向导，含未保存保护、过期预览标记、最新草稿微调、折叠模板编辑器与后台试生成恢复）。
- Modify: `client/app.jsx` — 改造 `CoverStyleDialog`、`CoverHistoryDialog`、`SkillsView`、`Studio`。
- Modify: `client/styles.css` — 自定义封面风格卡片、角标、向导、过期提示与后台状态条样式。
- Create: `test/custom-cover-styles.test.js`、`test/custom-cover-styles-routes.test.js`、`test/custom-cover-style-model.test.js`；Modify: `test/cover.test.js`、`test/cli.test.js`。

---

### Task 1: 共享浏览器安全元数据、`callModel` 严格识图开关与下载名回退

**Files:**
- Modify: `src/cover-styles.js:1-9`
- Modify: `src/ai.js:184-236`
- Modify: `src/cover.js:241-256`
- Test: `test/cover.test.js`

**Interfaces:**
- Produces in `src/cover-styles.js`:
  - `COVER_STYLES`: 每项增加 `source: 'builtin'` 与 `usePortrait: boolean`（`felt` 为 `false`，其余 6 项为 `true`）。
  - `CUSTOM_COVER_STYLE_LIMITS`: `{ maxStyles: 30, maxReferenceImages: 3, maxReferenceBytes: 2 * 1024 * 1024, minSlots: 2, maxName: 16, maxDescription: 80, maxRequirement: 1000, maxTemplate: 8000, maxGuidance: 4000 }`
  - `isCustomStyleId(id: unknown) -> boolean`（匹配 `/^custom-[a-z0-9-]{4,32}$/`）
  - `extractTemplateSlots(template: string) -> string[]`（返回所有 `{{...}}` 占位符去空白名称数组）
  - `hasPortraitMarkers(template: string) -> boolean`（是否含 `[[SUBJECT]]` / `[[人物]]`）
  - `resolveCoverStyleName(styleId: string, styles?: Array<{id, name}>, fallbackName?: string) -> string`（优先级：`styles` 实时匹配 → `fallbackName` → `COVER_STYLES` → `'封面'`）
- Produces in `src/ai.js`:
  - `callModel(ctx, { ..., strictImages = false })`: 当 `strictImages === true` 且 `validImages.length > 0` 时，若 `vision === false` 或捕获 `isImageUnsupportedError(err)`，抛出带 `status: 400` 的明确错误，**不**重试纯文本。
- Produces in `src/cover.js`:
  - `coverDownloadName(article, run, imageId, styleNameOverride = '') -> string`

- [ ] **Step 1: 在 `test/cover.test.js` 写失败测试**

新增 3 组断言：
1. `cover-styles.js` 浏览器安全（无 `from 'node:'`）、7 套内置风格均带 `source: 'builtin'` 且仅 `felt` 的 `usePortrait === false`、`isCustomStyleId('custom-a1b2c3d4') === true` / `isCustomStyleId('classic') === false` / `isCustomStyleId('../x') === false`、`extractTemplateSlots('A {{标题}} B {{视觉元素}}')` 返回 `['标题', '视觉元素']`、`hasPortraitMarkers('[[SUBJECT]]') === true`、`resolveCoverStyleName` 遵循实时列表 → `fallbackName` → 内置 → `'封面'`。
2. `coverDownloadName` 测试：传入自定义 `run = { style: 'custom-abcd1234', styleName: '黑金杂志风', ... }` 时输出含 `黑金杂志风`；传 `styleNameOverride` 时优先用 `styleNameOverride`；旧记录无 `styleName` 时内置风格仍输出 `动感大字`、未知风格输出 `封面`。
3. `callModel` `strictImages: true` 测试：当 `listModels` 声明 `inputModalities: ['text']` 时直接 reject `/不支持识图/` 且不发模型调用；当 `listModels` 未声明模态但流式抛出 `does not support images` 时直接 reject `/不支持图片输入/` 且只调用 1 次（不降级纯文本）；`strictImages` 未开启时原有降级行为不变。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test --test-name-pattern='cover-styles|coverDownloadName|strictImages|封面下载文件名' test/cover.test.js`
Expected: FAIL，提示新增导出不存在或 `strictImages` 未阻止降级。

- [ ] **Step 3: 实现 `src/cover-styles.js`、`src/ai.js` 与 `src/cover.js`**

- 在 `src/cover-styles.js` 补全 `source: 'builtin'`、`usePortrait` 和上述 5 个纯函数/常量，确保零 `node:*` 导入。
- 在 `src/ai.js` 的 `callModel` 解构 `strictImages = false`：`vision === false` 且 `strictImages` 时抛 `Object.assign(new Error('当前所选模型不支持识图，请先切换到支持视觉的多模态模型，或移除参考图后仅用文字诉求创建。'), { status: 400, code: 'VISION_UNSUPPORTED' })`；`isImageUnsupportedError(err)` 且 `strictImages` 时抛同语义 `status: 400` 错误，不执行 `runOnce(false)`。
- 在 `src/cover.js` 的 `coverDownloadName(article, run, imageId, styleNameOverride = '')` 改用 `resolveCoverStyleName(run.style, null, styleNameOverride || run.styleName)`。

- [ ] **Step 4: 运行测试验证通过**

Run: `node --test test/cover.test.js test/derive.test.js`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/cover-styles.js src/ai.js src/cover.js test/cover.test.js
git commit -m "feat(cover): add shared style metadata, strict vision gate, and styleName fallback"
```

---

### Task 2: 自定义封面风格存储、两阶段原子落盘与路径/魔数安全预览 IO

**Files:**
- Create: `src/custom-cover-styles.js`
- Create: `test/custom-cover-styles.test.js`

**Interfaces:**
- Consumes: `src/cover-styles.js` (`COVER_STYLES`, `CUSTOM_COVER_STYLE_LIMITS`, `extractTemplateSlots`, `isCustomStyleId`), `src/store.js` (`withFileLock`), `src/cover-prompt.js` (`loadCoverBlocklist`, `findBlocked`), `src/derive-shared.js` (`parseDataImageUri`), `dist/image-crop.mjs` (`cropCover`).
- Produces in `src/custom-cover-styles.js`:
  - `CUSTOM_STYLE_PREVIEW_FILES`: `new Set(['preview.png', 'preview.jpg', 'preview.jpeg'])`
  - `detectImageContentType(buffer: Buffer) -> 'image/png' | 'image/jpeg' | null`
  - `validateCustomStyleInput(input, blocklistTerms) -> { name, description, usePortrait, userRequirement, template, guidance, slots }`
  - `listCoverStyles(root: string) -> Promise<{ styles: Array<object>, warnings: string[] }>`
  - `readCustomCoverStyle(root: string, id: string) -> Promise<object | null>`
  - `resolveCoverStyle(root: string, id: string) -> Promise<object | null>`
  - `saveCustomCoverStyle(root: string, input: object, opts?: { _testFailBeforeCommit?: boolean }) -> Promise<{ style: object, styles: Array<object>, warnings: string[] }>`
  - `deleteCustomCoverStyle(root: string, id: string) -> Promise<{ styles: Array<object>, warnings: string[] }>`
  - `saveDraftPreview(root: string, imageBuffer: Buffer, format: 'png'|'jpeg') -> Promise<{ draftToken: string, format: 'png'|'jpeg' }>`
  - `readDraftPreview(root: string, token: string) -> Promise<{ buffer: Buffer, contentType: 'image/png'|'image/jpeg', format: 'png'|'jpeg' }>`
  - `readCustomStylePreview(root: string, id: string) -> Promise<{ buffer: Buffer, contentType: 'image/png'|'image/jpeg' }>`
  - `pruneExpiredDrafts(root: string, nowMs?: number, ttlMs?: number) -> Promise<number>`

- [ ] **Step 1: 在 `test/custom-cover-styles.test.js` 写失败测试**

覆盖以下全部用例：
1. **CRUD 与排序**：空目录 `listCoverStyles` 返回 7 套内置风格；新建 2 套自定义风格，ID 匹配 `custom-[a-f0-9]{8}`，磁盘写入 `meta.json`、`template.txt`、`guidance.txt`、`preview.png`，`template.txt` 含 ```` ``` ```` 反引号围栏时读写 100% 无损；列表按内置 7 套在前 + 自定义按 `createdAt` 升序排列；编辑更新保留 `createdAt` 更新 `updatedAt`；删除移除目录并从列表消失。
2. **校验边界**：`name` 空/超 16 字、`description` 空/超 80 字、少于 2 个 `{{...}}` 占位符、命中 `blocklist.txt` 禁用词、超 `30` 套上限新建、对内置 ID（`classic`）执行更新或删除，均抛 `status: 400`。
3. **两阶段原子落盘与失败恢复**：
   - 新建阶段模拟 `_testFailBeforeCommit` 失败：`<root>/cover-styles/` 下无残留 `.staging-*` 或目标目录；
   - 更新阶段模拟写临时文件后失败：原有 `meta.json`、`template.txt`、`guidance.txt` 与旧 `preview.png` 内容完全不变且无残留 `.tmp`；
   - 更新预览图从 `.jpg` 切换为 `.png` 时，新 `preview.png` 与 `meta.json` 生效且旧 `preview.jpg` 被清理；
   - 并发同时发起 5 次保存，全部成功无锁冲突或丢数据。
4. **损坏目录隔离**：在 `<root>/cover-styles/` 放置 `custom-broken1`（损坏 JSON）、`custom-broken2`（缺 `template.txt`）、`.staging-leftover`、`_drafts`，`listCoverStyles` 正常返回内置 + 其他合法自定义风格，并在 `warnings` 中报告损坏项。
5. **路径、软链与魔数安全**：
   - 篡改 `meta.json` 的 `previewFile` 为 `../secret.png`、`/etc/passwd`、`other.png` → `readCustomStylePreview` 均拒绝；
   - 将 `preview.png` 换成指向目录外真实 PNG 的符号链接，或将整个风格目录设为符号链接 → 均拒绝；
   - 将非图片文本伪装为 `preview.png`、或将 JPEG 字节存为 `preview.png` → 非图片拒绝，JPEG 字节按魔数返回 `image/jpeg`；
   - 非 UUID `draftToken`（如 `../x`、`not-uuid`）被 `readDraftPreview` 拒绝；
   - `_drafts/` 中超过 24h 的过期文件被 `pruneExpiredDrafts` 清理，24h 内的保留。
6. **兜底预览策略**：新建且传 `fallbackReferenceImage`（合法 PNG/JPEG Data URL）时裁切为 47:20 保存为 `preview`；纯文字新建无图时 `previewFile: null`；编辑模式不传 `previewDraftToken` 且不传 `fallbackReferenceImage` 时保留原预览图。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/custom-cover-styles.test.js`
Expected: FAIL，提示 `src/custom-cover-styles.js` 不存在。

- [ ] **Step 3: 实现 `src/custom-cover-styles.js` 的存储、校验与安全预览 IO**

按 Spec Section 6 实现：
- 所有目录权限 `0o700`，文件权限 `0o600`；增删改均包在 `withFileLock(join(stylesDir, '.lock'), ...)` 内。
- 新建走 `.staging-<uuid>` 写完后 `rename` 到 `<id>`，异常在 `catch` 中 `rm(stagingDir, { recursive: true, force: true })`。
- 更新先在风格目录内写完所有 `.<name>.<uuid>.tmp`，全部成功后按 `preview` → `template.txt` → `guidance.txt` → `meta.json` 顺序 `rename`，成功后再删扩展名变化的旧预览图；失败清 `.tmp` 并按预先读取的旧内容尽力回滚。
- `readCustomStylePreview` 与 `readDraftPreview` 均校验白名单/UUID、`lstat` 拒绝符号链接（同时检查父风格目录与目标文件）、`realpath` 确认位于对应目录前缀内，并用 `detectImageContentType` 按魔数（PNG `89504e470d0a1a0a` / JPEG `ffd8ff`）判定 `Content-Type`。
- `fallbackReferenceImage` 通过 `parseDataImageUri` 解码后调用 `cropCover` 裁切（若极端尺寸导致 `cropCover` 抛错，降级 `previewFile: null` 而不阻断保存）。

- [ ] **Step 4: 运行测试验证通过**

Run: `node --test test/custom-cover-styles.test.js`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/custom-cover-styles.js test/custom-cover-styles.test.js
git commit -m "feat(cover): add custom cover style storage, atomic save, and secure preview IO"
```

---

### Task 3: 中性自定义填词管线、视觉拆解/微调与试生成核心

**Files:**
- Modify: `src/cover-prompt.js:17-70`
- Modify: `src/custom-cover-styles.js`
- Test: `test/custom-cover-styles.test.js`、`test/cover.test.js`

**Interfaces:**
- Consumes: `src/ai.js` (`callModel`, `extractJson`, `modelVisionSupport`), `src/cover-prompt.js` (`coverPrompt`, `buildCoverPromptRequest`, `loadCoverBlocklist`, `findBlocked`), `src/cover.js` (`generateCoverImage`), `src/cover-options.js` (`COVER_RESOLUTIONS`, `providerFormats`, `providerMeta`), `dist/image-crop.mjs` (`cropCover`).
- Produces in `src/cover-prompt.js`:
  - `buildCoverPromptRequest(title, markdown, style = 'classic', persona = {}, { hasReference = false, customStyle = null } = {})`:
    - `customStyle == null` 时逻辑与输出 **100% 逐字不变**；
    - `customStyle` 传入 `{ id, name, template, guidance, usePortrait }` 时，**不读内置 `SKILL.md`**，使用中性填词系统提示词，解析 `customStyle.template` 中的 `{{...}}` 槽位并返回同结构对象 `{ style, title, system, user, slots, template, terms, fragments, personSegments }`。
  - `coverPrompt(ctx, title, markdown, style = 'classic', persona = {}, { hasReference = false, customStyle = null } = {})` 透传 `customStyle`。
- Produces in `src/custom-cover-styles.js`:
  - `analyzeCustomCoverStyle(ctx, { referenceImages = [], requirement = '', draft = null, adjustment = '', signal } = {}) -> Promise<{ draft: { name, description, usePortrait, template, guidance, slots } }>`
  - `previewCustomCoverStyle(ctx, root, settings, { draft, testTitle, testMarkdown = '', resolution = '1K', onStage }, fetchImpl = fetch) -> Promise<{ draftToken, format, prompt, provider, model }>`

- [ ] **Step 1: 在 `test/custom-cover-styles.test.js` 与 `test/cover.test.js` 写失败测试**

覆盖以下断言：
1. **内置风格逐字不变**（`test/cover.test.js`）：对比 7 套内置风格的 `buildCoverPromptRequest` 结果，确认包含 `SKILL.md` 内容与原模板内容不变。
2. **自定义风格中性填词**（`test/custom-cover-styles.test.js`）：
   - `buildCoverPromptRequest` 传入 `customStyle` 时，`system` **不含** `林月半子` 或内置 `SKILL.md` 的「七种风格」「左字右人」；
   - `usePortrait: true` + `hasReference: true` 时，`coverPrompt` 展开 `[[SUBJECT]]`/`[[OUTFIT]]` 为用户 `persona` 片段；`usePortrait: false` 时不传参考图描述；
   - 模板正文包含 ```` ``` ```` 时 `slots` 完整提取无截断；命中 `blocklist.txt` 时自动带错误重试。
3. **`analyzeCustomCoverStyle`**：
   - 无参考图且无诉求 → 抛 `status: 400`；
   - 超 3 张参考图 / 非法 Data URL / 解码超 2 MB → 抛 `status: 400`；
   - 带参考图且 `modelVisionSupport === false` → 抛 `status: 400` 且 `callModel` 未被调用；
   - 带参考图且运行时报不支持图片 → 直接抛 `status: 400`（不降级纯文本）；
   - 首次模型返回的模板只有 1 个 `{{...}}` 槽位或含禁用词 → 自动带具体问题重试第 2 次并成功返回合法草稿；
   - 微调模式（传 `draft` + `adjustment` + `referenceImages`）：验证发送给模型的 user payload 包含传入的**最新编辑后 `draft`**（含手改后的 `template`、`usePortrait`）与 `adjustment`，且携带参考图。
4. **`previewCustomCoverStyle`**：
   - 校验草稿合法性（≥ 2 槽位、无禁用词）、分辨率、提供方 API Key（缺 Key 报错引导配置）；
   - 按 `draft.usePortrait` 决定是否传 `settings.portraitUrl`；
   - 依次回调 `onStage('prompt')` → `onStage('generating')` → `onStage('saving')`，生成图经 `cropCover` 裁切后写入 `_drafts/` 返回 `{ draftToken, format, prompt, provider, model }`；
   - MiniMax 超时原样透传 `err.code === 'MINIMAX_TIMEOUT'` 且 `nonRetryable === true`，不重试。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/custom-cover-styles.test.js test/cover.test.js`
Expected: FAIL，提示 `analyzeCustomCoverStyle` / `previewCustomCoverStyle` 未导出或 `customStyle` 未处理。

- [ ] **Step 3: 实现 `src/cover-prompt.js` 与 `src/custom-cover-styles.js` 的 AI 分析/试生成逻辑**

- 在 `src/cover-prompt.js` 中，当 `customStyle` 存在时：跳过 `read('SKILL.md')` 与 `read('references/prompt_template_...')`，直接使用 `customStyle.template`（校验非空且 `slots.length >= 2`）与可选 `customStyle.guidance`，拼装中性系统提示词（只保留槽位填空契约、`[[SUBJECT]]`/`[[OUTFIT]]`/`[[人物]]`/`[[服装]]` 占位说明、`blocklist.txt` 和防文章指令注入声明）。
- 在 `src/custom-cover-styles.js` 实现 `analyzeCustomCoverStyle`（校验 0–3 张参考图、严格视觉门禁 `strictImages: true`、拆解与微调双模式系统提示词、最多重试 1 次质检模板 ≥ 2 槽位 + 禁用词 + `usePortrait` 占位符约束）和 `previewCustomCoverStyle`（复用 `coverPrompt` + `generateCoverImage` + `cropCover` + `saveDraftPreview`；提供方格式取 `providerFormats(provider)[0]` 即 `png`）。

- [ ] **Step 4: 运行测试验证通过**

Run: `node --test test/custom-cover-styles.test.js test/cover.test.js`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/cover-prompt.js src/custom-cover-styles.js test/custom-cover-styles.test.js test/cover.test.js
git commit -m "feat(cover): add neutral custom cover prompt pipeline and style analysis/preview"
```

---

### Task 4: Host HTTP 路由、单活异步试生成任务表与文章封面生成集成

**Files:**
- Modify: `src/host.js`（`startCover`、`cover/image`、`cover/generate`、`cover/select` 及新增 `cover-styles/*` 路由）
- Create: `test/custom-cover-styles-routes.test.js`

**Interfaces:**
- Consumes: `src/custom-cover-styles.js`（全部导出）, `src/ai.js` (`modelVisionSupport`).
- Produces in `src/host.js` (HTTP routes under `/wechat-studio/`):
  - `GET cover-styles` → `{ styles, warnings, visionSupport, activeTestJob }`（自定义风格附 `previewUrl: previewFile ? 'wechat-studio/cover-styles/preview?id=...' : null`）
  - `GET cover-styles/item?id=<id>` → `{ style }`（完整字段含 `template`、`guidance`、`userRequirement`、`previewUrl`）
  - `GET cover-styles/preview?id=<id>` → 图片二进制（魔数 `Content-Type`、`cache-control: private, no-store`）
  - `GET cover-styles/draft-preview?token=<uuid>` → 图片二进制（魔数 `Content-Type`、`cache-control: private, no-store`）
  - `POST cover-styles/analyze` → `{ draft }`
  - `POST cover-styles/test-generate` → `{ jobId, status: 'running', stage: 'prompt' }`（并发运行中返回 `409` + `{ error, activeJobId }`）
  - `GET cover-styles/test-status?jobId=<id>`（无 `jobId` 时返回当前活跃/最近任务或 `null`）→ `{ jobId, status, stage, result?, error? }`
  - `POST cover-styles/save` → `{ style, styles, warnings }`
  - `POST cover-styles/delete` → `{ styles, warnings }`
  - 更新 `POST cover/generate`：按 `resolveCoverStyle(store.root, body.style)` 解析，按 `resolved.usePortrait` 决定 `referenceImage`，`record` 与 `article.cover` 写入 `styleName: resolved.name`，`cover/select` 同步保留 `run.styleName`；`cover/image?download=1` 传实时风格名或 `run.styleName` 给 `coverDownloadName`。

- [ ] **Step 1: 在 `test/custom-cover-styles-routes.test.js` 写失败测试**

覆盖以下全部场景：
1. `GET cover-styles` 返回 7 套内置 + 自定义列表、`visionSupport`（分别测 `true`/`false`/`null`）与 `activeTestJob: null`。
2. 完整闭环：`POST cover-styles/analyze` → `POST cover-styles/test-generate` → 轮询 `GET cover-styles/test-status` 至 `succeeded` → `GET cover-styles/draft-preview` 返回有效图片与魔数 `content-type` → `POST cover-styles/save`（带 `previewDraftToken`）→ `GET cover-styles/item` 与 `GET cover-styles/preview` 返回正确内容。
3. **单活锁防重复计费**：当一个试生成尚未完成时，再次 `POST cover-styles/test-generate` 返回 HTTP `409` 且响应含 `activeJobId`；同时 `GET cover-styles` 返回 `activeTestJob`（`status: 'running'`），完成后再查 `activeTestJob` / `test-status` 能接回 `result`。
4. **MiniMax 超时**：试生成遇到 `TimeoutError` 返回 `failed` 且 `error` 含 `600 秒` 与 `计费`（复用既有文案）、不自动重试（`fetchImpl` 只调 1 次）。
5. **内存任务 30 分钟 TTL**：向任务表测试超过 30 分钟的已完成任务被惰性清理，最多保留 20 条已完成记录。
6. **文章正式生成 + 删除后历史回退**：
   - 使用 `usePortrait: true` 的自定义风格调用 `POST cover/generate` → 生图请求携带 `settings.portraitUrl`，`coverRuns` 记录 `styleName`；
   - 使用 `usePortrait: false` 的自定义风格调用 `POST cover/generate` → 生图请求不带 `portraitUrl`；
   - `POST cover-styles/delete` 删除该自定义风格后，`GET cover/image?download=1` 仍成功下载且文件名保留该自定义风格的 `styleName`；`POST cover/select` 切换历史封面时保留 `styleName`；
   - 验证损坏预览/非法 `id`/`draftToken` 路由返回 `400`/`404`。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/custom-cover-styles-routes.test.js`
Expected: FAIL，提示路由 404。

- [ ] **Step 3: 实现 `src/host.js` 的异步任务表与全部 `cover-styles/*` 路由**

- 在 `src/host.js` 添加 `WeakMap` 结构的 `coverStyleTestJobs`（支持注入时间函数或导出清理阈值常量 `TEST_JOB_TTL_MS = 30 * 60 * 1000`、`MAX_TEST_JOB_HISTORY = 20` 便于测试），保证同一 `store` 仅 1 个 `running` 任务。
- 实现上述 9 个路由，注意所有 `GET cover-styles*` 路由放在 `const article = mustFind(...)` 之前（不依赖当前文章！）。
- 更新 `startCover`、`cover/generate`、`cover/select` 与 `cover/image` 下载文件名调用。

- [ ] **Step 4: 运行测试验证通过**

Run: `node --test test/custom-cover-styles-routes.test.js test/cover.test.js test/host.test.js`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/host.js test/custom-cover-styles-routes.test.js
git commit -m "feat(cover): add custom cover style routes, async test job lock, and cover generation integration"
```

---

### Task 5: CLI `--style` 与 `--prompt-only` 兼容本地自定义风格

**Files:**
- Modify: `src/cli.js:116-135,640-715`
- Test: `test/cli.test.js`

**Interfaces:**
- Consumes: `src/custom-cover-styles.js` (`listCoverStyles`, `resolveCoverStyle`), `src/cover-prompt.js` (`buildCoverPromptRequest`, `coverPrompt`).
- Produces: `wechat-studio cover <file> --style <custom-id>` 与 `--prompt-only` 支持本地自定义风格；未知风格错误消息同时列出内置风格与已存在的本地自定义风格 ID。

- [ ] **Step 1: 在 `test/cli.test.js` 写失败测试**

新增测试：
1. 在临时 `dataDir` 下通过 `saveCustomCoverStyle` 写入 1 套 `usePortrait: false` 与 1 套 `usePortrait: true` 自定义风格；
2. 执行 `cover <md> --style <custom-id> --prompt-only --json`：返回 `style: customId`、中性 `system`（不含内置 `SKILL.md` 文案）与正确 `slots`；
3. 执行 `cover <md> --style <custom-id>`（带 mock LLM + mock fetch）：`usePortrait: false` 不传 `portraitUrl`，`usePortrait: true` 传 `portraitUrl`，成功落盘；
4. 执行 `cover <md> --style nonexistent`：退出失败并在错误信息中提示不支持该封面风格。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test --test-name-pattern='自定义封面风格|cover' test/cli.test.js`
Expected: FAIL，提示不支持的封面风格。

- [ ] **Step 3: 更新 `src/cli.js` 的 `cover` 子命令**

- 将 `resolveDataDir` 提前到校验 `--style` 之前；用 `resolveCoverStyle(dataDir, values.style)` 校验风格，查不到时读 `listCoverStyles(dataDir)` 在报错中列出全部可用风格 ID。
- `referenceImage = resolved.usePortrait ? (settings.portraitUrl || null) : null`。
- 若 `resolved.source === 'custom'`，向 `buildCoverPromptRequest` / `coverPrompt` 传 `customStyle: resolved`。
- 更新 `cover` 帮助文案注明支持内置及本地自定义风格 ID。

- [ ] **Step 4: 运行测试验证通过**

Run: `node --test test/cli.test.js`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/cli.js test/cli.test.js
git commit -m "feat(cli): support custom cover styles in cover command"
```

---

### Task 6: 共享前端图片压缩、向导纯状态模型、状态层与自定义封面风格向导/管理卡片

**Files:**
- Create: `client/image-input.js`
- Create: `client/custom-cover-style-model.js`
- Create: `test/custom-cover-style-model.test.js`
- Modify: `client/derive.jsx:150-205`
- Modify: `client/state.js`
- Create: `client/custom-cover-style.jsx`

**Interfaces:**
- Produces in `client/image-input.js`:
  - `compressReferenceImageFile(file: File) -> Promise<string>`（长边 ≤ 960px，≤ 420 KB JPEG Data URL，原文件上限 6 MB）
  - `extractClipboardImageFiles(event: ClipboardEvent) -> File[]`
- Produces in `client/custom-cover-style-model.js`:
  - `createWizardDraft(initial?: object) -> object`
  - `isWizardDirty(initial: object, current: object) -> boolean`
  - `markPreviewStaleOnDraftChange(prev: object, next: object) -> boolean`
  - `buildRefinePayload(current: object, adjustment: string) -> object`（强制携带用户当前最新编辑态 `name`/`description`/`usePortrait`/`template`/`guidance` 与会话内 `referenceImages`）
  - `buildSavePayload(current: object, mode: 'create'|'edit') -> object`（按优先级解析 `previewDraftToken` > 本次新上传参考图 `fallbackReferenceImage` > 编辑模式保留旧预览）
  - `applyTestJobToDraft(current: object, job: object) -> object`
- Produces in `client/state.js`:
  - State fields: `coverStyles`（`{ styles, warnings, visionSupport, activeTestJob, loading, error }`）, `customCoverWizard`（`{ open, mode: 'create'|'edit', styleId, returnTo: 'cover'|'skills'|null, draftSession }`）, `selectedCoverStyleId`（保存后自动选中回填）.
  - Actions: `loadCoverStyles()`, `loadCustomCoverStyle(id)`, `analyzeCustomCoverStyle(payload)`, `startCustomCoverStyleTest(payload)`, `pollCustomCoverStyleTest(jobId?)`, `saveCustomCoverStyle(payload)`, `deleteCustomCoverStyle(id)`, `openCustomCoverStyleWizard(opts)`, `closeCustomCoverStyleWizard(opts)`.
- Produces in `client/custom-cover-style.jsx`:
  - `CustomCoverStyleCard`: 挂载在 `SkillsView` 中 `WritingStyleCard` 下方；展示自定义风格缩略图列表、数量、后台试生成恢复横幅、「新建自定义风格」按钮及每项的「编辑」「删除」（带确认）。
  - `CustomCoverStyleWizard`: 独立 2 步向导弹窗（不依赖 `data?.current`），所有交互状态由 `client/custom-cover-style-model.js` 驱动。

- [ ] **Step 1: 在 `test/custom-cover-style-model.test.js` 写向导纯状态机失败测试**

覆盖以下断言：
1. `isWizardDirty`：未改动返回 `false`；上传参考图、修改诉求/名称/模板/开关或产生新 `previewDraftToken` 后返回 `true`。
2. `markPreviewStaleOnDraftChange`：当已有预览图（原正式预览或试生成图）且修改 `template`/`guidance`/`usePortrait`/替换参考图时返回 `true`；仅改 `name` 或无预览图时返回 `false`；`applyTestJobToDraft` 收到 `succeeded` 新样图后清除过期标记并写入 `previewDraftToken`。
3. `buildRefinePayload`：用户手改 `template` 和 `usePortrait` 后，输出里的 `draft` 反映**最新手改值**而非初始分析值，并携带 `referenceImages` 和 `adjustment`。
4. `buildSavePayload`：有 `previewDraftToken` 时优先传 `previewDraftToken`；无试生成且新建有参考图时传第 1 张为 `fallbackReferenceImage`；编辑模式未重新试图也未换图时不传 `fallbackReferenceImage`（保留原预览）。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/custom-cover-style-model.test.js`
Expected: FAIL，提示模块不存在。

- [ ] **Step 3: 实现 `client/custom-cover-style-model.js` 并跑通测试**

Run: `node --test test/custom-cover-style-model.test.js`
Expected: 全部 PASS。

- [ ] **Step 4: 创建 `client/image-input.js` 并在 `client/derive.jsx` 复用**

从 `client/derive.jsx` 抽出 `loadBrowserImage`、`compressReferenceImageFile`、`extractClipboardImageFiles` 到 `client/image-input.js`，保持 `client/derive.jsx` 行为不变。

- [ ] **Step 5: 扩展 `client/state.js` 并实现 `client/custom-cover-style.jsx`**

- `startCustomCoverStyleTest` 发起 `POST cover-styles/test-generate` 后 900ms 轮询 `GET cover-styles/test-status?jobId=...`，遇 `409` 自动附着到 `activeJobId` 轮询；`loadCoverStyles()` 发现 `activeTestJob?.status === 'running'` 自动恢复轮询；关闭向导保留运行中的 `draftSession` 供「返回查看」还原。
- `CustomCoverStyleWizard` 绑定 `isWizardDirty` 关闭确认、`markPreviewStaleOnDraftChange` 过期提示条、`buildRefinePayload` 最新草稿微调、`buildSavePayload` 预览优先级、折叠模板编辑区（实时展示槽位计数并校验 ≥ 2 个槽位）与 `usePortrait` 一致性提示。

- [ ] **Step 6: 构建并运行前端纯逻辑测试**

Run: `npm run build && node --test test/custom-cover-style-model.test.js`
Expected: `dist/client.js` 构建成功，测试全部 PASS。

- [ ] **Step 7: Commit**

```bash
git add client/image-input.js client/custom-cover-style-model.js test/custom-cover-style-model.test.js client/derive.jsx client/state.js client/custom-cover-style.jsx dist/client.js
git commit -m "feat(ui): add custom cover style model, state, wizard, and skills card"
```

---

### Task 7: 接入双入口 UI、样式与全量回归验收

**Files:**
- Modify: `client/app.jsx`（`CoverStyleDialog`、`CoverHistoryDialog`、`SkillsView`、`Studio`、`SKILL_INFO.cover`）
- Modify: `client/styles.css`
- Verify: 全量测试 + 构建 + 打包校验 + 安装包冒烟

**Interfaces:**
- Consumes: `client/custom-cover-style.jsx` (`CustomCoverStyleCard`, `CustomCoverStyleWizard`), `client/state.js` (`loadCoverStyles`, `deleteCustomCoverStyle`, `openCustomCoverStyleWizard`), `src/cover-styles.js` (`COVER_STYLES`, `resolveCoverStyleName`).

- [ ] **Step 1: 更新 `client/app.jsx`**

1. **`CoverStyleDialog`**：
   - 打开时并行拉取 `loadSettings()` 与 `loadCoverStyles()`；合并列表优先用 `coverStyles.styles`，加载前用内置 `COVER_STYLES` 兜底不闪烁。
   - 若存在 `selectedCoverStyleId`（刚保存完返回），自动设为当前选中并清空该一次性标志；若当前选中风格被删，自动回落到 `'classic'`。
   - 若存在后台运行中或已就绪的 `activeTestJob`，弹窗顶部展示轻提示条与「返回查看」按钮。
   - 自定义风格卡片显示 `自定义` 角标、2.35:1 预览图（无 `previewUrl` 时展示简洁文字占位卡，支持 `CoverZoom` 悬浮放大，仅在有图时放大），以及「编辑」「删除」（带确认弹窗，告知不影响已生成封面）按钮。
   - 网格末尾添加虚线 `+ 自定义风格` 卡片，点击调用 `openCustomCoverStyleWizard({ mode: 'create', returnTo: 'cover' })`。
   - 弹窗底部说明栏展示当前选中风格的 `description`。
2. **`CoverHistoryDialog`**：
   - `styleName` 改为使用 `resolveCoverStyleName(item.style, coverStyles?.styles, item.styleName)`，删除自定义风格后历史批次与详情标题仍正确显示原风格名，旧记录兼容内置名与 `'封面'`。
3. **`SkillsView`**：
   - 在 `<WritingStyleCard />` 正下方挂载 `<CustomCoverStyleCard />`；并更新 `SKILL_INFO.cover` 文案反映 7 套内置风格与自定义封面风格支持。
4. **`Studio`**：
   - 在根层级独立挂载 `{customCoverWizard?.open ? <CustomCoverStyleWizard /> : null}`，不依赖 `data?.current`。

- [ ] **Step 2: 更新 `client/styles.css`**

沿用现有 `ws-dialog`、`ws-cover-*`、`ws-style-card`、`ws-style-wizard` 设计变量与间距，补充自定义封面卡片角标、悬浮编辑/删除按钮、虚线 `+ 自定义风格` 卡片、无图 2.35:1 文字占位卡、参考图缩略图列表、过期样图提示角标、折叠模板编辑区与后台试生成状态条样式。

- [ ] **Step 3: 构建并运行全量验证与打包冒烟**

Run: `npm run build && npm test && npm run check:package && npm run smoke:package`
Expected:
- `dist/client.js`、`dist/image-crop.mjs`、`dist/unpdf.mjs` 构建成功；
- `npm test` 所有测试套件 100% PASS（覆盖 Spec Section 10 的全部 10 类回归项）；
- `npm run check:package` 通过（零依赖、无冲突标记）；
- `npm run smoke:package` 通过（安装包冒烟与 CLI 正常）。

- [ ] **Step 4: 检查工作区并提交**

Run: `git diff --check && git status --short`
Expected: 无空白错误，仅含计划内文件。

```bash
git add client/app.jsx client/styles.css dist/client.js
git commit -m "feat(ui): wire custom cover styles into cover dialog, history, and skills view"
```
