# dsh-updater

DeepSeek Harness 的 Web 插件：检测本地 DSH 版本是否过时，并在**不触碰用户配置（`~/.dsh`）**、**不丢弃你自己的提交**的前提下更新到官方最新版。

- **设置页「更新」**——源码/运行/最新版本、过时徽标、分支 + 工作区守卫、检查按钮、更新按钮、实时操作日志与更新确认对话框。
- **侧边栏底部版本徽章**——紧凑版本胶囊（绿=已是最新，黄=有可用更新，红=检查出错）；点击刷新。
- Host HTTP surface：`GET /__dsh-update/status|info`、`POST /__dsh-update/check|update`。

## 原理

DSH 是一个 git 检出。「更新」= fetch 官方 upstream，然后把你的 `local-patches` 分支 **rebase** 到它上面。你自己的提交（例如 [`dsh-archived-sessions`](https://github.com/Jxy-hy/dsh-archived-sessions) 依赖的本地核心补丁）会被自动叠加；冲突时 rebase 停在冲突处并如实报告，**绝不自动解决**。用户配置在 `~/.dsh`，位于检出目录**之外**，本插件从不写入。

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
| `registryPackage` | `@deepseek-ai/dsh` | 以 `latest` dist-tag 作为官方版本的 npm 包 |
| `registryBase` | `https://registry.npmjs.org` | npm registry 地址 |

## 更新语义

- **只改动检出目录**。`~/.dsh`（settings、credentials、profiles、sessions、attachments）从不触碰。
- **工作区有未提交改动 → 拒绝更新**。请先 commit 或 stash。未跟踪文件与本地提交绝不静默丢弃。
- **分支不对 → 拒绝更新**。只在 `patchesBranch`（`local-patches`）上执行。
- **冲突 → rebase 停在冲突处**并报告冲突文件，由你解决（或 `git rebase --abort`）。绝不自动解决。
- **更新后需重启**——运行中的进程仍是旧代码。插件会报告源码/运行版本不一致并提示你手动重启 `dsh web`，不会替你重启。

## 开发

```bash
npm install
npm run build     # tsc + tsdown（node half + client bundle）
npm run typecheck
npm run watch     # tsdown --watch
```

结构参考姊妹插件 [`dsh-archived-sessions`](https://github.com/Jxy-hy/dsh-archived-sessions)。
