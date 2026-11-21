# 发布防踩坑体检（Preflight Health Check）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 DSH 插件与独立 CLI 增加零模型成本、100% 确定性的「发布防踩坑体检」引擎，覆盖媒体/占位/标题阻断检查、商单外链提醒（绝不阻断）、手机端文字墙与视觉节奏、内置合规词与用户自定义提醒词检查。

**Architecture:** 新增纯 JS 零依赖核心模块 `src/preflight.js` 作为体检与媒体/占位扫描的唯一事实来源；在 `src/settings.js` 扩展 `preflightWords` 自定义提醒词；CLI 新增 `wechat-studio check <file.md|->` 并将其完整 `preflight` 结构接入 `draft push`（`--dry-run` 与正式推送同构）；DSH 宿主通过 `src/host.js` 将 `preflight` 投影到 `current.preflight`，前端在右侧「质检」Tab 中将「发布防踩坑体检」与「AI 味检测（朱雀）」分成两个独立分区，并在「设置」新增独立的「发布体检」分类。全程不改动 `vendor/layout/layout.js` 的 `renderPage`，确保黄金测试逐字节一致。

**Tech Stack:** Node.js `>=20` ESM（零运行时依赖）、React 18（`client/`）、`node:test` + `node:assert/strict`。

**Spec:** 用户确认采用方案 A（聚焦文字、链接与合规体检，不含信息流卡片预览）并补齐以下 5 项契约：
1. **标题阈值与现有发布逻辑对齐**：沿用 `src/wechat.js` 的 `MAX_TITLE = 32`；空标题（0 字）与超 32 字均为 `blocking`，体检始终校验最终生效标题（含 `draft push --title` 覆盖值）。
2. **双形态阻断语义清晰一致**：CLI `draft push` 遇到任意 `blocking` 项（含飞书图、本地图、占位、空标题、>32 字标题）默认以退出码 `2` 拦截（微信请求数为 `0`），传 `--force` 可显式绕过所有 `blocking` 项（超 32 字标题推送时按 `MAX_TITLE = 32` 截断并附带提醒）；DSH 界面本期在「发布防踩坑体检」面板实时展示阻断/提醒并支持跳段，推送确认仍沿用排版预览页现有的二次确认弹层（不改动 `renderPage` 黄金输出，也不破坏已确认推送流程）。
3. **单一事实来源与排版专属检查保留**：`src/preflight.js` 负责全部正文/媒体/占位/链接/标题/可读性/合规词检查并产出精确块号；`renderWechatHtml` 产出的排版专属提醒（外部图床、视频占位、SVG 禁写属性、动画卡 >3 张、横幅警告）通过去重合并保留，不丢失也不重复。
4. **CLI 失败 JSON 合约与字段统一**：`check --fail-on-blocking` 阻断时返回退出码 `1` 并输出含 `ok: false, code: "PREFLIGHT_BLOCKED", passed: false, counts, stats, items` 的完整 JSON；`draft push` 的 `--dry-run` 与正式推送统一返回 `preflight` 对象（并保留 `issues` 与 `warnings` 兼容现有输出）。
5. **交互分区与免责说明**：右侧「质检」Tab 拆分为「发布防踩坑体检（本地即时 · 零成本）」与「AI 味检测（朱雀）」两个独立分区，有未保存段落时提示「保存后更新」；设置页新增独立「发布体检」分类；README 明确说明「风险词检查仅供人工复核，不代表微信官方审核结论」。

## Global Constraints

- 零运行时依赖（`package.json` 不新增 `dependencies`），仅使用 Node.js `>=20` 内置模块。
- 不修改 `vendor/layout/layout.js` 的 `renderPage` 输出，确保 `test/layout-golden.test.js` 逐字节 SHA-256 校验通过。
- 分级语义严格区分：
  - `blocking`：飞书临时图、本地/base64 图、`[可补/截图]` 占位、空标题、标题超过 32 字（与 `src/wechat.js` `MAX_TITLE = 32` 一致）。
  - `warn` / `info`：链接（商单外链提醒）、单段超 160 字文字墙、连续超 600 字无停顿、内置合规词、自定义提醒词——**仅提醒，绝不阻断发布**。
- 体检默认跳过围栏代码块（`` ``` `` / `~~~`）与行内反引号代码，并在合规词检查时剔除 `settings.fixedLines` 固定句。
- 所有修改保持 DSH 插件与独立 CLI 双形态零回归，配置写入复用 `withFileLock` + `writeJsonAtomic`。

## Review Focus

- **标题边界与覆盖值**：空标题（`""`）、32 字（通过）、33 字（`blocking`）、以及 `draft push --title` 覆盖后的最终标题校验。
- **链接精确提取与去重**：Markdown 链接 `[文字](https://example.com/a)` 不被裸 URL 正则重复计数；URL 末尾紧跟中文标点或右括号（如 `（https://example.com/b）。`）不把标点吃进 URL；图片语法 `![图](https://cdn.example.com/1.png)` 与代码块内 URL 不计入链接。
- **手机端文字墙与连续段重置**：160 字（通过）vs 161 字（`warn`）；连续纯文字 600 字（通过）vs 601 字（`info`）；中间出现标题、图片、引用、列表、表格或动画卡时必须重置连续字数累计。
- **`preflightWords` 异常输入与截断去重**：非数组、空数组（清空）、前后空白、超过 100 条截断、单条超过 60 字先截断再去重（截断后同名的只保留一条）。
- **DSH 未保存段落状态与跳段边界**：存在未保存段落时体检区显示「有 N 段未保存，保存后更新」；带 `blockId` 的条目可点击跳段，标题项（`blockId: null`）渲染为静态条目不可跳段；未配置朱雀 Key 时本地体检照常可用。

---

### Task 1: 实现零依赖体检核心引擎 `src/preflight.js`

**Files:**
- Create: `src/preflight.js`
- Test: `test/preflight.test.js`

**Interfaces:**
- Consumes: `splitMarkdown`, `blockKind` from `./article.js`
- Produces:
  - `export const MAX_WECHAT_TITLE = 32`（与 `src/wechat.js` `MAX_TITLE` 对齐）
  - `export const DEFAULT_COMPLIANCE_WORDS`: `{ share: string[], extreme: string[] }`
  - `export function extractLinks(text)`: `string[]`（跳过行内代码与图片语法，提取 Markdown 链接和裸 URL 并去重、剥离尾部标点）
  - `export function runPreflight(input, options = {})`
    - `input`: `{ title?: string, markdown?: string, blocks?: Array<{ id?: string, text: string }> }`
    - `options`: `{ fixedLines?: string[], customWords?: string[], maxParagraphChars?: number, maxDenseChars?: number, layoutIssues?: string[] }`
    - Returns: `{ ok: boolean, counts: { blocking: number, warn: number, info: number }, stats: { chars: number, titleChars: number, links: number, images: number, longParagraphs: number }, items: Array<{ id: string, severity: 'blocking'|'warn'|'info', category: 'media'|'title'|'links'|'readability'|'compliance'|'layout', title: string, detail: string, blockId: string|null, blockNumber: number|null, matches?: string[] }> }`

- [ ] **Step 1: 编写失败测试 `test/preflight.test.js`**

覆盖以下边界与断言：
1. 干净文章（标题 12 字、短段落、公网图）返回 `ok: true`、`counts: { blocking: 0, warn: 0, info: 0 }`。
2. 标题边界：空标题 `""` -> `blocking`（`id: 'title-empty'`）；32 字标题 -> 通过；33 字标题 -> `blocking`（`id: 'title-too-long'`）。
3. 媒体与占位阻断：飞书临时图、本地相对路径图、`data:` base64 图、`[可补：...]` / `[截图：...]` 占位均返回 `blocking` 且 `ok: false`；代码块内同类示例不触发。
4. 链接提取与商单提醒：
   - `[官网](https://example.com/a)` 仅计数 1 次（不被裸 URL 规则重复计数）；
   - `详情见（https://example.com/b）。` 正确剥离末尾 `）` 和 `。`；
   - `![图](https://cdn.example.com/1.png)` 与代码块内 URL 不计入链接；
   - 含多个链接时归类为 `id: 'external-link'`、`severity: 'warn'`、**`ok` 仍为 `true`（绝不阻断）**。
5. 文字墙与视觉节奏边界：
   - 单段去标记后 160 字通过、161 字触发 `long-paragraph`（`warn`，带 `blockId`/`blockNumber`）；
   - 连续纯文字段累计 600 字通过、601 字触发 `dense-run`（`info`）；
   - 中间插入标题 / 图片 / 引用 / 列表时重置累计，不误报 `dense-run`。
6. 合规词与自定义词：内置诱导分享词（`转发抽奖`）、极限词（`全网第一`）与 `customWords`（`竞品A`）触发 `warn`（不阻断）；位于代码块内或命中 `fixedLines` 的整行不误报。
7. 排版专属提醒合入与去重：传入 `options.layoutIssues`（包含飞书/本地/占位旧文案 + 视频占位/外部图床/SVG 提醒）时，自动过滤掉已由 `preflight` 检出的飞书/本地/占位重复项，保留视频占位、外部图床、SVG、动画卡等排版专属项（`category: 'layout'`、`severity: 'warn'`）。
8. `article.blocks` 输入时块级问题准确带出 `blockId` 与 `blockNumber`（1-indexed），标题项 `blockId: null, blockNumber: null`。

- [ ] **Step 2: 运行测试确认失败**

Run: `export PATH="/opt/homebrew/opt/nodejs/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" && node --test test/preflight.test.js`
Expected: FAIL（`../src/preflight.js` 不存在）

- [ ] **Step 3: 实现 `src/preflight.js`**

- 零运行时依赖；复用 `splitMarkdown` / `blockKind`。
- 明确剥离围栏代码块与行内反引号代码；`extractLinks` 先剥图片语法 `!\[...\]\(...\)`、提取 `[text](url)` 后占位替换，再提取剩余裸 `https?://...` 并裁剪尾部中文标点与不成对括号。
- `layoutIssues` 合并时按关键字过滤已由本模块检出的飞书临时图、本地图、占位符，保留外部图床、视频占位、SVG 禁写属性、动画卡 >3 张、横幅警告。

- [ ] **Step 4: 运行测试确认通过**

Run: `export PATH="/opt/homebrew/opt/nodejs/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" && node --test test/preflight.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/preflight.js test/preflight.test.js
git commit -m "feat(preflight): add zero-dependency pre-publish health check engine"
```

---

### Task 2: 在 `src/settings.js` 中扩展自定义体检词 `preflightWords`

**Files:**
- Modify: `src/settings.js`
- Test: `test/preflight.test.js`

**Interfaces:**
- Consumes: `readSettings`, `updateSettings`, `publicSettings` in `src/settings.js`
- Produces:
  - `settings.preflightWords: string[]`（默认 `[]`）
  - `publicSettings(settings).preflightWords: string[]`

- [ ] **Step 1: 在 `test/preflight.test.js` 编写 `preflightWords` 边界失败测试**

断言：
- 默认读取为 `[]`；
- 非数组输入被安全忽略（不报错、不破坏原值）；
- 空数组 `[]` 可清空已保存词表；
- 超过 60 字的词先截断到 60 字再去重（截断后相同只保留一条）；
- 超过 100 条截断到 100 条；`publicSettings` 透出 `preflightWords`。

- [ ] **Step 2: 运行测试确认失败**

Run: `export PATH="/opt/homebrew/opt/nodejs/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" && node --test test/preflight.test.js`
Expected: FAIL（`preflightWords` 为 `undefined`）

- [ ] **Step 3: 修改 `src/settings.js`**

- 新增 `cleanPreflightWords(value)`：校验 `Array.isArray`，每项 trim 后 `.slice(0, 60)`，过滤空串，用 `Set` 去重，`.slice(0, 100)`。
- 在 `DEFAULTS`、`readSettings`、`updateSettings`、`publicSettings` 中接入 `preflightWords`。

- [ ] **Step 4: 运行测试确认通过**

Run: `export PATH="/opt/homebrew/opt/nodejs/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" && node --test test/preflight.test.js test/wechat.test.js test/host.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/settings.js test/preflight.test.js
git commit -m "feat(settings): persist custom preflightWords with deduplication and bounds"
```

---

### Task 3: CLI 接入 `wechat-studio check` 与 `draft push` 统一 `preflight` 契约

**Files:**
- Modify: `src/cli.js`
- Modify: `skills/cli-agent/SKILL.md`
- Modify: `README.md`
- Test: `test/cli.test.js`

**Interfaces:**
- Consumes: `runPreflight` from `./preflight.js`
- Produces:
  - `wechat-studio check <file.md|-> [--title <标题>] [--fail-on-blocking] [--data-dir <path>] [--json]`
    - 通过（或未传 `--fail-on-blocking`）：退出码 `0`，JSON `{ ok: true, passed, counts, stats, items }`
    - `--fail-on-blocking` 且存在 `blocking`：退出码 `1`，JSON `{ ok: false, code: "PREFLIGHT_BLOCKED", passed: false, counts, stats, items }`
  - `wechat-studio settings set --preflight-words <词1,词2,...>`（传 `""` 清空）
  - `wechat-studio draft push`（`--dry-run` 与正式推送同构）：
    - 基于最终生效标题（含 `--title` 覆盖）运行 `runPreflight(..., { layoutIssues: rendered.issues })`；
    - `blocking` 项（含飞书图、本地图、占位、空标题、>32 字标题）默认拦截正式推送（退出码 `2`，微信请求数为 `0`），`--force` 可绕过全部 `blocking` 项（超 32 字标题在微信推送层截断并在 `warnings` 附提醒）；
    - JSON 统一返回 `preflight`（完整体检对象），同时保留 `issues` 与 `warnings` 兼容现有调用方。

- [ ] **Step 1: 在 `test/cli.test.js` 编写失败测试**

断言：
1. `wechat-studio check --help` 退出码 `0`。
2. 含多个外链、合规词和超长段的文章跑 `check <md> --fail-on-blocking --json`：返回退出码 `0`、`ok: true, passed: true`、`counts.blocking === 0`、`counts.warn >= 3`。
3. 含本地图片或 33 字标题的文章跑 `check <md> --fail-on-blocking --json`：返回退出码 `1`，stdout 为完整结构化 JSON（`ok: false, code: "PREFLIGHT_BLOCKED", passed: false, counts, stats, items`）。
4. `draft push`：
   - 33 字标题未加 `--force` 被拦截（退出码 `2`，`fetchImpl` 调用次数为 `0`）；用 `--title "20字以内的合规短标题"` 覆盖后放行成功；加 `--force` 也可放行。
   - 含外链 + 合规词 + 文字墙（无阻断项）的文章正式推送**直接成功**，JSON 返回 `preflight` 与 `warnings`，且 `--dry-run` 与正式推送的 `preflight` 结构一致。
5. `settings set --preflight-words "竞品A,竞品B"` 后，`check` 命中 `竞品A`；传 `--preflight-words ""` 后清空不再命中。

- [ ] **Step 2: 运行测试确认失败**

Run: `export PATH="/opt/homebrew/opt/nodejs/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" && node --test test/cli.test.js`
Expected: FAIL（`未知命令：check`）

- [ ] **Step 3: 实现 `handleCheck` 并更新 `handleSettings`、`handleDraft`、`HELP_TEXT`、`SUB_HELP`、`VALUE_FLAGS` 及文档**

- `src/cli.js`：实现 `handleCheck`、`formatPreflightText`，统一 `draft push` 的 `preflight` 校验与去重合并；更新 `settings get` 摘要与 `settings set --preflight-words`。
- `skills/cli-agent/SKILL.md` 与 `README.md`：补充 `check` 子命令、DSH 体检面板说明，并明确标注「风险词检查仅供人工复核，不代表微信官方审核结论」。

- [ ] **Step 4: 运行测试确认通过**

Run: `export PATH="/opt/homebrew/opt/nodejs/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" && node --test test/cli.test.js test/preflight.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/cli.js test/cli.test.js skills/cli-agent/SKILL.md README.md
git commit -m "feat(cli): add check command and unify preflight contract in draft push"
```

---

### Task 4: DSH Host 投影与前端分区 UI（「发布防踩坑体检」+ 独立设置项）

**Files:**
- Modify: `src/host.js`
- Modify: `client/app.jsx`
- Modify: `client/styles.css`
- Build: `dist/client.js`
- Test: `test/host.test.js`

**Interfaces:**
- Consumes: `runPreflight` from `./preflight.js`
- Produces:
  - `snapshotState` 中 `current.preflight`（由 `view()` 调用 `runPreflight({ title: article.title, blocks: article.blocks }, { fixedLines: settings.fixedLines, customWords: settings.preflightWords })` 生成）
  - 前端 `QualityPane` 拆分为两个独立 `<section>`：
    1. `PreflightPane`：**「发布防踩坑体检」**（副标题 `本地即时 · 零成本`；`unsavedCount > 0` 时显示 `有 N 段未保存，保存后更新`；展示阻断/提醒/链接统计；带 `blockId` 的条目渲染为按钮支持点击跳段，标题项 `blockId == null` 渲染为静态条目不可点击；未配置朱雀 Key 时照常完整可用）
    2. 原朱雀区标题明确改为 **「AI 味检测（朱雀）」**
  - 前端 `SettingsDialog` 新增独立左侧分类 **「发布体检」**（编辑 `preflightWords`，每行一词，附免责提示「仅供人工复核，不代表微信官方审核结论」）

- [ ] **Step 1: 在 `test/host.test.js` 编写失败测试**

断言：
- `GET /wechat-studio/state` 返回 `current.preflight`，对含外链和 33 字标题的稿件准确返回 `counts.blocking === 1`、`counts.warn >= 1`，块级条目带 `blockId`，标题条目 `blockId === null`。
- `POST /wechat-studio/settings` 保存 `preflightWords: ['竞品X']` 后，`GET /wechat-studio/state` 的 `current.preflight` 立即命中 `竞品X`。

- [ ] **Step 2: 运行测试确认失败**

Run: `export PATH="/opt/homebrew/opt/nodejs/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" && node --test test/host.test.js`
Expected: FAIL（`current.preflight` 为 `undefined`）

- [ ] **Step 3: 更新 `src/host.js`、`client/app.jsx`、`client/styles.css` 并构建 `dist/client.js`**

- `src/host.js`：引入 `runPreflight`，在 `view()` 返回对象上挂载 `preflight`。
- `client/app.jsx`：
  - 将 `unsavedCount` 传入 `QualityPane`，在上方渲染独立分区 `PreflightPane`（带未保存提示、可跳段列表与静态标题项），原朱雀区块标题改为 `AI 味检测（朱雀）`。
  - 在 `SettingsDialog` 的 `pages` 中新增 `preflight` 分类（「发布体检」），提交时序列化 `preflightWords`。
- `client/styles.css`：新增 `.ws-preflight*` 样式。
- 运行 `npm run build` 更新 `dist/client.js`。

- [ ] **Step 4: 运行全量测试与黄金测试验证零回归**

Run: `export PATH="/opt/homebrew/opt/nodejs/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" && npm run build && npm test && git diff --check`
Expected: PASS（全量测试及 `test/layout-golden.test.js` 逐字节校验 100% 通过）

- [ ] **Step 5: 提交**

```bash
git add src/host.js client/app.jsx client/styles.css dist/client.js test/host.test.js
git commit -m "feat(ui): add standalone preflight health check section and settings page"
```

### 手工验收清单（Task 4 完成后在 DSH 桌面/网页版核对）
- 保存正文后右侧「发布防踩坑体检」即时刷新；存在未保存段落时显示「有 N 段未保存，保存后更新」。
- 点击带段号的提醒项准确跳转并高亮目标段落；标题项渲染为静态条目不可跳段。
- 未配置朱雀 API Key 时，本地体检区完整可用，且视觉上与下方「AI 味检测（朱雀）」清晰分离。
- 在「设置 → 发布体检」填入自定义词并保存后，回到稿面立即生效。
