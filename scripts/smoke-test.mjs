/**
 * dsh-updater host smoke test — boots the built host plugin on a minimal
 * fake cordis context + real HTTP server, and exercises /status, /check and
 * /update against:
 *   1. the REAL install checkout (read-only: status + check),
 *   2. a throwaway fake git repo (full update + patch preservation),
 *   3. a conflicting fake repo (update refuses to auto-resolve).
 *
 * Run: node scripts/smoke-test.mjs [installPath]
 * Requires: git, network (npm registry).
 */

import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const INSTALL = process.argv[2] ?? 'D:/Program Files (x86)/deepseek-harness'

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function boot(config) {
  const routes = []
  const fakeCtx = {
    logger: { warn: (...a) => console.warn('  [host.warn]', ...a), error: (...a) => console.error(...a) },
    effect: (fn) => fn(),
    webServer: {
      register: (route) => { routes.push(route); return () => {} },
    },
  }
  apply(fakeCtx, config)
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const route = routes.find((r) => r.kind === 'exact'
      ? pathname === r.path
      : pathname === r.path || pathname.startsWith(`${r.path}/`))
    if (route !== undefined) route.handler(req, res)
    else { res.writeHead(404); res.end('not found') }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      base: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => server.close(done)),
    }))
  })
}

async function call(base, path, method = 'GET', body) {
  const res = await fetch(`${base}${path}`, body === undefined
    ? undefined
    : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 200) } }
  return { status: res.status, json }
}

function assert(cond, label) {
  if (!cond) { console.error(`  ✗ FAIL: ${label}`); process.exitCode = 1 }
  else console.log(`  ✓ ${label}`)
}

/** A fake "official upstream" git repo: one tag + commit per version. */
function makeUpstreamRepo(versions) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-upstream-'))
  git(dir, 'init', '-b', 'master')
  git(dir, 'config', 'user.email', 'up@test')
  git(dir, 'config', 'user.name', 'upstream')
  for (const version of versions) {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-root', version }))
    git(dir, 'add', '.')
    git(dir, 'commit', '-m', `release ${version}`)
    git(dir, 'tag', `dsh-v${version}`)
  }
  return dir
}

/** Add one more release commit + tag to an upstream repo. */
function addVersion(upstreamDir, version) {
  writeFileSync(join(upstreamDir, 'package.json'), JSON.stringify({ name: 'dsh-root', version }))
  git(upstreamDir, 'add', '.')
  git(upstreamDir, 'commit', '-m', `release ${version}`)
  git(upstreamDir, 'tag', `dsh-v${version}`)
}

/**
 * A fake "installation" git repo that SHARES history with the upstream
 * (cloned from it at rc.5), then adds a local-patches branch with a patch
 * commit — the same shape as the real setup.
 */
function makeFakeInstall(upstreamDir) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-install-'))
  git(dir, 'clone', '-q', upstreamDir, dir)
  git(dir, 'config', 'user.email', 'user@test')
  git(dir, 'config', 'user.name', 'local user')
  git(dir, 'checkout', '-q', '-b', 'local-patches')
  const patchFile = join(dir, 'packages/core/session/src/index.ts')
  mkdirSync(join(patchFile, '..'), { recursive: true })
  writeFileSync(patchFile, '// local patch: dispose()\nexport function dispose() {}\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'local: session dispose patch')
  git(dir, 'remote', 'add', 'upstream', upstreamDir)
  return dir
}

async function main() {
  console.log('== boot ==')
  const { base, close } = await boot({ installPath: INSTALL })

  console.log('\n== 1. /status on the REAL install (read-only) ==')
  let r = await call(base, '/__dsh-update/status')
  assert(r.status === 200, `status HTTP 200 (got ${r.status})`)
  assert(r.json.resolved === true, `installPath resolved (${r.json.installPath})`)
  assert(r.json.branch === 'local-patches', `branch local-patches (got ${r.json.branch})`)
  assert(r.json.sourceVersion === '0.1.0-rc.7', `sourceVersion 0.1.0-rc.7 (got ${r.json.sourceVersion})`)
  // NOTE: the real install may legitimately hold user WIP — treeClean is not
  // asserted here (it IS asserted on the throwaway fake repos).
  assert(r.json.upstreamRemotePresent === true, 'upstream remote present')
  console.log('  status sample:', JSON.stringify({
    branch: r.json.branch, head: r.json.head, describe: r.json.describe,
    sourceVersion: r.json.sourceVersion, runningVersion: r.json.runningVersion,
    latestVersion: r.json.latestVersion, outdated: r.json.outdated,
    upToDate: r.json.upToDate, needsRestart: r.json.needsRestart,
    treeClean: r.json.treeClean, dirty: r.json.dirty,
  }))

  console.log('\n== 2. /check on the REAL install (npm + upstream fetch) ==')
  r = await call(base, '/__dsh-update/check', 'POST', {})
  assert(r.status === 200, `check HTTP 200 (got ${r.status})`)
  assert(r.json.latestVersion === '0.1.0-rc.7', `latestVersion 0.1.0-rc.7 (got ${r.json.latestVersion})`)
  assert(r.json.outdated === false, 'not outdated (local == latest)')
  console.log('  check sample:', JSON.stringify({ latestVersion: r.json.latestVersion, outdated: r.json.outdated, checkError: r.json.checkError, lastCheckedAt: r.json.lastCheckedAt }))

  console.log('\n== 3. /update on a FAKE install (rc.5 + patch → rebase onto rc.7) ==')
  const upstreamDir = makeUpstreamRepo(['0.1.0-rc.5'])
  const fakeInstall = makeFakeInstall(upstreamDir)
  addVersion(upstreamDir, '0.1.0-rc.6')
  addVersion(upstreamDir, '0.1.0-rc.7')
  const fakeBoot = await boot({ installPath: fakeInstall })
  const patchFile = join(fakeInstall, 'packages/core/session/src/index.ts')
  assert(existsSync(patchFile), 'patch file present before update')
  const patchBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fakeInstall, encoding: 'utf8' }).trim()
  // Preview (dry-run) BEFORE the update: must describe the plan without rebasing.
  r = await call(fakeBoot.base, '/__dsh-update/preview', 'POST', {})
  assert(r.status === 200, `preview HTTP 200 (got ${r.status})`)
  const preview = r.json
  assert(preview.ok === true, 'preview ok')
  assert(preview.targetVersion === '0.1.0-rc.7', `preview targetVersion 0.1.0-rc.7 (got ${preview.targetVersion})`)
  assert(preview.upToDate === false, 'preview not up to date')
  assert((preview.newCommits ?? []).length === 2, `preview lists 2 new upstream commits (got ${JSON.stringify(preview.newCommits)})`)
  assert((preview.localCommits ?? []).some((c) => c.includes('dispose patch')), 'preview lists our local patch to replay')
  const headUnchanged = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fakeInstall, encoding: 'utf8' }).trim()
  assert(headUnchanged === patchBefore, 'preview did not mutate HEAD (no rebase)')
  console.log('  preview sample:', JSON.stringify({ targetVersion: preview.targetVersion, upToDate: preview.upToDate, newCommits: preview.newCommits?.length, localCommits: preview.localCommits }))
  r = await call(fakeBoot.base, '/__dsh-update/update', 'POST', { withInstall: false })
  assert(r.status === 200, `update HTTP 200 (got ${r.status})`)
  // Poll until the async operation settles.
  for (let i = 0; i < 60; i++) {
    await new Promise((done) => setTimeout(done, 300))
    const s = await call(fakeBoot.base, '/__dsh-update/status')
    if (!s.json.operation?.running) break
  }
  const final = await call(fakeBoot.base, '/__dsh-update/status')
  const result = final.json.lastUpdateResult ?? {}
  assert(result.ok === true, `update ok (${JSON.stringify(result.message ?? result)})`)
  assert(result.versionAfter === '0.1.0-rc.7', `versionAfter 0.1.0-rc.7 (got ${result.versionAfter})`)
  assert(existsSync(patchFile), 'patch file still present after update')
  const describeAfter = git(fakeInstall, 'describe', '--tags', '--always', '--dirty')
  assert(describeAfter.startsWith('dsh-v0.1.0-rc.7'), `describe now dsh-v0.1.0-rc.7... (got ${describeAfter})`)
  const porcelain = git(fakeInstall, 'status', '--porcelain')
  assert(porcelain === '', `fake install tree clean after update (got ${JSON.stringify(porcelain)})`)
  const headAfter = git(fakeInstall, 'rev-parse', 'HEAD')
  assert(headAfter !== patchBefore, 'HEAD moved (patch replayed on new base)')
  console.log('  update sample:', JSON.stringify(result))
  await fakeBoot.close()

  console.log('\n== 4. /update conflict safety on a FAKE install ==')
  const upstreamC = makeUpstreamRepo(['0.1.0-rc.5'])
  const conflictInstall = makeFakeInstall(upstreamC)
  // Upstream rc.7 touches the SAME file our patch touched → guaranteed conflict.
  const upstreamPatchFile = join(upstreamC, 'packages/core/session/src/index.ts')
  mkdirSync(join(upstreamPatchFile, '..'), { recursive: true })
  writeFileSync(upstreamPatchFile, '// upstream version\n')
  writeFileSync(join(upstreamC, 'package.json'), JSON.stringify({ name: 'dsh-root', version: '0.1.0-rc.7' }))
  git(upstreamC, 'add', '.')
  git(upstreamC, 'commit', '-m', 'upstream rewrote the patched file')
  git(upstreamC, 'tag', '-f', 'dsh-v0.1.0-rc.7')
  const conflictBoot = await boot({ installPath: conflictInstall })
  const cBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: conflictInstall, encoding: 'utf8' }).trim()
  r = await call(conflictBoot.base, '/__dsh-update/update', 'POST', {})
  assert(r.status === 200, `update HTTP 200 (got ${r.status})`)
  for (let i = 0; i < 60; i++) {
    await new Promise((done) => setTimeout(done, 300))
    const s = await call(conflictBoot.base, '/__dsh-update/status')
    if (!s.json.operation?.running) break
  }
  const cFinal = await call(conflictBoot.base, '/__dsh-update/status')
  const cResult = cFinal.json.lastUpdateResult ?? {}
  assert(cResult.ok === false, 'conflicting update reports failure')
  assert(cResult.conflict === true, 'conflict flagged')
  const conflicted = cResult.conflictedFiles ?? []
  assert(conflicted.some((f) => f.includes('session/src/index.ts')), `conflicted file reported (got ${JSON.stringify(conflicted)})`)
  // The real safety property: `git rebase --abort` restores the original HEAD —
  // nothing is auto-resolved, so nothing is ever lost.
  const rebaseState = execFileSync('git', ['rev-parse', '--git-path', 'rebase-merge'], { cwd: conflictInstall, encoding: 'utf8' }).trim()
  console.log('  conflict sample:', JSON.stringify({ conflict: cResult.conflict, conflictedFiles: conflicted, message: cResult.message }))
  console.log(`  (repo left mid-rebase at ${rebaseState} — as designed; test cleanup aborts it)`)
  git(conflictInstall, 'rebase', '--abort')
  const cHeadAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: conflictInstall, encoding: 'utf8' }).trim()
  assert(cHeadAfter === cBefore, 'HEAD restored after rebase --abort (no auto-resolution, nothing lost)')
  await conflictBoot.close()

  console.log('\n== 5. /preview on the REAL install (dry-run, read-only aside from fetch) ==')
  r = await call(base, '/__dsh-update/preview', 'POST', {})
  assert(r.status === 200, `preview HTTP 200 (got ${r.status})`)
  const rp = r.json
  assert(rp.ok === true, 'preview ok on real install')
  assert(rp.resolved === true, 'preview resolved')
  assert(rp.branch === 'local-patches', `preview branch local-patches (got ${rp.branch})`)
  assert(rp.sourceVersion === '0.1.0-rc.7', `preview sourceVersion 0.1.0-rc.7 (got ${rp.sourceVersion})`)
  // Commit lists require a successful upstream fetch (network). When the
  // fetch degrades (flaky GitHub), the preview reports fetchNote instead.
  if (rp.fetchNote !== null && rp.fetchNote !== undefined) {
    console.log('  (real install preview: upstream fetch degraded —', String(rp.fetchNote).slice(0, 80), ')')
  } else {
    assert(Array.isArray(rp.localCommits) && rp.localCommits.length >= 2, `preview lists our local commits (got ${JSON.stringify(rp.localCommits)})`)
  }
  console.log('  real preview sample:', JSON.stringify({
    sourceVersion: rp.sourceVersion, targetVersion: rp.targetVersion,
    upToDate: rp.upToDate, headBefore: rp.headBefore, headAfter: rp.headAfter,
    newCommits: rp.newCommits?.length ?? 0, localCommits: rp.localCommits?.length ?? 0,
    treeClean: rp.treeClean, fetchNote: rp.fetchNote ?? null,
  }))

  console.log('\n== 6. /commit-push on a FAKE install (dirty tree → commit → push to bare fork) ==')
  const upstream6 = makeUpstreamRepo(['0.1.0-rc.5'])
  const commitInstall = makeFakeInstall(upstream6)      // local-patches + patch commit, origin=upstream6
  const forkDir = mkdtempSync(join(tmpdir(), 'dsh-fork-'))
  git(process.cwd(), 'clone', '--bare', '-q', upstream6, forkDir)  // bare repo = the "fork"
  git(commitInstall, 'remote', 'set-url', 'origin', forkDir)
  // Dirty the tree: one modified tracked file + one new untracked file.
  const modified = join(commitInstall, 'packages/core/session/src/index.ts')
  writeFileSync(modified, '// local patch v2\n')
  const newFile = join(commitInstall, 'scripts/new-work.mjs')
  mkdirSync(join(newFile, '..'), { recursive: true })
  writeFileSync(newFile, '// new untracked work\n')
  const commitBoot = await boot({ installPath: commitInstall })
  const s0 = await call(commitBoot.base, '/__dsh-update/status')
  assert(s0.json.treeClean === false, 'status reports dirty tree (button would be enabled)')
  const headBeforeCP = git(commitInstall, 'rev-parse', 'HEAD')
  r = await call(commitBoot.base, '/__dsh-update/commit-push', 'POST', {})
  assert(r.status === 200, `commit-push HTTP 200 (got ${r.status})`)
  for (let i = 0; i < 60; i++) {
    await new Promise((done) => setTimeout(done, 300))
    const s = await call(commitBoot.base, '/__dsh-update/status')
    if (!s.json.operation?.running) break
  }
  const cpFinal = await call(commitBoot.base, '/__dsh-update/status')
  const cp = cpFinal.json.lastCommitPushResult ?? {}
  assert(cp.ok === true, `commit-push ok (${JSON.stringify(cp.message ?? cp)})`)
  assert(cp.committedFiles === 2, `committed 2 changes (got ${cp.committedFiles})`)
  assert(cp.branch === 'local-patches', `pushed branch local-patches (got ${cp.branch})`)
  const treeCleanCP = git(commitInstall, 'status', '--porcelain')
  assert(treeCleanCP === '', `tree clean after commit (got ${JSON.stringify(treeCleanCP)})`)
  const headAfterCP = git(commitInstall, 'rev-parse', 'HEAD')
  assert(headAfterCP !== headBeforeCP, 'HEAD advanced with the new commit')
  // The commit is on local-patches, on top of our patch commit.
  const patchOnTop = git(commitInstall, 'log', '--oneline', '-2')
  assert(patchOnTop.includes('working tree sync'), `auto commit message present (got ${JSON.stringify(patchOnTop)})`)
  // Pushed to the bare fork: refs/heads/local-patches there == our new HEAD.
  const forkHead = execFileSync('git', ['--git-dir', forkDir, 'rev-parse', 'refs/heads/local-patches'], { encoding: 'utf8' }).trim()
  assert(forkHead === headAfterCP, `pushed to fork (fork local-patches ${forkHead.slice(0, 8)} == local ${headAfterCP.slice(0, 8)})`)
  console.log('  commit-push sample:', JSON.stringify(cp))
  // Clean tree now → the host refuses a second commit-push gracefully.
  r = await call(commitBoot.base, '/__dsh-update/commit-push', 'POST', {})
  for (let i = 0; i < 60; i++) {
    await new Promise((done) => setTimeout(done, 300))
    const s = await call(commitBoot.base, '/__dsh-update/status')
    if (!s.json.operation?.running) break
  }
  const cpRefuse = (await call(commitBoot.base, '/__dsh-update/status')).json.lastCommitPushResult ?? {}
  assert(cpRefuse.ok === false && String(cpRefuse.message ?? '').includes('clean'), `clean tree refuses commit-push (${JSON.stringify(cpRefuse.message)})`)
  console.log('  clean-tree refusal:', cpRefuse.message)
  await commitBoot.close()

  console.log('\n== done ==')
  await close()
  if (process.exitCode === undefined) process.exitCode = 0
}

main().catch((error) => { console.error('smoke test crashed:', error); process.exitCode = 1 })
