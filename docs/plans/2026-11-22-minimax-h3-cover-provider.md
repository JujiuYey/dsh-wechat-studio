# MiniMax H3 生图提供方扩展实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为封面生成（并同步支持共用的正文插图与 CLI）扩展第三个生图提供方 **MiniMax H3**（模型：`MiniMax-H3-Image`、`MiniMax-H3-Image-Highspeed`），完整支持无参考图文生图、带人物参考图生成、PNG/JPEG 格式、设置页与 CLI 配置管理及错误脱敏映射；同时把当前散落在全仓的 `provider === 'bailian' ? ... : ...` 二元判断收口为声明式提供方配置表。

**Architecture:**
- **声明式提供方注册表（浏览器安全）。** 在 `src/cover-options.js`（零 `node:*` 导入，前后端共享）新增 `minimax` 提供方、两款 H3 模型、`MINIMAX_SIZES`、`INLINE_IMAGE_SIZES.minimax` 及 `COVER_PROVIDER_META` 映射表，统一收敛各提供方的 `modelField` / `keyField` / `keySetField` / `envKey` / 控制台外链 / 提示文案，彻底消除 `host.js`、`cli.js`、`client/app.jsx`、`client/inline-diagrams.jsx` 中的二元三目分支。
- **双端点自动分流。** MiniMax H3 将纯文生图与参考图编辑拆为两个同风格 JSON 接口：
  - 无参考图（未配置 `portraitUrl`、`felt` 羊毛毡风格、正文插图）→ `POST https://api.minimax.cn/v1/images/generations`，显式传 `disable_prompt_enhanced: true`（避免服务端改写模板排版与引入禁用词，且节省增强 token 费用）。
  - 有参考图（配置了 `portraitUrl` 且非 `felt`）→ `POST https://api.minimax.cn/v1/images/edits`，通过 JSON 字段 `images: [{ image_url: referenceImage }]` 传入公网 HTTPS 参考图；该接口官方固定开启 Prompt 增强，不传 `disable_prompt_enhanced`。
- **尺寸、返回与超时策略。** 统一传精确 `size: "宽x高"`（不传互斥的 `aspect_ratio` / `area`）、`n: 1`、`response_format: "b64_json"`、`output_format: format`、`aigc_watermark: false`。超时使用 `AbortSignal.timeout(600_000)`，严禁自动重试；超时文案必须提示「已等待 600 秒并断开，服务端仍可能完成并计费；请避免立即重复提交」，且封面多张批次遇到 MiniMax 超时后立即中止剩余张数，不再继续后续付费请求。
- **错误解析与脱敏。** 复用 `providerDetail` 脱敏 `apiKey` 和 `Bearer` 凭证；统一按 `body.request_id → body.error.request_id → res.headers.get('trace_id') → res.headers.get('x-request-id')` 提取请求 ID（覆盖 HTTP 非 2xx、HTTP 200 但 `data[0].error`、以及非法 JSON 响应）；错误码兼容 `itemError.code`、`body.error.code` 及 `error.message` 末尾括号提取，完整覆盖 `1004`/`2049`、`2022`、`2069`、`2068`/`2061`、`1008`/`2053`/`2067`、`1026`/`1027`、`1002`/`2056`/`2062`、`2013`、`1000`/`1001`。
- **全链路同步。** 因为 `settings.coverProvider` 同时服务封面生成、正文插图与 CLI，本计划覆盖 `settings.js`、`cover.js`、`inline-assets.js`、`host.js`、`cli.js`、`client/app.jsx`、`client/inline-diagrams.jsx`、`README.md` 及全套单元测试。

**Tech Stack:** Node.js `>=20` ESM、React 18（esbuild 打包至 `dist/client.js`）、`node:test`、`node:assert/strict`、内置 `fetch`。

---

## 可行性分析与接口核对结论

基于 MiniMax 官方 OpenAPI 文档核对结果：
- 文生图：`https://platform.minimax.cn/docs/api-reference/image-generation-h3-generations`（`POST https://api.minimax.cn/v1/images/generations`）
- 图片编辑：`https://platform.minimax.cn/docs/api-reference/image-generation-h3-edits`（`POST https://api.minimax.cn/v1/images/edits`）

| 维度 | MiniMax H3 规范 | 与 `dsh-wechat-studio` 适配情况 |
|---|---|---|
| 认证 | `Authorization: Bearer <API_KEY>`（国内站 `platform.minimax.cn`） | 完全兼容，原生 `fetch` 零依赖 |
| 模型 | `MiniMax-H3-Image`、`MiniMax-H3-Image-Highspeed` | 参数与限制完全一致，双模型全部接入 |
| 输出格式 | `png`、`jpeg`、`jpg`、`webp` | 完整支持封面 `['png', 'jpeg']` 及正文插图 `'png'` |
| 返回形式 | `url` / `b64_json`（PNG `b64_json` 总面积上限 `20,000,000 px`，JPEG 上限 `80,000,000 px`） | 单张 `n=1` 走 `b64_json`，免去二次下载与 SSRF 校验 |
| 尺寸限制 | `size: "宽x高"`，面积 `[655,360, 20,000,000]` px，宽高比 `[1:3, 3:1]`；传 `size` 时禁止传 `aspect_ratio`/`area` | 封面 `47:20`（`2.35:1`）和插图 `16:9`（`2048x1152`）均满足；避开默认 `4K`（~16.7M px）以免触发 `src/image-crop.js` 的 `MAX_PIXELS = 9,400,000` 上限 |
| 参考图 | `/v1/images/edits` 的 `images: [{ image_url }]`，支持公网 HTTPS URL（1–16 张，单图 ≤ 64 MiB） | 直接复用 `settings.portraitUrl`（已有 HTTPS 校验） |
| Prompt 增强 | `/v1/images/generations` 支持 `disable_prompt_enhanced: true`；`/v1/images/edits` 始终开启 | 文生图传 `disable_prompt_enhanced: true`；图生图不传该字段 |
| 超时与幂等 | 服务端最长等待 600s，非幂等 | 客户端 `AbortSignal.timeout(600_000)`，不自动重试 |

### 评审修订（2026-11-22，实施前已合入下方 Task）

1. **超时计费语义与批次熔断**：`generateMinimaxCover` 捕获 `TimeoutError` 后包装为 MiniMax 专属非幂等超时错误（「已等待 600 秒并断开，服务端仍可能完成并计费；请避免立即重复提交」，标记 `nonRetryable: true`）；`host.js` 封面多张循环遇到 `nonRetryable` 立即 `break` 中止剩余张数，正文插图 `inlineError` 透出该文案而不追加「请重试」，其他提供方行为保持不变。
2. **错误码完整映射与兼容 `body.error.code`**：将 `2068`（与 `2061`）从 402 余额不足测试中拆出单独断言套餐升级提示；补充 `2022`（模型不存在/无权使用）、`2049`（无效 API Key）、`2061`（套餐不支持模型）、`2062`（M Plan 速率限制）、`2069`（模型已下线）；错误码提取同时兼容 `body.error.code` 与 `error.message` 末尾括号。
3. **请求 ID 统一读取响应头**：所有错误路径（HTTP 非 2xx、HTTP 200 但 `data[0].error`、非法 JSON）统一按 `body.request_id → body.error.request_id → res.headers.get('trace_id') → res.headers.get('x-request-id')` 提取并做长度限制（120）与密钥脱敏。
4. **Base64 解码前后双重大小校验**：`decodeBase64Image` 依次执行：非空字符串校验 → 编码长度上限拦截 → `Buffer.from(..., 'base64')` → 解码后实际字节 `image.length <= 24 MB` 校验 → PNG/JPEG 魔数校验。
5. **安装包冒烟验收**：`scripts/smoke-package.mjs` 增加离线 CLI MiniMax 配置读写冒烟，最终验收增加 `mkdir -p artifacts && npm pack --pack-destination artifacts && npm run smoke:package`。

### 已确认设计决策

1. **封面分辨率档位（已选定选项 A）**：`MINIMAX_SIZES = { '1K': '1504x640', '1.5K': '2256x960', '2K': '3008x1280' }`（三档分别为 `32` / `48` / `64` 倍 `47:20`，`src/image-crop.js` 原样返回、零裁切、零二次重编码）。
2. **端点节点（YAGNI）**：固定国内平台 `https://api.minimax.cn`，与百炼策略一致。

---

## Global Constraints

- **零运行时依赖**：禁止新增任何 npm runtime 依赖，`npm run check:package` 必须通过。
- **浏览器安全边界**：`src/cover-options.js` 会被 `client/app.jsx` 与 `client/inline-diagrams.jsx` 直接打包进 `dist/client.js`，禁止导入任何 `node:*` 模块或敏感服务端逻辑。
- **非幂等与超时**：MiniMax H3 请求必须设置 `AbortSignal.timeout(600_000)` 与 `redirect: 'error'`，严禁做自动重试；超时后提示不可简单引导重试，且多张封面批次遇到超时立即停止后续张数。
- **密钥零泄露**：`minimaxKey` 仅保存在本机 `settings.json`（权限 `600`），`publicSettings` 仅公开 `minimaxKeySet`；报错文案及请求 ID 必须经 `providerDetail` 清除 `apiKey` 和 `Bearer`；CLI `collectPatchSecrets` 与 `secrets` 必须登记 `minimaxKey`。
- **不改现有提供方行为**：火山方舟（`ark`）与阿里云百炼（`bailian`）的请求体、端点、超时、错误映射与默认行为保持 100% 兼容。
- **验证命令**：`npm run build && npm test && npm run check:package && mkdir -p artifacts && npm pack --pack-destination artifacts && npm run smoke:package`

## Review Focus

1. **双端点分流准确**：无参考图（含 `felt` 风格和正文插图）必须打 `/v1/images/generations` 且带 `disable_prompt_enhanced: true`、不带 `images`；有参考图必须打 `/v1/images/edits` 且带 `images: [{ image_url }]`、**不带** `disable_prompt_enhanced`；两类请求均不带 `aspect_ratio`、`area`。
2. **尺寸与裁切闸门安全**：`MINIMAX_SIZES` 各档与 `INLINE_IMAGE_SIZES.minimax` 均满足 `655,360 <= w * h <= 9,400,000` 且宽高比在 `1:3 ~ 3:1`；`saveCover` 能顺利保存 PNG 与 JPEG。
3. **无残留二元三目**：全仓搜索 `=== 'bailian'` 后，除百炼特有的格式约束（`providerFormats`）或百炼测试外，不应再有「不是 bailian 就当 ark」的逻辑。
4. **错误覆盖完整**：HTTP 401/402/422/429/400/500、HTTP 200 但 `data[0].error`、响应无图、魔数不符、超 24 MB 均有清晰中文错误并脱敏密钥与附带 `request_id`。
5. **前端打包同步**：修改 `client/*.jsx` 后必须运行 `npm run build` 更新 `dist/client.js`。

---

### Task 1: 提供方元信息与选项收口（`src/cover-options.js`）

**Files:**
- Modify: `src/cover-options.js`
- Test: `test/cover.test.js`

**Interfaces:**
- Consumes: none（纯 JS，浏览器安全，零 `node:*` 导入）
- Produces:
  - `COVER_PROVIDERS`：新增 `{ id: 'minimax', name: 'MiniMax' }`
  - `COVER_MODELS`：新增
    - `{ id: 'MiniMax-H3-Image', name: 'MiniMax H3 Image', provider: 'minimax' }`
    - `{ id: 'MiniMax-H3-Image-Highspeed', name: 'MiniMax H3 Image Highspeed', provider: 'minimax' }`
  - `MINIMAX_SIZES`：`{ '1K': '1504x640', '1.5K': '2256x960', '2K': '3008x1280' }`
  - `INLINE_IMAGE_SIZES`：新增 `minimax: '2048x1152'`
  - `COVER_PROVIDER_META`：
    ```js
    export const COVER_PROVIDER_META = {
      ark: {
        id: 'ark',
        name: '火山方舟',
        modelField: 'arkModel',
        keyField: 'arkKey',
        keySetField: 'arkKeySet',
        envKey: 'ARK_API_KEY',
        description: '配置火山方舟的生图模型和凭证。',
        link: 'https://ark.volcengine.com/region:cn-beijing/apikey',
        linkLabel: '火山方舟 API Key',
        keyPlaceholder: '输入火山方舟 API Key',
        missingKeyError: '请先在设置中填写火山方舟 API Key。',
        hint: '',
      },
      bailian: {
        id: 'bailian',
        name: '阿里云百炼',
        modelField: 'bailianModel',
        keyField: 'bailianKey',
        keySetField: 'bailianKeySet',
        envKey: 'BAILIAN_API_KEY',
        description: '配置阿里云百炼的生图模型和凭证。',
        link: 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key',
        linkLabel: '阿里云百炼 API Key',
        keyPlaceholder: '输入阿里云百炼 API Key',
        missingKeyError: '请先在设置中填写阿里云百炼 API Key。',
        hint: '当前仅支持中国内地（北京）的百炼 API Key，图片格式为 PNG。',
      },
      minimax: {
        id: 'minimax',
        name: 'MiniMax',
        modelField: 'minimaxModel',
        keyField: 'minimaxKey',
        keySetField: 'minimaxKeySet',
        envKey: 'MINIMAX_API_KEY',
        description: '配置 MiniMax H3 的生图模型和凭证。',
        link: 'https://platform.minimax.cn/user-center/basic-information/interface-key',
        linkLabel: 'MiniMax API Key',
        keyPlaceholder: '输入 MiniMax API Key',
        missingKeyError: '请先在设置中填写 MiniMax API Key。',
        hint: '当前支持 MiniMax 国内开放平台（platform.minimax.cn）的 API Key，支持 PNG 和 JPEG。',
      },
    }
    ```
  - `providerMeta(provider)`：按 `provider` 返回 `COVER_PROVIDER_META[provider] ?? COVER_PROVIDER_META.ark`
  - `providerFormats('minimax')`：返回 `['png', 'jpeg']`（现有 `provider === 'bailian' ? ['png'] : COVER_FORMATS` 即可）

- [x] **Step 1: 在 `test/cover.test.js` 补充 `cover-options` 断言**
  - 验证 `COVER_PROVIDERS` 包含 `minimax`、`modelsFor('minimax')` 包含 `MiniMax-H3-Image` 与 `MiniMax-H3-Image-Highspeed`、`providerFormats('minimax')` 为 `['png', 'jpeg']`、`MINIMAX_SIZES` 各档宽高均满足 `655,360 <= w*h <= 9,400,000` 且比例在 `[1/3, 3]`、`INLINE_IMAGE_SIZES.minimax === '2048x1152'`。
- [x] **Step 2: 运行确认失败** — `node --test test/cover.test.js`
- [x] **Step 3: 更新 `src/cover-options.js`**
- [x] **Step 4: 运行确认通过** — `node --test test/cover.test.js`

---

### Task 2: 实现 MiniMax H3 生图客户端与统一调度（`src/cover.js`）

**Files:**
- Modify: `src/cover.js`
- Test: `test/cover.test.js`

**Interfaces:**
- Consumes: `BAILIAN_SIZES`, `MINIMAX_SIZES` from `./cover-options.js`
- Produces:
  - `generateMinimaxCover(prompt, { apiKey, model, resolution, format = 'png', referenceImage = null, size: explicitSize, subject = '封面' }, fetchImpl = fetch) -> Promise<Buffer>`
  - `generateCoverImage(provider, prompt, options, fetchImpl = fetch) -> Promise<Buffer>`（按 `provider` 分发至 `generateArkCover` / `generateBailianCover` / `generateMinimaxCover`，未知提供方抛出 `status: 400` 错误）

**实现要点：**
- 抽取内部辅助函数 `decodeBase64Image(encoded, format, providerName, subject)` 供 `generateArkCover` 与 `generateMinimaxCover` 共用，严格按顺序校验：
  1. `typeof encoded === 'string'` 且 `trim()` 非空；
  2. 限制编码字符串长度（防异常大响应占内存）；
  3. `Buffer.from(normalized, 'base64')` 且非空；
  4. 检查解码后实际字节 `image.length <= MAX_IMAGE`（24 MB）；
  5. 检查 PNG (`89504e470d0a1a0a`) / JPEG (`ffd8ff`) 魔数。
- 端点、请求体与超时处理：
  - `const hasRef = Boolean(referenceImage)`
  - `const endpoint = hasRef ? 'https://api.minimax.cn/v1/images/edits' : 'https://api.minimax.cn/v1/images/generations'`
  - `const payload = { model, prompt, size: explicitSize ?? MINIMAX_SIZES[resolution], n: 1, output_format: format, response_format: 'b64_json', aigc_watermark: false, ...(hasRef ? { images: [{ image_url: referenceImage }] } : { disable_prompt_enhanced: true }) }`
  - `fetchImpl(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(600_000), headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) })`
  - 若 `fetchImpl` 抛出 `TimeoutError`：不重试，抛出 `Object.assign(new Error(\`MiniMax ${subject}生成已等待 600 秒并断开，服务端仍可能完成并计费；请避免立即重复提交。\`), { code: 'MINIMAX_TIMEOUT', nonRetryable: true, cause: err })`。
- 请求 ID 统一提取辅助函数 `minimaxRequestId(body, res, apiKey)`（所有错误路径含非 2xx、200 + `data[0].error`、非法 JSON 均走此逻辑）：
  - 依次读取 `body?.request_id → body?.error?.request_id → res.headers?.get?.('trace_id') → res.headers?.get?.('x-request-id')`，经 `providerDetail(value, 120, apiKey)` 限长并脱敏。
- 错误映射辅助函数 `minimaxErrorMessage({ status, body, requestId, apiKey, itemError, subject })`：
  - 错误码依次从 `itemError?.code`、`body?.error?.code`、以及 `itemError?.message` / `body?.error?.message` 末尾 `\((\d+)\)\s*$` 提取并规范化为字符串 `code`。
  - `requestSuffix = requestId ? \` 请求 ID：${requestId}\` : ''`
  - 映射优先级：
    - `status === 401 || code === '1004' || code === '2049'` → `MiniMax 鉴权失败或 API Key 无效，请检查是否使用国内平台（platform.minimax.cn）的有效密钥。${requestSuffix}`
    - `code === '2022'` → `MiniMax 模型不存在或当前账号无权使用，请检查模型配置。${requestSuffix}`
    - `code === '2069'` → `当前所选 MiniMax 模型已下线，请切换其他可用模型。${requestSuffix}`
    - `code === '2068' || code === '2061'` → `当前 MiniMax 套餐等级不支持该模型，请升级套餐或切换模型。${requestSuffix}`
    - `code === '1008' || code === '2053' || code === '2067' || status === 402` → `MiniMax 余额、积分或套餐额度不足，请充值或检查额度后再试。${requestSuffix}`
    - `status === 422 || code === '1026' || code === '1027'` → `提示词或生成结果未通过 MiniMax 内容安全审核，请调整后重试。${requestSuffix}`
    - `status === 429 || code === '1002' || code === '2056' || code === '2062'` → `MiniMax 触发速率限制或套餐用量达到上限，请稍后再试。${requestSuffix}`
    - `code === '1001'` → `MiniMax 服务端等待超时，请稍后再试。${requestSuffix}`
    - 其他情况 → `MiniMax ${subject}生成失败（HTTP ${status}）` + 脱敏后的 `code` / `error.type` / `error.message` / `request_id`
- HTTP 200 检查：
  - `const data = await res.json().catch(() => null)`，非法 JSON 时仍提取响应头 `trace_id` / `x-request-id` 报错；
  - 若 `data?.data?.[0]?.error` 存在，走同一套错误码映射并带上 `minimaxRequestId` 抛出；
  - 否则调用 `decodeBase64Image(data?.data?.[0]?.b64_json, format, 'MiniMax', subject)` 返回 `Buffer`。

- [x] **Step 1: 在 `test/cover.test.js` 写失败测试**
  - 无参考图文生图：命中 `/v1/images/generations`，验证 `Authorization: Bearer ...`、`model`、`size`（1K/1.5K/2K）、`n: 1`、`output_format`（png & jpeg）、`response_format: 'b64_json'`、`aigc_watermark: false`、`disable_prompt_enhanced: true`，且不含 `images`/`aspect_ratio`/`area`。
  - 有参考图编辑：命中 `/v1/images/edits`，验证 `images: [{ image_url: 'https://example.com/portrait.png' }]`，且不含 `disable_prompt_enhanced`。
  - 双模型（`MiniMax-H3-Image`、`MiniMax-H3-Image-Highspeed`）及 `explicitSize` 覆盖均透传正确。
  - 超时语义：mock 抛出 `TimeoutError`，断言仅调用 `fetchImpl` 1 次（无自动重试）、文案含 `600 秒` 与计费提醒、**不含**「请重试」、错误对象带 `nonRetryable: true`。
  - 错误映射：
    - 鉴权：401 (`1004`)、`2049`
    - 余额/积分/额度：402 (`1008` / `2053` / `2067`)
    - 套餐不支持模型（单独断言套餐升级提示）：`2068`（含 HTTP 402 返回 2068）、`2061`
    - 模型状态：`2022`（不存在/无权使用）、`2069`（已下线）
    - 审核与限流：422 (`1026` / `1027`)、429 (`1002` / `2056` / `2062`)
    - 兼容 `body.error.code`（不依赖 message 括号）
    - 请求 ID 优先级：`body.request_id` → `body.error.request_id` → `trace_id` header → `x-request-id` header（覆盖非 2xx、200 + `data[0].error`、非法 JSON，并验证脱敏和限长）
    - 400 (`2013` + 脱敏 `apiKey`)、500 (`1000`)、响应无 `b64_json`、格式魔数不符、编码超限及解码后实际字节超 24 MB。
  - `generateCoverImage` 按 provider 正确分发，未知 provider 抛 400。
- [x] **Step 2: 运行确认失败** — `node --test test/cover.test.js`
- [x] **Step 3: 实现 `src/cover.js`**
- [x] **Step 4: 运行确认通过** — `node --test test/cover.test.js`

---

### Task 3: 设置持久化、校验与脱敏公开（`src/settings.js`）

**Files:**
- Modify: `src/settings.js`
- Test: `test/cover.test.js`

**Interfaces:**
- `readSettings(root)` 返回对象新增：
  - `minimaxModel`: `modelsFor('minimax').find(m => m.id === saved.minimaxModel)?.id ?? modelsFor('minimax')[0].id`
  - `minimaxKey`: `typeof saved.minimaxKey === 'string' ? saved.minimaxKey : ''`
- `updateSettings(root, body)` 支持：
  - `body.minimaxModel`：白名单校验，非法值抛出 `status: 400`「请选择支持的 MiniMax 封面模型。」
  - `body.minimaxKey`：`trim().slice(0, 400)`（传 `''` 表示清除）
- `publicSettings(settings)` 返回对象新增：
  - `minimaxModel: settings.minimaxModel`
  - `minimaxKeySet: Boolean(settings.minimaxKey)`

- [x] **Step 1: 在 `test/cover.test.js` 扩充封面设置测试**
  - 验证默认 `minimaxModel === 'MiniMax-H3-Image'`、`minimaxKey === ''`。
  - 验证更新 `coverProvider: 'minimax'`、`minimaxModel: 'MiniMax-H3-Image-Highspeed'`、`minimaxKey: '  sk-mm-9999  '` 后：`publicSettings` 不含明文密钥且 `minimaxKeySet === true`，落盘值已 trim。
  - 验证非法 `minimaxModel`（例如传入方舟或百炼模型 id）被 400 拒绝。
- [x] **Step 2: 运行确认失败** — `node --test test/cover.test.js`
- [x] **Step 3: 更新 `src/settings.js`**
- [x] **Step 4: 运行确认通过** — `node --test test/cover.test.js`

---

### Task 4: 正文插图与 Host 路由适配（`src/inline-assets.js`、`src/host.js`）

**Files:**
- Modify: `src/inline-assets.js`
- Modify: `src/host.js`
- Test: `test/cover.test.js`, `test/inline-diagrams.test.js`, `test/inline-diagram-routes.test.js`

**变动细节：**
- `src/inline-assets.js`：
  - `generateInlineImage` 改为调用 `generateCoverImage(provider, prompt, options, fetchImpl)`（并在缺失 `INLINE_IMAGE_SIZES[provider]` 时返回 400），自动支持 `ark`、`bailian`、`minimax`（MiniMax 插图走 `/v1/images/generations`，`size: '2048x1152'`、`format: 'png'`、`referenceImage: null`、`subject: '插图'`）。
- `src/host.js`：
  - 引入 `providerMeta`（from `./cover-options.js`）和 `generateCoverImage`（from `./cover.js`）。
  - `startCover`：用 `generateCoverImage(options.provider, prompt, { ...options, apiKey }, fetchImpl)` 替代二元三目；捕获错误时若 `err.nonRetryable`（如 MiniMax 600s 超时）则记录专属计费提醒文案并 `break` 立即终止本次剩余封面批次，避免继续发起付费请求；方舟/百炼超时仍维持「封面生成超时，请重试。」与原有继续下一张行为。
  - `startInlineGeneration`：通过 `const meta = providerMeta(provider)` 读取 `settings[meta.modelField]` 与 `settings[meta.keyField]`；MiniMax 超时由 `generateMinimaxCover` 包装的专属文案经 `inlineError` 原样透出（不含「请重试」），其他提供方超时行为不变。
  - `case 'inline-diagrams/generate'`：通过 `providerMeta(settings.coverProvider)` 读取 Key 并返回 `meta.missingKeyError`。
  - `case 'cover/generate'`：通过 `providerMeta(provider)` 读取 `apiKey`、`model` 与 `meta.missingKeyError`。

- [x] **Step 1: 编写路由与插图失败测试**
  - `test/cover.test.js`：`coverHost({ provider: 'minimax', ... })` 缺 Key 报 `MiniMax API Key`；接受 `png` 与 `jpeg`；带 `portraitUrl` 走 `/v1/images/edits` 落盘记录 `provider: 'minimax'`；`felt` 风格不带参考图走 `/v1/images/generations`；`count: 3` 时第 1 张模拟 `TimeoutError`，断言仅发 1 次请求（中止剩余 2 张）、无自动重试、错误信息含 `600 秒` / 计费提醒且不含「请重试」。
  - `test/inline-diagrams.test.js`：`generateInlineImage` 使用 `minimax` 双模型验证走 `/v1/images/generations`、`size: '2048x1152'`、`output_format: 'png'`、`disable_prompt_enhanced: true`、无 `images`。
  - `test/inline-diagram-routes.test.js`：验证 `coverProvider: 'minimax'` 缺 Key 报 `MiniMax API Key`、有 Key 可完整生成并读取插图；模拟 `TimeoutError` 断言仅请求 1 次、插图错误文案不含「请重试」。
- [x] **Step 2: 运行确认失败** — `node --test test/cover.test.js test/inline-diagrams.test.js test/inline-diagram-routes.test.js`
- [x] **Step 3: 更新 `src/inline-assets.js` 与 `src/host.js`**
- [x] **Step 4: 运行确认通过** — `node --test test/cover.test.js test/inline-diagrams.test.js test/inline-diagram-routes.test.js`

---

### Task 5: CLI 完整对齐（`src/cli.js`）

**Files:**
- Modify: `src/cli.js`
- Test: `test/cli.test.js`

**变动细节：**
- 常量与选项：
  - 新增 `const ENV_MINIMAX_KEY = ['MINIMAX', 'API', 'KEY'].join('_')`（即 `MINIMAX_API_KEY`）
  - `VALUE_FLAGS` 增加 `'--minimax-model'`、`'--minimax-key'`
  - `SUB_HELP.settings` 更新：
    - `--cover-provider <${COVER_PROVIDERS.map(p => p.id).join('|')}>`
    - `--ark-model <id> / --bailian-model <id> / --minimax-model <id>`
    - `--zhuque-key / --ark-key / --bailian-key / --minimax-key <key>`
- `handleCover`：
  - 提供方校验报错改为动态列出 `COVER_PROVIDERS.map(p => p.id).join('、')`
  - 通过 `providerMeta(provider)` 统一获取 `envKey`、`keyField`、`modelField`，生成函数改调 `generateCoverImage`
- `handleSettings` / `collectPatchSecrets` / `formatSettingsSummary`：
  - 解析 `--minimax-model`、`--minimax-key` 写入 `patch`
  - `collectPatchSecrets` 加入 `patch.minimaxKey`
  - `formatSettingsSummary` 展示 `minimax=${pub.minimaxModel}` 及 `MiniMax ${pub.minimaxKeySet ? '已配置' : '未配置'}`

- [x] **Step 1: 在 `test/cli.test.js` 增加失败测试**
  - `settings set --cover-provider minimax --minimax-model MiniMax-H3-Image-Highspeed --minimax-key mm-secret-01 --json`：确认写入成功且输出不含明文 `mm-secret-01`，`settings get` 摘要与 JSON 正确。
  - `cover --prompt-file ... --provider minimax --out ... --json`：分别测试通过 `MINIMAX_API_KEY` 环境变量和工作区设置调用 `/v1/images/generations`，以及带 `portraitUrl` 时调用 `/v1/images/edits` 并裁切输出。
- [x] **Step 2: 运行确认失败** — `node --test test/cli.test.js`
- [x] **Step 3: 更新 `src/cli.js`**
- [x] **Step 4: 运行确认通过** — `node --test test/cli.test.js`

---

### Task 6: 前端 UI 适配与构建（`client/app.jsx`、`client/inline-diagrams.jsx`）

**Files:**
- Modify: `client/app.jsx`
- Modify: `client/inline-diagrams.jsx`
- Rebuild: `dist/client.js`（通过 `npm run build`）

**变动细节：**
- `client/app.jsx`：
  - 导入 `providerMeta`（from `../src/cover-options.js`）
  - `SettingsDialog` 新增 `minimaxModel`、`minimaxKey` 两个本地 state，使用 `const pMeta = providerMeta(providerValue)` 统一驱动：
    - `pages` 中的 `cover` 描述、`ready: settings[pMeta.keySetField]`、`link: pMeta.link`、`linkLabel: pMeta.linkLabel`
    - `patch()` 写出 `out.minimaxModel = minimaxModel ?? settings.minimaxModel` 和 `if (minimaxKey.trim()) out.minimaxKey = minimaxKey.trim()`
    - 模型下拉框与 API Key 输入框按 `providerValue` 读写对应 state；底部提示文案渲染 `{pMeta.hint ? <p className="ws-muted ws-small">{pMeta.hint}</p> : null}`
  - `CoverStyleDialog` 已基于 `COVER_PROVIDERS` 与 `providerFormats(provider)` 动态渲染，确认无需硬编码。
- `client/inline-diagrams.jsx`：
  - 导入 `providerMeta`（from `../src/cover-options.js`）
  - `GenerateDialog` 中用 `const meta = provider ? providerMeta(provider) : null` 统一读取 `keyReady = meta ? settings?.[meta.keySetField] : false` 与 `model = meta ? settings?.[meta.modelField] : null`。

- [x] **Step 1: 修改 `client/app.jsx` 与 `client/inline-diagrams.jsx`**
- [x] **Step 2: 执行构建** — `npm run build`，确认 `dist/client.js` 构建零报错且无 `node:*` 打包错误。

---

### Task 7: 文档更新、冒烟脚本与全量验证

**Files:**
- Modify: `README.md`
- Modify: `scripts/smoke-package.mjs`（补充离线安装后 CLI 识别 `--cover-provider minimax` / `--minimax-model` 的冒烟断言）
- Check: `skills/cli-agent/SKILL.md`（如需补充提供方示例）

**变动细节：**
- `README.md`：
  - 在「按需配置模型、检测、生图与图床」表格补充 **MiniMax** 一行（用途：生成封面图和正文插图（MiniMax H3 Image / Highspeed）；配置入口：在「设置 → 封面生成」选择 MiniMax，填写国内平台 API Key 并选择生图模型）
  - 数据外发说明补充「MiniMax」

- [x] **Step 1: 更新 `README.md` 与 `scripts/smoke-package.mjs`**
- [x] **Step 2: 全仓排查残留二元判断** — `grep -rn "=== 'bailian'\|!== 'bailian'" src/ client/`，确认仅剩格式约束等百炼专属逻辑
- [x] **Step 3: 运行全量构建、测试、打包检查与安装包冒烟**
  - `npm run build && npm test && npm run check:package`
  - `mkdir -p artifacts && npm pack --pack-destination artifacts && npm run smoke:package`
- [ ] **Step 4: 人工/实测验收建议（可选，需用户提供真实 MiniMax Key）**
  - 用真实 `MINIMAX_API_KEY` 各跑一次：① 无参考图 `classic` 风格（验证 `/v1/images/generations` + `disable_prompt_enhanced: true`）；② 有 `portraitUrl` 人物封面（验证 `/v1/images/edits` 人物一致性与 47:20 裁切）；③ 正文插图 `16:9` PNG。
