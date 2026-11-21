# GitHub Actions 与发版

仓库仅有两个工作流：

- `CI`：push 到 `main` 或提交 PR 时，在 Linux / Windows / macOS × Node 20 / 22 上运行元数据与冲突标记检查、提交差异空白检查、`npm ci`、构建、全量测试和安装包冒烟。
- `Release`：push `v*` 标签时先核对标签与 `package.json`、锁文件版本，再重跑上述六组构建、测试和包冒烟。全部通过后，将 Linux / Node 22 验证的同一份 `.tgz` 发布到 npm，并创建带自动提交说明及安装包附件的 GitHub Release。

`npm pack` 会通过现有 `prepack` 自动重建 `dist/`。冒烟测试在仓库外的临时目录使用 `--offline --omit=dev --ignore-scripts` 安装包，通过实际 `wechat-studio` 命令检查版本、内置技能和离线排版，并验证 DSH 导出入口及预打包文件。可在本地复现：

```sh
npm ci
npm run build
npm test
mkdir -p artifacts
npm pack --pack-destination artifacts
npm run smoke:package
```

首次发版前，推荐在 npm 的 `dsh-wechat-studio` 包设置中添加 **Trusted Publisher → GitHub Actions**：组织/用户名 `lqshow`、仓库 `dsh-wechat-studio`、工作流文件 `release.yml`；不设置 Environment，并允许 `npm publish`。工作流的发布任务使用 Node 24 和 `id-token: write`，通过 GitHub OIDC 获取临时发布凭证，无需在 GitHub 配置 `NPM_TOKEN` 或 `NODE_AUTH_TOKEN`。Trusted Publishing 的要求见 [npm 官方文档](https://docs.npmjs.com/trusted-publishers/)。

以后从准备发布的提交执行：

```sh
npm version patch
# 确认 package.json、package-lock.json 和 v 标签的版本一致
# npm version 默认创建版本提交和标签；请先确保工作区干净
git push origin main --follow-tags
```

`npm version minor` / `major` 用于相应版本升级。带 `-rc.1` 等后缀的预发布版本自动使用 npm `next` 标签和 GitHub prerelease，正式版本使用 `latest`。npm 发布成功但 GitHub Release 失败时，可重跑同一次工作流：只有 npm 上已存在包的 SHA-512 与本次安装包一致才会跳过发布并补齐 Release。

要真正挡住未通过检查的合并，还需在 GitHub `main` 分支 Ruleset 中启用 PR 合并及必需的六个 CI 检查；仅添加工作流不会自动启用分支保护。
