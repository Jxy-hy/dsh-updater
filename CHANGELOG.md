# Changelog

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
