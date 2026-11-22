# 小红书参考图自动分配 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 整套小红书生成最多接收 10 张参考图，由模型在现有整套策划阶段识别封面、内容版式和共享风格并自动分配到页面，后续分批生成只携带相关图片；参考图可跨页复用，未分配页面自由设计。

**Architecture:** 沿用现有两阶段生成，不新增模型调用。阶段 1 接收带稳定 ID 的全部参考图，除现有卡片蓝图外额外产出 `referencePlan`；代码清洗并持久化该计划，阶段 2 按页取共享风格图和本页专属图，每批只发送这些页面的图片并集，同时在每张目标卡片上注明可用图片 ID。模型负责语义分配，代码负责确定性分发和非法分配兜底。

**Tech Stack:** Node.js >= 20 ESM、React 18、DSH `ctx.llm` / `ctx.attachments`、浏览器 Canvas、`node:test`、`node:assert/strict`，不新增依赖。

---

## 已确认的产品决策

- 采用 **A 策略**：参考图少于页面数时，模型可将最合适的图复用到多页；没有分配参考图的页面依据文章内容自由设计，不提示用户补图。
- 不要求用户手动维护“图片 → 页面”映射，也不在默认流程增加配置步骤。
- 整套参考图上限从 3 提高到 **10**；单页手动重设计仍最多临时上传 **2** 张，行为不变。
- 每页最多 **2 张专属参考图 + 1 张共享风格参考图**。同一图片可出现在多个页面。
- 参考图角色只有 `cover | content | style`：封面图只能用于第 1 页，内容图不能用于封面，只有风格图可进入 `sharedImageIds`。
- 不改变当前小红书 **5–8 页**卡片约束，不增加“参考图分析”模型调用，不修改 PNG 导出和画布编辑逻辑。

## 当前工作区注意事项

当前暂存区已有两项未提交修复：`src/ai.js` 和 `test/derive.test.js`，用于先把 Base64 参考图保存为 DSH attachment，修复 `Cannot read properties of undefined (reading 'attachmentId')`。执行本计划时先完成 Task 0 的验证和独立提交，**不要 reset、覆盖或丢失这两处修改**。

## 数据契约

阶段 1 在现有 `<xhs-meta>` JSON 中新增可选 `referencePlan`：

```json
{
  "referencePlan": {
    "images": [
      { "id": "ref-1", "role": "cover", "reason": "巨型标题和主视觉窗口，适合封面" },
      { "id": "ref-2", "role": "content", "reason": "三阶段时间轴，适合步骤页" },
      { "id": "ref-3", "role": "style", "reason": "暖色便签和细线网格，可统一整套气质" }
    ],
    "sharedImageIds": ["ref-3"],
    "pages": [
      { "page": 1, "imageIds": ["ref-1"] },
      { "page": 3, "imageIds": ["ref-2"] },
      { "page": 5, "imageIds": ["ref-2"] }
    ]
  }
}
```

规则：

- ID 由代码按上传顺序生成：`ref-1` 到 `ref-10`，模型不能自定义图片 ID。
- `pages` 只列出有专属参考图的页面；缺页表示无专属图，不是错误。
- 图片可复用；每页 ID 去重后最多 2 个，`sharedImageIds` 最多 1 个。
- 无效 ID、越界页码、角色冲突和非法字段由代码剔除，不触发整套生成失败。
- `referencePlan` 只保存 ID、角色、简短理由和页码，**不得把 Base64 图片写进派生稿**。
- 没有有效 `referencePlan` 时，阶段 2 不广播全部参考图，而是按无参考图自由设计并追加警告。

---

### Task 0: 验证并独立提交现有 DSH attachment 修复

**Files:**
- Modify already staged: `src/ai.js`
- Test already staged: `test/derive.test.js`

- [ ] **Step 1: 运行附件回归与独立 CLI 传图测试**

Run:

```bash
node --test --test-name-pattern='DSH 参考图先保存为附件|小红书整套生成与单页重设计支持上传参考图' test/derive.test.js
node --test --test-name-pattern='createStandaloneCtx 将参考图' test/cli.test.js
```

Expected: 两组均 PASS；DSH 测试确认 `saveImage()` 返回的附件以 `{ type: 'image', attachment }` 发送。

- [ ] **Step 2: 检查暂存区只包含预定修复**

Run: `git diff --cached --check && git diff --cached --stat`
Expected: 只有 `src/ai.js` 和 `test/derive.test.js`，无空白错误。

- [ ] **Step 3: Commit**

```bash
git commit -m "fix(xhs): persist reference images as DSH attachments"
```

- [ ] **Step 4: 独立提交执行计划**

```bash
git add docs/plans/2026-11-22-xhs-reference-image-routing.md
git commit -m "docs: plan xhs reference image routing"
```

---

### Task 1: 建立参考图计划、角色约束与按页选图纯函数

**Files:**
- Modify: `src/derive-shared.js:8-40,80-93,875-1197`
- Test: `test/derive-shared.test.js`

**Interfaces:**

```js
DERIVE_LIMITS.xhs.referenceImages = 10
DERIVE_LIMITS.xhs.referenceImagesPerCard = 2
DERIVE_LIMITS.xhs.sharedReferenceImages = 1

normalizeXhsReferencePlan(rawPlan, {
  cards = [],
  referenceImageIds = [],
}) -> {
  images: Array<{ id, role: 'cover'|'content'|'style', reason }>,
  sharedImageIds: string[],
  pages: Array<{ page, imageIds: string[] }>,
} | null

selectXhsReferenceImages(referenceImages, referencePlan, cardIndex)
  -> Array<{ id: string, dataUrl: string }>
```

`selectXhsReferenceImages` 按“共享风格图在前、本页专属图在后”返回并去重；图片 ID 始终按原始数组的 `ref-${index + 1}` 解析，不信任计划中的 Base64 或 URL。

- [ ] **Step 1: 写失败测试**

在 `test/derive-shared.test.js` 导入两个新函数，覆盖：

```js
const refs = [
  'data:image/png;base64,AA==',
  'data:image/png;base64,BB==',
  'data:image/png;base64,CC==',
]
const cards = [{ kind: 'cover' }, { kind: 'steps' }, { kind: 'quote' }]
const rawPlan = {
  images: [
    { id: 'ref-1', role: 'cover', reason: '封面' },
    { id: 'ref-2', role: 'content', reason: '步骤' },
    { id: 'ref-3', role: 'style', reason: '共享风格' },
    { id: 'ref-99', role: 'content', reason: '未知图片' },
  ],
  sharedImageIds: ['ref-3', 'ref-2'],
  pages: [
    { page: 1, imageIds: ['ref-1', 'ref-2', 'ref-99'] },
    { page: 2, imageIds: ['ref-2'] },
    { page: 3, imageIds: ['ref-2'] },
    { page: 99, imageIds: ['ref-2'] },
  ],
}

const plan = normalizeXhsReferencePlan(rawPlan, {
  cards,
  referenceImageIds: ['ref-1', 'ref-2', 'ref-3'],
})
assert.deepEqual(plan.sharedImageIds, ['ref-3'])
assert.deepEqual(plan.pages[0], { page: 1, imageIds: ['ref-1'] })
assert.deepEqual(plan.pages[2], { page: 3, imageIds: ['ref-2'] })
assert.equal(plan.pages.some(item => item.page === 99), false)
assert.deepEqual(
  selectXhsReferenceImages(refs, plan, 2).map(item => item.id),
  ['ref-3', 'ref-2'],
  '第 3 页复用第 2 页的内容参考，并带共享风格图',
)
assert.deepEqual(selectXhsReferenceImages(refs, plan, 1), [
  { id: 'ref-3', dataUrl: refs[2] },
  { id: 'ref-2', dataUrl: refs[1] },
])
assert.deepEqual(selectXhsReferenceImages(refs, null, 0), [])
```

另测：空计划返回 `null`；`content` 不得分给封面；`cover` 不得分给内页；`style` 才能共享；每页最多 2 个专属 ID；缺失页自由设计；无效 ID 不进入结果。

- [ ] **Step 2: 运行确认失败**

Run: `node --test --test-name-pattern='参考图计划|按页选择参考图' test/derive-shared.test.js`
Expected: FAIL，提示新函数未导出。

- [ ] **Step 3: 实现最小纯函数**

在 `DERIVE_LIMITS.xhs` 添加上述三个限制。`normalizeXhsReferencePlan` 使用目录中的有效 ID 过滤分配，理由清理控制字符并截断到 120 字；只有提供了非空 `referenceImageIds` 时才按上传列表过滤，以便后续归一化已保存的计划时不会把 ID 全删掉。

在 `normalizeXhs` 的 options 增加 `referenceImageIds = []`，并在 `out` 中保留有效计划：

```js
const referencePlan = normalizeXhsReferencePlan(raw.referencePlan, {
  cards: raw.cards,
  referenceImageIds,
})
if (referencePlan) out.referencePlan = referencePlan
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/derive-shared.test.js`
Expected: 全部 PASS，包括现有浏览器安全和归一化测试。

- [ ] **Step 5: Commit**

```bash
git add src/derive-shared.js test/derive-shared.test.js
git commit -m "feat(xhs): add reference plan normalization and per-page selection"
```

---

### Task 2: 在模型消息中为每张图片插入稳定 ID

**Files:**
- Modify: `src/ai.js:148-188`
- Modify: `src/cli-llm.js:48-76`（仅在需要兼容带 ID 文本块时调整，保持现有转换）
- Test: `test/derive.test.js`、`test/cli.test.js`

**输入兼容：**

```js
images: [
  'data:image/png;base64,...',
  { id: 'ref-2', dataUrl: 'data:image/png;base64,...' },
]
```

带 ID 时消息顺序必须是：主用户文本 → `{ type: 'text', text: '[参考图 ref-2]' }` → 对应图片。无 ID 的旧调用保持原样。

- [ ] **Step 1: 写失败测试**

扩展现有 DSH attachment 测试，传入 `{ id: 'ref-1', dataUrl: tinyPng }`，断言：

```js
assert.equal(messages[0].content[1].type, 'text')
assert.equal(messages[0].content[1].text, '[参考图 ref-1]')
assert.equal(messages[0].content[2].type, 'image')
assert.equal(messages[0].content[2].attachment.attachmentId, attachment.attachmentId)
```

扩展 `createStandaloneCtx` 测试，确认 OpenAI `image_url` 前也保留相同 ID 文本块，且不带 ID 的现有请求快照不变。

- [ ] **Step 2: 运行确认失败**

Run:

```bash
node --test --test-name-pattern='DSH 参考图先保存为附件' test/derive.test.js
node --test --test-name-pattern='createStandaloneCtx 将参考图' test/cli.test.js
```

Expected: FAIL，图片前没有 ID 文本块。

- [ ] **Step 3: 实现带 ID 图片解析**

在 `src/ai.js` 统一读取输入：

```js
const dataUrl = typeof image === 'string' ? image : image?.dataUrl
const id = typeof image?.id === 'string' && /^ref-(?:[1-9]|10)$/.test(image.id)
  ? image.id
  : ''
const parsed = parseDataImageUri(dataUrl)
if (!parsed) continue
if (id) parts.push({ type: 'text', text: `[参考图 ${id}]` })
```

随后沿用 Task 0 的 attachment / inline 两条路径。`validImages` 也必须从对象中的 `dataUrl` 校验，不能直接对对象调用 `parseDataImageUri`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/derive.test.js test/cli.test.js`
Expected: 全部 PASS；原有纯文本降级和 attachment 回归不受影响。

- [ ] **Step 5: Commit**

```bash
git add src/ai.js src/cli-llm.js test/derive.test.js test/cli.test.js
git commit -m "feat(xhs): label model reference images with stable ids"
```

如 `src/cli-llm.js` 未实际修改，不要把它加入提交。

---

### Task 3: 扩展阶段 1，让模型一次完成参考图理解和页面分配

**Files:**
- Modify: `src/derive.js:102-137,139-243,728-802`
- Modify: `skills/repurpose-xhs.md:53-87`
- Test: `test/derive.test.js`

**行为：**

- `buildDerivePrompt` 用 `DERIVE_LIMITS.xhs.referenceImages` 清洗最多 10 张图，user payload 增加 `referenceImageIds: ['ref-1', ...]`。
- 阶段 1 `callModel` 发送 `{ id, dataUrl }`，仍是现有那一次策划调用。
- 提示词要求模型根据视觉特征识别角色并按内容语义分配；允许复用，未匹配页面不分配；不要求每张图都使用。
- `normalizeXhs` 接收上传 ID 列表并保存有效计划；计划无效不覆盖原有文案/卡片重试逻辑。

- [ ] **Step 1: 写失败测试**

在 `buildDerivePrompt` 测试中加入 12 张合法 Data URL，断言只接受 10 张、user payload 的 ID 为 `ref-1` 到 `ref-10`、system 包含 `referencePlan`、复用和自由设计规则。

在生成测试的阶段 1 输出加入：

```js
referencePlan: {
  images: [
    { id: 'ref-1', role: 'cover', reason: '大标题封面' },
    { id: 'ref-2', role: 'style', reason: '统一细线网格' },
  ],
  sharedImageIds: ['ref-2'],
  pages: [{ page: 1, imageIds: ['ref-1'] }],
}
```

断言 `record.payload.referencePlan` 与合法部分一致，且 `JSON.stringify(record.payload)` 不含原始 Data URL。

- [ ] **Step 2: 运行确认失败**

Run: `node --test --test-name-pattern='参考图|buildDerivePrompt' test/derive.test.js`
Expected: FAIL；当前只接收 3 张，没有 ID 契约，也不保存计划。

- [ ] **Step 3: 实现提示词和持久化**

阶段 1 图片参数：

```js
const stage1ReferenceImages = prepared.referenceImages.map((dataUrl, index) => ({
  id: `ref-${index + 1}`,
  dataUrl,
}))
```

将其传给阶段 1 `callModel`，并在 `normalizeXhs` 调用中传入：

```js
referenceImageIds: stage1ReferenceImages.map(image => image.id)
```

更新 `platformContractSection` 和 `skills/repurpose-xhs.md` 的 JSON 示例，加入本计划“数据契约”中的结构。保留现有 `<xhs-meta>` / `<xhs-style>` 协议，不新增独立分析标签或额外模型调用。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/derive.test.js test/derive-shared.test.js`
Expected: 全部 PASS；旧的无参考图生成和阶段 1 错误重试均通过。

- [ ] **Step 5: Commit**

```bash
git add src/derive.js skills/repurpose-xhs.md test/derive.test.js
git commit -m "feat(xhs): plan reference image roles and page assignments"
```

---

### Task 4: 阶段 2 按分配结果分发参考图

**Files:**
- Modify: `src/derive.js:342-439,519-687`
- Test: `test/derive.test.js`

**分发规则：**

- 批次图片 = 本批各页 `selectXhsReferenceImages(...)` 的 ID 去重并集，不再使用完整的 `prepared.referenceImages`。
- `targetCards` 每项增加 `referenceImageIds`，明确该页允许参考的图片。
- 单页失败重试、阶段 3 拓扑去重修复都只携带该页共享图和专属图。
- 无专属图页面仍可携带共享风格图；既无共享又无专属图时不带图片。
- 用户手动单页重设计继续直接使用本次临时选择的最多 2 张图，不读取历史 `referencePlan`。
- 有上传图但计划完全无效时追加警告：`参考图自动分配未完成，相关页面将按内容自由设计。`；不得因分配失败中止生成。

- [ ] **Step 1: 写失败的分发测试**

构造 5 张图：`ref-1` 封面、`ref-2` 对比、`ref-3` 步骤、`ref-4` 矩阵、`ref-5` 共享风格。阶段 1 将前四张分配给对应四页，第五张进入 `sharedImageIds`，第 5 页不分配。

断言：

```js
// 第 1 批只含共享图 + 第 1～3 页专属图，绝不含 ref-4
assert.deepEqual(imageIdsFrom(fake.calls[1]), ['ref-5', 'ref-1', 'ref-2', 'ref-3'])
// 第 2 批只含共享图 + 第 4 页专属图
assert.deepEqual(imageIdsFrom(fake.calls[2]), ['ref-5', 'ref-4'])

const batch1User = JSON.parse(fake.calls[1].messages[0].content[0].text)
assert.deepEqual(batch1User.targetCards[0].referenceImageIds, ['ref-5', 'ref-1'])
assert.deepEqual(batch1User.targetCards[1].referenceImageIds, ['ref-5', 'ref-2'])
```

再分别覆盖：参考图跨页复用；未分配页只有共享图；无计划时后续调用无图片且生成成功；单页重试和拓扑去重不会重新携带全部图片；手动 `redesignXhsCard` 的两张临时参考图行为保持原样。

- [ ] **Step 2: 运行确认失败**

Run: `node --test --test-name-pattern='按页分发参考图|参考图复用|无参考图计划' test/derive.test.js`
Expected: FAIL；当前每批和每次修复都收到全部参考图。

- [ ] **Step 3: 实现分批和单页选图**

`buildXhsBatchCardsPrompt` 返回 `{ system, user, images }`。在构造 `targetCards` 时逐页调用 `selectXhsReferenceImages`，按 ID 去重得到批次图片；提示词把“模仿全部参考图”改为“只使用本页 `referenceImageIds` 指定的参考图，禁止把其他页面的专属构图复制过来”。

批次调用改为：

```js
images: batchPrompt.images,
```

单页重试和去重修复在调用 `buildSingleCardRedesignPrompt` 前计算：

```js
const cardReferenceImages = selectXhsReferenceImages(refImages, deck.referencePlan, idx)
```

并将同一数组传给提示词构造函数和 `runSingleCardModelCall`。不要在任何阶段 2 分支回退为 `images: refImages` 全量广播。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/derive.test.js test/derive-routes.test.js`
Expected: 全部 PASS，包括渐进式落盘、单页重试、拓扑去重和文本模型降级。

- [ ] **Step 5: Commit**

```bash
git add src/derive.js test/derive.test.js
git commit -m "feat(xhs): route assigned references to each card batch"
```

---

### Task 5: 开放 10 张上传并更新界面说明与文档

**Files:**
- Modify: `client/state.js:1-5,271-307`
- Modify: `client/derive.jsx:1334-1417`
- Modify: `README.md:199`
- Test: `test/derive-routes.test.js`

- [ ] **Step 1: 写路由上限回归测试**

在路由测试中发送 12 张不同 Data URL，确认阶段 1 实际只收到 10 张且 ID 顺序稳定；确认 `derive/redesign-card` 仍最多发送 2 张。测试数据只改变 Base64 字符串，不需要真实图片解码，因为假 LLM 与假附件服务不校验像素。

- [ ] **Step 2: 运行确认失败**

Run: `node --test --test-name-pattern='参考图' test/derive-routes.test.js`
Expected: FAIL；`client/state.js` 和 Host 生成链路仍只保留 3 张。

- [ ] **Step 3: 统一前端限制和说明**

`client/state.js` 导入 `DERIVE_LIMITS`，整套生成改为：

```js
const cleanRefs = Array.isArray(referenceImages)
  ? referenceImages.filter(Boolean).slice(0, DERIVE_LIMITS.xhs.referenceImages)
  : []
```

`client/derive.jsx` 将上传、粘贴、按钮 disabled、计数和 title 中的 `3` 全部改用 `DERIVE_LIMITS.xhs.referenceImages`。说明改为：

```text
最多上传 10 张。模型会自动识别封面与内容版式并按页参考；参考图可复用，未分配页面将自由设计。
```

不添加页码选择器或手动映射控件。README 的小红书条目同步说明 10 张上限和自动分配策略。

- [ ] **Step 4: 构建并运行相关测试**

Run:

```bash
npm run build
node --test test/derive-routes.test.js test/derive.test.js
```

Expected: `dist/client.js` 构建成功，测试全部 PASS；按钮显示 `参考图 (N/10)`。

- [ ] **Step 5: Commit**

```bash
git add client/state.js client/derive.jsx README.md test/derive-routes.test.js dist/client.js
git commit -m "feat(xhs): allow ten auto-routed reference images"
```

---

### Task 6: 全量验证与真实场景验收

**Files:**
- Verify only; 若发现问题，回到对应 Task 添加失败测试后再修复。

- [ ] **Step 1: 运行项目标准检查**

Run:

```bash
npm run build && npm test && npm run check:package
```

Expected: 构建成功、全部测试通过、打包元数据与跟踪文件检查通过；`git diff --check` 无错误。

- [ ] **Step 2: 用支持视觉的真实模型验收完整参考套图**

上传至少 6 张视觉差异明显的参考图：封面、对比页、步骤页、金句页、尾页和共享风格页。执行整套生成，确认：

- 不再出现 `attachmentId` 错误。
- 封面只参考封面图；内容页使用各自对应构图。
- 未分配给当前批次的图片不会出现在该批模型请求中。
- 参考图中的文字、品牌和数字没有被复制进卡片事实内容。
- 换肤和 PNG 导出仍正常。

- [ ] **Step 3: 验收 A 策略与降级路径**

分别验证：

1. 只上传 2 张图生成 5–8 页：合适参考可复用，其余页面自由设计，不要求补图。
2. 上传无语义关联的图片：模型可以不分配，生成不中止。
3. 切换到纯文本模型：自动忽略图片并显示既有警告，整套仍生成。
4. 手动单页重设计上传 2 张图：只影响目标页，其他页不变。
5. 无参考图生成：请求和结果与既有行为一致。

- [ ] **Step 4: 检查最终工作区**

Run: `git status --short && git log --oneline -7`
Expected: 只包含本计划涉及的提交；无测试日志、临时图片或其他生成物。未验收前不要推送远端。
