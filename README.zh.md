# dsh-updater

DeepSeek Harness 的 Web 插件：检测本地 DSH 版本是否过时，并在**不触碰用户配置（`~/.dsh`）**、**不丢弃你自己的提交**的前提下更新到官方最新版。

- **设置页「更新」**——源码/运行/最新版本、过时徽标、分支 + 工作区守卫、检查按钮、更新按钮、实时操作日志与更新确认对话框（含 dry-run 预览）。
- **侧边栏底部版本徽章**——紧凑版本胶囊（绿=已验证已是最新，黄=有可用更新/未验证，红=检查出错）；点击刷新。
- **自动检查 + 弹出提示**——缓存超过 30 分钟自动重新检查（页面打开期间版本数据不会陈旧超过约 30 分钟）；新检测到更新时弹出瞬态提示。
- **一键提交并推到 fork**——工作区有未提交改动时按钮可用：git add -A + git commit + git push origin。推送失败记为 partial（已本地提交，仅网络这一步失败）。
- **诚实诊断**——官方最新版本以 git 上游 tag 为准（npm registry 仅作回退，避免 npm 滞后藏掉真实更新）；上游 fetch 失败时标记为「未验证」，绝不显示虚假的绿色「已是最新」。
- Host HTTP surface：`GET /__dsh-update/status|info`、`POST /__dsh-update/check|preview|update|commit-push`。

## 原理

DSH 是一个 git 检出。「更新」= fetch 官方 upstream，然后把你的 `local-patches` 分支 **rebase** 到它上面。你自己的提交（例如 [`dsh-archived-sessions`](https://github.com/Jxy-hy/dsh-archived-sessions) 依赖的本地核心补丁）会被自动叠加；冲突时 rebase 停在冲突处并如实报告，**绝不自动解决**。「官方最新」版本取自 `upstream/<branch>` 顶端的最新 tag——更新本身就是在 rebase 到这个引用，因此它是唯一权威的来源。npm registry 仅作为回退（在没有配置 upstream 远程时使用），因为 npm 发布版可能滞后于 git 仓库。用户配置在 `~/.dsh`，位于检出目录**之外**，本插件从不写入。

## 安装

1. 构建本包：`npm install && npm run build`。
2. 加入你的 web profile（`~/.dsh/profiles/web`）：

   `package.json` → `dependencies`：
   ```json
   "dsh-updater": "link:D:/PROJECT/dsh-updater"
   ```

   `cordis.patch.yml`：
   ```yaml
   - insert:
       - id: dsh-updater
         name: 'dsh-updater'
         config:
           installPath: 'D:/Program Files (x86)/deepseek-harness'
   ```

3. 重启 `dsh web`（或依赖 profile patch 层热生效）。打开 **设置 → 更新**。

## 配置

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `installPath` | 自动探测（cwd 向上查找） | DSH 检出目录的绝对路径（要更新的 git 仓库） |
| `upstreamRemote` | `upstream` | 持有官方仓库的远程名 |
| `upstreamBranch` | `master` | 要跟随的官方远程分支 |
| `patchesBranch` | `local-patches` | 承载你提交的本地分支；更新只在该分支上执行 |
| `registryPackage` | `@deepseek-ai/dsh` | 以 `latest` dist-tag 作为回退版本信号的 npm 包（官方版本以 git 上游 tag 为准） |
| `registryBase` | `https://registry.npmjs.org` | npm registry 地址 |

## 更新语义

- **只改动检出目录**。`~/.dsh`（settings、credentials、profiles、sessions、attachments）从不触碰。
- **工作区有未提交改动 → 拒绝更新**。请先 commit 或 stash。未跟踪文件与本地提交绝不静默丢弃。
- **分支不对 → 拒绝更新**。只在 `patchesBranch`（`local-patches`）上执行。
- **冲突 → rebase 停在冲突处**并报告冲突文件，由你解决（或 `git rebase --abort`）。绝不自动解决。
- **更新后需重启**——运行中的进程仍是旧代码。插件会报告源码/运行版本不一致并提示你手动重启 `dsh web`，不会替你重启。
- **版本判断以 git 上游为准。**「官方最新」和过时/已是最新徽章均以 `upstream/<branch>` 引用为准。npm registry 仅为回退；npm `latest` dist-tag 滞后时不会藏掉真正的上游更新。

## 开发

```bash
npm install
npm run build     # tsc + tsdown（node half + client bundle）
npm run typecheck
npm run watch     # tsdown --watch
```

结构参考姊妹插件 [`dsh-archived-sessions`](https://github.com/Jxy-hy/dsh-archived-sessions)。
