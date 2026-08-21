# Changelog

## [0.1.3] — 2026-08-21

### Fixed

- **fetch 自动重试 (Fetch retries).** `/check`、`/preview`、`/update` 中的 `git fetch --tags` 现在自动重试 3 次（间隔 5 秒）。之前单次网络抖动（如 SSL 连接被重置）就会让整次检查失败，页面持续显示过期的版本信息。
  
  The `git fetch --tags` in `/check`, `/preview` and `/update` now retries automatically (3 attempts, 5 s apart). A single network hiccup (e.g. an SSL connection reset) no longer poisons the whole check and leaves the page showing a stale version.

- **自动重查真正生效 (The auto re-check actually works now).** 客户端自动检查的陈旧阈值从 12 小时缩短到 30 分钟，并把「每个会话只自动检查一次」的守卫改为 30 分钟限频——页面保持打开时版本数据不会陈旧超过约 30 分钟，上游发布新版本后页面会自动发现，无需手动点击。
  
  The client auto-check staleness threshold drops from 12 h to 30 min, and the "auto-check once per session" guard becomes a 30-min rate limit — while the page stays open, version data can never be older than about 30 minutes, so a new upstream release surfaces on its own without a manual click.

### Added

- **数据陈旧提示 (Staleness hints).** 「上次检查」现在附带相对时间（如「5 分钟前」）；缓存超过 30 分钟时时间戳变为琥珀色，并出现软提示引导点击「检查更新」。
  
  "Last checked" now shows a relative age (e.g. "5 min ago"); when the cache is older than 30 minutes the timestamp turns amber and a soft note prompts a re-check.

---

## [0.1.2] — 2026-08-20

### Fixed

- **更新后自动构建 (Mandatory build after update).** 更新流程现在总是在 rebase 之后运行 `pnpm run build`，确保 `lib/` 下的编译产物与 rebase 后的源码一致。之前更新只 rebase 源码而不重新构建，导致重启后 harness 因缺失编译产物（如 `typert.host.js`、client bundles）无法启动。
  
  Every update now runs `pnpm run build` after the rebase, so the compiled artifacts under `lib/` match the rebased sources. Previously the update only rebased the source without rebuilding, which left the harness unable to start after a restart (missing `typert.host.js` and client bundles).

- **构建失败可见 (Build failures are surfaced).** 更新结果现在携带 `build` 字段；构建失败会在结果通知中显示（含退出码）。

  The update result now carries a `build` field; a failed build is shown in the result notice (with the exit code).

---

## [0.1.1] — 2026-08-20

### Fixed

- **版本判断以 git 上游为准 (Version verdict is now git-first).** 「官方最新」和过时/已是最新徽章现在以 `upstream/<branch>` 顶端的最新 tag 为准（npm registry 仅作回退）。之前的版本以 npm `latest` dist-tag 为唯一来源，当 npm 发布滞后于 git 仓库时（例如 npm 仍在 rc.7 而上游仓库已打 rc.8 tag），页面会错误地显示「已是最新」而实际上有可用更新。
  
  The "official latest" card and the outdated/up-to-date badge now derive from the tag on the upstream remote tip (`upstream/<branch>`) — the same ref the update rebases onto. The npm registry is a fallback for installs without a configured upstream remote. Previously, an npm `latest` dist-tag that lagged behind the git repo would cause the page to falsely report "up to date" when an update was available.

- **未验证状态 (Unverified state).** 当上游 git fetch 失败（或本次会话中从未成功），页面不再显示绿色「已是最新」徽章，而是显示琥珀色「无法确认是否最新」徽章，并注明判断基于可能过期的引用。侧边栏徽章同步处理。
  
  When the upstream git fetch fails (or has never succeeded in this session), the page no longer shows a green "up to date" badge. Instead, it shows an amber "unverified" badge and notes that the verdict is based on possibly stale refs. The sidebar badge synchronises.

- **诚实诊断 (Honest diagnostics).** fetch 失败提示文案从「版本判断不受影响」修正为「版本判断基于本地缓存的上游引用，可能已过期，请重试检查」。
  
  The fetch-failure note text now correctly states that the version verdict may be stale, rather than claiming "version detection is unaffected."

- **npm 查询失败降级为软提示 (npm lookup failure is now a soft note).** 当 upstream 引用存在时，npm 查询失败仅作软提示（git 上游仍为权威来源）；仅在无 upstream 引用时才是硬错误。
  
  A failed npm lookup is now a soft note when the upstream ref is available (the git upstream remains authoritative), and only a hard error when the upstream ref is absent.

---

## [0.1.0] — 2026-08-19

### Added

- 初始发布 (Initial release). 版本检查 (`/status`)、手动检查 (`/check`)、更新预览 (`/preview`)、更新执行 (`/update`)、一键提交并推送到 fork (`/commit-push`)。
- 设置页「更新」：源码/运行/最新版本卡片、过时/已是最新徽章、分支 + 工作区守卫、实时操作日志。
- 侧边栏底部版本徽章。
- 自动检查 + 弹出提示（缓存超过 12 小时自动重新检查）。
- 更新确认对话框（含 dry-run 预览：from→to 版本、新上游提交列表、将要保留的本地提交列表）。
- 冲突安全：rebase 冲突时报告并停止，绝不自动解决。
