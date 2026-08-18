# dsh-updater

A DeepSeek Harness web plugin that checks the local DSH version against the
official latest and updates the installation checkout — while **never touching
user configuration** (`~/.dsh`) and **never discarding your own commits**.

- **Settings page ("Updates")** — source / running / latest version, outdated
  badge, branch + working-tree guards, check button, update buttons, live
  operation log, and an update confirmation dialog.
- **Sidebar footer badge** — a compact version pill (green = up to date,
  amber = update available, red = check error); click to refresh.
- Host HTTP surface `GET /__dsh-update/status|info`, `POST /__dsh-update/check|update`.

## How it works

DSH is a git checkout. "Update" means: fetch the official upstream and **rebase
your `local-patches` branch** onto it. Your own commits (e.g. the local core
patches used by [`dsh-archived-sessions`](https://github.com/Jxy-hy/dsh-archived-sessions))
are replayed on top — a conflict stops the rebase and is reported, never
auto-resolved. Your user configuration lives in `~/.dsh`, which is **outside**
the checkout and is never written by this plugin.

## Install

1. Clone/build this package (`npm install && npm run build`).
2. Add it to your web profile (`~/.dsh/profiles/web`):

   `package.json` → `dependencies`:
   ```json
   "dsh-updater": "link:D:/PROJECT/dsh-updater"
   ```

   `cordis.patch.yml`:
   ```yaml
   - insert:
       - id: dsh-updater
         name: 'dsh-updater'
         config:
           installPath: 'D:/Program Files (x86)/deepseek-harness'
   ```

3. Restart `dsh web` (or rely on the profile patch layer hot-apply). Open
   **Settings → Updates**.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `installPath` | auto-detect (cwd walk-up) | Absolute path of the DSH checkout (the git repo to update) |
| `upstreamRemote` | `upstream` | Remote holding the official repo |
| `upstreamBranch` | `master` | Official remote branch to follow |
| `patchesBranch` | `local-patches` | Local branch expected to carry your commits; updates only run on it |
| `registryPackage` | `@deepseek-ai/dsh` | npm package whose `latest` dist-tag is the official version |
| `registryBase` | `https://registry.npmjs.org` | npm registry base |

## Update semantics

- **Only the checkout changes.** `~/.dsh` (settings, credentials, profiles,
  sessions, attachments) is never touched.
- **Dirty working tree → the update refuses.** Commit or stash first. Untracked
  files and local commits are never silently discarded.
- **Wrong branch → the update refuses.** It only runs on `patchesBranch`
  (`local-patches`), the branch that carries your commits.
- **Conflict → the rebase stops** and reports the conflicted files; you resolve
  (or `git rebase --abort`). Nothing is auto-resolved.
- **Restart required after updating** — the running process still executes the
  old code. The plugin reports source-vs-running mismatch and prompts you to
  restart `dsh web`; it never restarts for you.

## Development

```bash
npm install
npm run build     # tsc + tsdown (node half + client bundle)
npm run typecheck
npm run watch     # tsdown --watch
```

See [`dsh-archived-sessions`](https://github.com/Jxy-hy/dsh-archived-sessions)
for the sibling plugin this one's structure mirrors.
