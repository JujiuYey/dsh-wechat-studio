---
name: wechat-studio-cli
description: 通过 wechat-studio CLI 调用公众号成稿台能力（公众号排版、SVG 动画卡、朱雀检测、封面生成、个人写作风格、生效技能查询与稿件/复盘管理），供外部 Agent 与自动化脚本使用。
---

# WeChat Studio CLI 使用指南（External Agent）

`wechat-studio` 是 `dsh-wechat-studio` 的命令行入口，与 DeepSeek Harness（DSH）插件共享同一套核心模块与默认工作区（`<DSH_HOME>/wechat-studio`），也可通过 `--data-dir <path>` 隔离运行。

## 调用约定

- **总是加 `--json`**：保证 `stdout` 只输出单行合法 JSON（`{"ok":true,...}` 或 `{"ok":false,"code":"USAGE|RUNTIME","error":"..."}`），方便解析。
- **退出码**：`0` 成功，`1` 运行时/接口错误，`2` 参数错误或缺少必填选项/文件。
- **自发现帮助**：任何一级或二级子命令都支持 `--help`（如 `wechat-studio layout --help`、`wechat-studio style analyze --help`）。
- **Stdin 管道（`-`）**：`layout -`、`detect -`、`articles import -`、`cover --prompt-file -`、`style apply -` 等均支持从标准输入读取内容，无需创建临时文件。
- **免额外密钥工作流（`--prompt-only`）**：外部 Agent 如果自带大模型，可在 `style analyze`、`style preview` 或 `cover` 上加 `--prompt-only`，直接拿结构化提示词交给自己生成结果，再调用 `style apply` 或 `cover --prompt-file` 完成闭环。

## 常用子命令

```bash
# 0. 查看当前工作区生效的技能文件路径（写稿/改稿前先读用户个人风格或默认技能）
wechat-studio skills --json

# 1. Markdown 排成公众号 HTML（支持文件路径或 - 读 stdin；推荐加 --out 避免大体积 HTML 占满上下文）
# 如需开头横幅，先读 skills --json 里的 banner.md 生成规格 JSON，再通过 --banner 传入；--follow-card 开启文末关注卡
wechat-studio layout article.md --style neo --theme forest --banner banner.json --follow-card --out preview.html --json
cat article.md | wechat-studio layout - --out preview.html --json

# 2. 渲染单张公众号 SMIL 动画 SVG 卡片
wechat-studio svg-card svg-steps --title "写作流程" --line "收集素材" --line "起草改稿" --out card.html --json

# 3. 稿件库管理（与 DSH 插件实时共享）
wechat-studio articles list --json
wechat-studio articles import article.md --json
wechat-studio articles get <id> --json

# 4. 零成本发布防踩坑体检（媒体/占位/32字标题阻断；商单外链/文字墙/合规词仅提醒不阻断）
wechat-studio check article.md --json
wechat-studio check article.md --fail-on-blocking --json

# 5. 朱雀文本检测（需配置环境变量或工作区设置中的朱雀 Key）
wechat-studio detect article.md --json

# 5. 个人写作风格（外部 Agent 推荐两步闭环：--prompt-only -> apply）
wechat-studio style status --json
wechat-studio style analyze sample1.md sample2.md --prompt-only --json
# 将 Agent 生成的 StyleProfile JSON 保存到 profile.json 后启用：
wechat-studio style apply profile.json --json
# 恢复默认风格：
wechat-studio style restore --json

# 6. 封面生成（2.35:1）
wechat-studio cover article.md --style felt --out cover.png --json
# 零模型 Key 闭环：先拿模板、slots、fragments、personSegments 和 system/user，
# 由 Agent 自身模型填完槽位并展开 [[...]] 后，通过 --prompt-file 直接生图并裁切：
wechat-studio cover article.md --style felt --prompt-only --json
wechat-studio cover --prompt-file final-prompt.txt --style felt --out cover.png --json

# 7. 复盘数据导入与汇总
wechat-studio insights import export.xls --json
wechat-studio insights summary --range 30 --json

# 8. 工作区配置（作者/标语/默认排版/服务凭证，不含明文回显）
wechat-studio settings get --json
wechat-studio settings set --author "你的公众号名" --slogan "一句话介绍" --style neo --theme forest --json

# 9. 公众号草稿箱推送（支持 --dry-run 本地预检，也支持环境变量 WECHAT_APP_ID / WECHAT_APP_SECRET）
wechat-studio draft verify --json
wechat-studio draft push article.md --style neo --theme forest --banner banner.json --follow-card --cover cover.png --json

# 10. 一稿多发（基于工作区稿件库已成稿导出通用 Markdown、串推、小红书）
wechat-studio derive markdown <articleId> --target zhihu --out zhihu.md --json
wechat-studio derive thread <articleId> --variant x --prompt-only --json
wechat-studio derive xhs <articleId> --prompt-only --json
# 或直连模型生成并回写工作区：
wechat-studio derive thread <articleId> --variant jike --force --json
```
