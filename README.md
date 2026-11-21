<div align="center">
  <br>
  <h1>公众号成稿台</h1>
  <p><strong>把已有 Markdown，做成可以发布的公众号文章。</strong></p>
  <p>按段改稿 · 朱雀质检 · 封面与插图 · SVG 动画卡 · 排版 · 排期 · 复盘</p>
  <p>
    <a href="#从-markdown-到复盘">工作流</a> ·
    <a href="#快速开始">快速安装</a> ·
    <a href="#走进工作台">功能导览</a> ·
    <a href="#深入使用">配置与数据</a> ·
    <a href="#开发">开发</a>
  </p>
  <p>
    <img alt="DeepSeek Harness 0.2.x" src="https://img.shields.io/badge/DeepSeek%20Harness-0.2.x-111?style=flat-square">
    <img alt="桌面版与网页版" src="https://img.shields.io/badge/%E6%A1%8C%E9%9D%A2%E7%89%88-%E7%BD%91%E9%A1%B5%E7%89%88-111?style=flat-square">
    <a href="LICENSE"><img alt="MIT 开源" src="https://img.shields.io/badge/MIT-%E5%BC%80%E6%BA%90-111?style=flat-square"></a>
  </p>
</div>

<br>

<img src="docs/assets/hero.webp" alt="公众号成稿台：从写稿到复盘，一个工作台完成" width="100%">

<br>

> 从一份已有 Markdown 开始。稿子、图片、排版、发布计划和真实表现，都留在同一个工作台里。

## 从 Markdown 到复盘

不是七件互不相干的小工具，而是一条连续的成稿路径：导入 `.md` / `.markdown` 稿件，按段修改并检查文字，完成封面、正文配图和排版，再安排发布、导入后台数据复盘。

<img src="docs/assets/workflow.gif" alt="导入 Markdown 稿件，按段改稿与质检，完成配图和排版，最后排期发布并复盘数据" width="100%">

<p align="center">
  <sub>稿面负责内容，配图负责视觉，排期负责行动，复盘负责下一次改进。</sub>
</p>

## 快速开始

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的「插件」→「添加插件」中输入 **`dsh-wechat-studio`**，点击安装。完成后，从宿主侧栏打开「公众号成稿台」。

<p align="center">
  <img src="docs/assets/install.webp" alt="在 DeepSeek Harness 的添加插件窗口中输入 dsh-wechat-studio" width="720">
</p>

也可以使用命令行：

<table>
<tr>
<td width="50%" valign="top">

**桌面版**

```bash
dsh plugin --profile desktop add dsh-wechat-studio
```

安装前完全退出 DeepSeek Harness，安装后重新打开。

</td>
<td width="50%" valign="top">

**网页版**

```bash
dsh plugin --profile web add dsh-wechat-studio
```

安装后重启 `dsh web`。

</td>
</tr>
</table>

需要 DeepSeek Harness `>=0.2.1-rc.5 <0.3.0`。排版引擎和封面裁切都是内置的纯 JS 实现，不需要另装 Python 等运行环境，Windows / macOS / Linux 均可用。终端里没有 `dsh` 时，可先在桌面版菜单中选择「管理 dsh 命令」。

<details>
<summary><strong>从源码安装、独立预览与卸载</strong></summary>

### 从源码安装

需要 Node.js 20 或更高版本。

```bash
git clone https://github.com/lqshow/dsh-wechat-studio.git
cd dsh-wechat-studio
npm ci
npm run build
dsh plugin --profile desktop add "$PWD"
```

网页版把最后一条命令中的 `desktop` 换成 `web`。

### 独立预览

```bash
npm ci
npm run build
npm run dev
```

打开 [本地预览](http://127.0.0.1:4173)。预览使用模拟宿主和固定的模型回复，数据保存在仓库的 `.dev/` 下。

### 卸载

桌面版插件可运行：

```bash
dsh plugin --profile desktop remove dsh-wechat-studio
```

</details>

## 走进工作台

### 01 · 改稿

**改你指定的段落，而不是把整篇重来。**

<img src="docs/assets/writing.webp" alt="成稿工作区：左侧对话改稿，中间编辑正文，右侧选择标题" width="100%">

<table>
<tr>
<td width="33%" valign="top">
<strong>导入，接着写</strong><br>
支持已有的 .md / .markdown 稿件。正文可直接编辑，也可以告诉左侧助手改哪一段、怎么改。
</td>
<td width="33%" valign="top">
<strong>一张稿面，集中处理</strong><br>
标题候选、正文目录和插入格式都在同一张稿面上，不必在多个工具之间来回切换。
</td>
<td width="33%" valign="top">
<strong>每一步都能回头</strong><br>
未保存文字在本机暂存，支持版本对比、撤销和恢复；审稿版也可以覆盖回原稿。
</td>
</tr>
</table>

### 02 · 质检

**问题落到段落，改动经过你确认。**

<img src="docs/assets/quality.webp" alt="朱雀质检：正文标红、纸边批注、待处理队列和改写操作" width="100%">

通过 API 在线检测，或导入朱雀 PDF 报告。待处理段落会出现在纸边批注和右侧队列里，点一下就能定位；支持单段改写和批量处理，每处修改都能看差异、保留原文或恢复上一版。

### 03 · 视觉

**封面、插图、动画卡，最后进入同一套排版。**

<table>
<tr>
<td width="50%" valign="top">
<h4>封面与正文插图</h4>
<img src="docs/assets/cover-inline.webp" alt="封面生成历史与当前封面，右侧可见正文插图和动画卡工具" width="100%">
<p>六套内置封面风格，生成结果留在历史里，可查看提示词、下载或重新选用。正文插图先分析位置，再由你决定生成和插入；确认前不改正文。</p>
</td>
<td width="50%" valign="top">
<h4>SVG 动画卡</h4>
<img src="docs/assets/svg-cards.webp" alt="正文中的 SVG 动画卡和右侧候选生成工具" width="100%">
<p>概念、步骤、拆解、对比、表格、柱状图、时间线和手机演示，八种卡型根据选中的段落生成。标题与条目可编辑，确认效果后才进入正文。</p>
</td>
</tr>
</table>

<br>

<img src="docs/assets/layout.webp" alt="公众号排版预览，包含正文风格、配色、开头横幅和复制全文" width="100%">

10 套正文风格、15 套配色，加上开头横幅和文末关注卡；正文插图与动画卡也会进入同一份排版。点击「复制全文到公众号」即可粘贴到编辑器，自查报告会提示外部图片、视频占位等需要人工确认的项目。

### 04 · 发布

**让每一篇稿子，在日历里有明确的位置。**

<img src="docs/assets/schedule.webp" alt="排期页：待排稿件、今日待办、过点确认和一周日历" width="100%">

待排稿件支持搜索和就绪筛选，可以拖拽或按日期、时段排期。今日待办与过点待确认分开，周历随窗口宽度调整；标记已发时可补记真实发表时间，重复确认不会覆盖首次记录，也可以更正或撤销。

### 05 · 复盘

**不只看阅读量，也记录下一篇要试什么。**

<img src="docs/assets/insights.webp" alt="数据复盘：账号指标、每日阅读趋势和流量来源" width="100%">

直接导入微信公众号后台的 XLS，查看账号趋势、用户增长、单篇明细和流量来源。按题材和标题套路比较文章表现，记录下一次要试什么；数据提炼出的写作规则，确认后可以保存为 Skill。

## 深入使用

<details>
<summary><strong>重新导入 Markdown：保留稿面，替换正文</strong></summary>

在「文章 → 更多操作 → 重新导入 Markdown」收回审稿版。先预检保留、移出和新增的正文块；默认只换正文，可选择同时更新标题。

封面、排期、排版配置和改稿聊天保留。覆盖后可在改稿对比查看，或用顶部撤销恢复。

</details>

<details>
<summary><strong>复盘数据：三类报表与写作实验</strong></summary>

在「复盘」中导入微信公众号后台导出的 `.xls` 文件。三类数据可独立查看。

| 导出类型 | 可以查看的内容 |
| --- | --- |
| 数据趋势 | 账号每日阅读与分享、渠道来源、单篇在统计窗口内的阅读人数与占比。 |
| 用户增长 | 每日新关注、取消关注和净增，以及期末累计关注。 |
| 单篇数据明细 | 阅读趋势、渠道、受众分布，以及消息打开比例、完读、停留、分享和新增关注等诊断指标。 |

关联趋势卡片后，可以从对应文章打开单篇明细。关联稿件后，复盘还能引用稿面的封面、标题套路和排版记录。给同类文章标记相同题材后，成绩单可比较发表首日或前 7 天表现，并把符合条件的文章放入「本期值得看的文章」。

可以从成绩单记录「下一篇试什么」，再关联下一篇稿件。新稿明细导入并关联后，可比较两篇发表后 7 天的表现并记录结论。由数据生成的 Skill 规则提供预览，确认后才写入本地覆盖目录。

阅读人数以对应导出表的统计口径为准。按天累计的指标可能重复计入跨天读者。「近 7 天 / 近 30 天」筛选的是文章发表日期，账号趋势和用户增长各自使用导出表的统计窗口。

</details>

<details>
<summary><strong>按需配置模型、检测、生图与图床</strong></summary>

插件采用 MIT 许可证。模型、检测、生图和图床服务使用你自己的账号及额度，费用按各服务商规则计算。

| 服务 | 用途 | 配置入口 |
| --- | --- | --- |
| DeepSeek Harness 模型 | 改稿、标题、横幅、封面提示词、正文插图建议和 SVG 动画卡内容 | 在宿主配置模型，然后在插件里选择。 |
| 朱雀 API | 在线检测正文 | 在 EdgeOne Makers 的 Models → API Key 创建密钥，在插件「设置 → 朱雀质检」测试并保存。也可直接上传报告 PDF。 |
| 火山方舟 | 生成封面图和正文插图（Doubao Seedream） | 在「设置 → 封面生成」选择提供方为火山方舟，填写 API Key 并选择生图模型。 |
| 阿里云百炼 | 生成封面图和正文插图（通义万相 / 千问图像，仅 PNG） | 在「设置 → 封面生成」选择阿里云百炼，填写中国内地（北京）的 API Key 并选择生图模型。 |
| Cloudinary | 转存飞书图片、上传本地图片，并在确认插入正文插图时取得可发表的 HTTPS 地址 | 在「设置 → 图片图床」填写 Cloud Name、API Key 和 API Secret。 |

导入飞书 Markdown 后，图片会在后台转存，成功后正文使用 Cloudinary 的可访问地址。如果失败，可以在稿面重试。飞书链接过期时，请重新从飞书复制 Markdown。编辑正文时也可直接粘贴剪贴板图片，或在「插入 → 图片与图注 / 长图卡」中选择本地 PNG、JPEG、GIF、WebP（不超过 10 MB）；确认插入后上传到 Cloudinary，再写入普通 Markdown 图片。

**封面人物与服装**：开源版默认不带参考图；想让封面人物是自己，可在「设置 · 封面生成」上传清晰的正脸半身照（需先配置 Cloudinary）或粘贴公网 https 图片地址。服装支持三种模式：沿用参考图衣服（适合半身照）、简约纯色上衣（适合只传头像时按性别配衣）或自定义描述。不填参考图时，人物由性别和外貌补充文字生成，每次长相会不同。如果需要固定为作者同款服装，可在自定义描述里填写：

```text
an OVERSIZED, RELAXED-FIT heavyweight waffle-knit short-sleeve polo shirt in Midnight Green (#004953), dropped shoulders, wide loose sleeves, collar open with both buttons undone, visible waffle texture, similar to iPhone 11 Pro Midnight Green — NOT a fitted business polo
```

升级提示：之前从未保存过设置的用户，升级后封面默认不带参考图，需要自己填一次；之前保存过任意设置的用户，`settings.json` 里可能已存有插件作者的示例照片，升级后设置页和封面弹窗会出现提醒，请换成自己的照片或清空。

朱雀 API 的分类置信度和 PDF 报告得分分别显示，两者含义不同，不直接比较。PDF 有完整片段汇总表时，人工、疑似 AI 和 AI 的总体占比按片段比例计算并明确标注。API 按原文匹配段落；标准 PDF 按片段原文直接匹配，无法直接解析的版式才由模型辅助，以报告原文为准。重复的开头语等内容，可在设置里加入检测时排除的固定句。

</details>

<details>
<summary><strong>本地数据与技能覆盖</strong></summary>

插件数据默认在 `~/.dsh/wechat-studio/`。设置 `DSH_HOME` 后，根目录改为 `$DSH_HOME/wechat-studio/`。

| 文件或目录 | 用途 |
| --- | --- |
| `index.json` | 稿件顺序、当前稿件和全局排版偏好等顶层状态 |
| `articles/<id>/article.json` | 单篇稿件本体与稿面状态（不含改稿历史） |
| `articles/<id>/history.json` | 单篇稿件的改稿历史记录 |
| `state.json.v1.bak` | 从旧版单文件 `state.json` 自动迁移后的原文件备份，可在确认无误后手动删除 |
| `*.bak` / `*.corrupt-*` | 上一版写入备份与损坏文件的隔离副本。某篇稿件打不开时，把同目录下的 `.corrupt-*` 或 `.bak` 改回 `article.json` 即可 |
| `settings.json` | 插件设置和服务凭证 |
| `insights.json` | 复盘导入数据、匹配、题材和写作尝试 |
| `covers/` | 生成的封面图片 |
| `inline-images/` | 已生成但独立保存的正文插图 PNG 资产；清理不再引用的文件和崩溃遗留的孤儿文件 |
| `skills/` | 用户覆盖技能、插图风格扩展，以及确认写入的复盘规则 |
| `style-profile.json` | 个人写作风格档案与生效记录（在「技能 → 我的写作风格」里导入过往文章生成，可编辑风格体检卡、现场试写并随时一键恢复默认风格） |

**升级与降级**

从旧版本升级时，首次启动会自动把 `state.json` 迁移到 `articles/` 目录，原文件改名为 `state.json.v1.bak`，无需手动操作。迁移后**不支持降级**：装回旧版本会看到空的稿件列表，旧版本里新写的内容也不会被新版本读取。如果必须回到旧版本，先退出插件，把 `state.json.v1.bak` 改名回 `state.json`；迁移后在新版本里做的修改不会带回去。

未保存的段落文字和上次编辑位置保存在当前宿主的本地存储中。调用模型、朱雀、火山方舟、阿里云百炼或 Cloudinary 时，相应任务的数据会发送给所用服务。

可覆盖的内置技能包括 [写作](skills/writer.md)、[标题](skills/headline.md)、[去 AI 味](skills/humanizer.md)、[朱雀流程](skills/zhuque.md)和[开头横幅](skills/banner.md)。将同名文件放进数据目录的 `skills/`，下一次调用就会读取该版本。

[封面技能](skills/linyuebanzi-cover-banner/SKILL.md)从插件内置目录读取。风格模板与禁用词表位于同目录的 [references](skills/linyuebanzi-cover-banner/references/)，封面生成时会重新读取。

[正文插图技能](skills/linyuebanzi-inline-diagram/SKILL.md)保留完整目录结构，包含提示词模板、示例和全部风格文件。应用分析只读取 `references/analysis-contract.md` 并剥离 frontmatter，不执行原 skill 中的外部脚本；生图读取 `references/styles/`。将 `linyuebanzi-inline-diagram/` 放进数据目录的 `skills/` 后可以覆盖这些文件；新增符合 `小写字母-短横线.md` 命名的风格文件，就会自动出现在生成对话框中，无需修改 JavaScript。

风格列表按文件变化缓存，单个文件不可读时跳过并在配图页提示，不影响其他功能。生成对话框以画廊显示原 skill 仓库的成品预览，预览图缩至 640px 宽并以内联 WebP 打包；扩展风格没有内置预览时显示名称和回退卡片。

[SVG 动画卡技能](skills/wechat-svg-cards/SKILL.md)包含八种卡型的内容约束和示例，渲染脚本内置在插件中。动画使用 SMIL，不执行卡片中的脚本或加载外部资源。卡片以 Markdown 保存，可原位播放、收起、重播或单独复制；复制结果保留 SMIL 动画。发布前请先在公众号测试草稿粘贴单卡和整篇，确认所用客户端保留动画、顺序和配色。

</details>

<details>
<summary><strong>作为 CLI 供其他 Agent 调用（不依赖 DSH 宿主）</strong></summary>

在保留全部 DeepSeek Harness 插件能力的同时，仓库也提供独立命令行入口 `wechat-studio`（`bin/wechat-studio.js`），可供 Claude Code、Codex、Cursor 等外部 Agent 或自动化脚本直接调用。默认与插件共用 `~/.dsh/wechat-studio/` 数据目录，也可用 `--data-dir <path>` 隔离运行。

```bash
# 直接运行（或 npm link 后全局使用 wechat-studio）
npx dsh-wechat-studio --help

# Markdown 排成公众号 HTML（--json 保证 stdout 输出单行结构化 JSON；可选 --banner <spec.json> 与 --follow-card）
wechat-studio layout article.md --style neo --theme forest --out preview.html --json

# 渲染单张公众号 SMIL 动画 SVG 卡片
wechat-studio svg-card svg-steps --title "写作流程" --line "收集素材" --line "起草改稿" --out card.html --json

# 稿件库与复盘数据（与 DSH 插件实时共享）
wechat-studio articles import article.md --json
wechat-studio articles list --json
wechat-studio insights import export.xls --json
wechat-studio insights summary --range 30 --json

# 查看当前生效的技能文件路径（内置或个人写作风格覆盖）
wechat-studio skills --json

# 朱雀检测与封面生成（封面支持 --prompt-only / --prompt-file 零模型 Key 闭环）
wechat-studio detect article.md --json
wechat-studio cover article.md --style felt --out cover.png --json
wechat-studio cover --prompt-file final-prompt.txt --style felt --out cover.png --json

# 个人写作风格（外部 Agent 可加 --prompt-only 免额外模型密钥）
wechat-studio style status --json
wechat-studio style analyze sample1.md sample2.md --prompt-only --json
wechat-studio style apply profile.json --json
wechat-studio style restore --json
```

给外部 Agent 配套的技能说明位于 [skills/cli-agent/SKILL.md](skills/cli-agent/SKILL.md)。

</details>

## 开发

```bash
npm ci
npm run build    # 构建 dist/client.js
npm run watch    # 监听客户端并重新构建
npm run dev      # 启动本地预览
npm test         # 运行自动化测试
npm pack         # 构建并打包可安装的 tgz
```

修改 `src/` 后重启宿主。PDF 用例是否运行取决于本机的 Chrome 和 PDF 工具。

<table>
<tr>
<td width="33%" valign="top">
<strong>界面</strong><br>
<code>client/</code>：稿面、编辑器、排版预览、设置与复盘界面<br><br>
<code>dist/</code>：宿主加载的客户端构建产物
</td>
<td width="33%" valign="top">
<strong>能力</strong><br>
<code>src/</code>：Host 接口、文章流水线、模型调用、数据存储与 XLS 解析<br><br>
<code>skills/</code>：随插件分发的技能和封面模板
</td>
<td width="33%" valign="top">
<strong>基础设施</strong><br>
<code>vendor/layout/</code>：微信公众号排版引擎<br><br>
<code>scripts/</code>：构建和本地预览脚本<br><br>
<code>test/</code>：核心逻辑和 Host 接口测试
</td>
</tr>
</table>

Host 接口通过宿主鉴权。页面只读取凭证是否已配置，密钥由 Host 使用。模型返回的改稿操作经过白名单和段号校验。

## 许可证与致谢

本项目是社区插件，采用 [MIT 许可证](LICENSE)。

感谢 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供插件系统。排版引擎来自 [lqshow/wechat-article-skills](https://github.com/lqshow/wechat-article-skills)，同样采用 MIT 许可证。
