/**
 * dsh-updater — host half.
 *
 * A same-origin HTTP surface under `/__dsh-update` that lets the browser
 * inspect and update the DSH installation checkout:
 *
 * - `GET /status` — local source/running version, the official latest
 *   version (the tag on the upstream remote tip, with the npm registry as
 *   fallback), whether the local copy is outdated (new upstream commits),
 *   the branch and working-tree state, and the in-flight operation (if any).
 * - `POST /check` — force a fresh version check: `git fetch` the configured
 *   upstream remote (refresh refs + tags — the authoritative version source)
 *   and query the npm registry (fallback for installs without an upstream
 *   ref).
 * - `POST /update` — update the checkout to the official latest: fetch the
 *   upstream remote and rebase the current branch (the `local-patches`
 *   branch carrying the user's own commits) onto it. Conflicts STOP the
 *   rebase and are reported — never auto-resolved, so no user work is lost.
 *   `withInstall: true` additionally runs `pnpm install --frozen-lockfile`.
 *
 * Safety contract — this plugin must never lose user work or config:
 *  - Only the installation checkout (`installPath`, a git repo) is ever
 *    touched. The user home `~/.dsh` (settings, credentials, profiles,
 *    sessions, attachments) is outside the checkout and is never written.
 *  - A non-clean working tree REFUSES the update (the user commits or stashes
 *    first); untracked files and local commits are never silently discarded.
 *  - A rebase conflict leaves the repository in the conflict state for the
 *    user to resolve — the plugin reports the conflicted files and stops.
 *
 * The browser half (`src/client`) renders the Settings "Updates" section and
 * the sidebar version badge, and talks to this surface with same-origin
 * fetch; no new RPC method is added anywhere.
 */

import { execFile } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

export const name = 'dsh-updater'
export const inject = ['webServer']

/** Plugin configuration (see the README for the cordis.patch.yml example). */
export interface Config {
  /** Absolute path of the DSH installation checkout (the git repo to update). */
  installPath?: string
  /** Remote name holding the official repo (default `upstream`). */
  upstreamRemote?: string
  /** Remote branch of the official repo to follow (default `master`). */
  upstreamBranch?: string
  /** Local branch expected to carry the user's own commits (default `local-patches`). */
  patchesBranch?: string
  /** npm package whose `latest` dist-tag reports the official version (default `@deepseek-ai/dsh`). */
  registryPackage?: string
  /** Base npm registry (default `https://registry.npmjs.org`). */
  registryBase?: string
}

const ROUTE_PREFIX = '/__dsh-update'
const MAX_BODY_BYTES = 64 * 1024

/* ------------------------------------------------------------------------- *
 * Version comparison (semver-ish: numeric core + dot-segmented prerelease). *
 * ------------------------------------------------------------------------- */

interface ParsedVersion {
  core: number[]
  pre: Array<string | number>
  raw: string
}

function parseVersion(raw: string): ParsedVersion | null {
  const s = raw.trim().replace(/^dsh-v/i, '')
  const dash = s.indexOf('-')
  const corePart = dash === -1 ? s : s.slice(0, dash)
  const prePart = dash === -1 ? '' : s.slice(dash + 1)
  const core = corePart.split('.').map(part => Number.parseInt(part, 10))
  if (core.some(number => Number.isNaN(number))) return null
  const pre: Array<string | number> = []
  for (const seg of prePart.split('.')) {
    if (seg.length === 0) continue
    const number = Number(seg)
    pre.push(/^[0-9]+$/.test(seg) ? number : seg)
  }
  return { core, pre, raw: s }
}

function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  const coreLength = Math.max(a.core.length, b.core.length)
  for (let i = 0; i < coreLength; i++) {
    const x = a.core[i] ?? 0
    const y = b.core[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  const preLength = Math.max(a.pre.length, b.pre.length)
  for (let i = 0; i < preLength; i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    return x < y ? -1 : 1
  }
  return 0
}

/* ------------------------------------------------------------------------- *
 * Filesystem / git helpers.                                                  *
 * ------------------------------------------------------------------------- */

function execGit(install: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', install, ...args], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new GitError(args, stderr.trim()))
        return
      }
      resolve(stdout.trim())
    })
  })
}

/** Normalize an exec error to a numeric exit code (1 on non-numeric). */
function exitCode(error: { code?: string | number | null } | null): number {
  if (error === null) return 0
  const code = error.code
  return typeof code === 'number' ? code : 1
}

class GitError extends Error {
  constructor(readonly args: string[], readonly stderr: string) {
    super(`git ${args.join(' ')}: ${stderr || 'failed'}`)
    this.name = 'GitError'
  }
}

function isInstallRoot(dir: string): boolean {
  return existsSync(join(dir, 'pnpm-workspace.yaml'))
    && existsSync(join(dir, 'apps', 'cli', 'src', 'bin.ts'))
    && existsSync(join(dir, '.git'))
}

/** Resolve the checkout root: explicit config first, then a cwd walk-up. */
function resolveInstallPath(configured: string | undefined): string | undefined {
  if (configured !== undefined && configured.length > 0) return configured
  let dir = process.cwd()
  for (let depth = 0; depth < 10; depth++) {
    if (isInstallRoot(dir)) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

function readPackageJsonVersion(install: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(install, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

async function fetchLatestVersion(registryBase: string, registryPackage: string): Promise<{ version: string | null; error: string | null }> {
  try {
    const url = `${registryBase.replace(/\/+$/, '')}/${encodeURIComponent(registryPackage)}/latest`
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) return { version: null, error: `npm registry ${response.status}` }
    const body = await response.json() as { version?: unknown }
    return typeof body.version === 'string'
      ? { version: body.version, error: null }
      : { version: null, error: 'npm registry: no version field' }
  } catch (error) {
    return { version: null, error: String(error) }
  }
}

/* ------------------------------------------------------------------------- *
 * Status assembly.                                                           *
 * ------------------------------------------------------------------------- */

interface StatusData {
  ok: boolean
  resolved: boolean
  installPath?: string
  error?: string
  message?: string
  branch?: string
  expectedBranch?: string
  head?: string
  describe?: string
  sourceVersion?: string | null
  runningVersion?: string | null
  needsRestart?: boolean
  /** The official latest: the tag on the upstream/<branch> tip, falling back to the npm registry latest. */
  latestVersion?: string | null
  /** The npm registry `latest` dist-tag (fallback signal; the git upstream is authoritative). */
  npmVersion?: string | null
  /** The tag on the upstream/<branch> tip, read from the local ref (may be stale). */
  upstreamVersion?: string | null
  /** Commits in HEAD..upstream/<branch> from the local ref (may be stale). */
  upstreamAhead?: number | null
  /** True only when the upstream ref was refreshed by a successful fetch in this session. */
  upstreamFresh?: boolean
  /** An update is available: new upstream commits exist (commit-based when the ref is known, npm comparison otherwise). */
  outdated?: boolean
  /** Authoritatively up to date: the ref is fresh with no new upstream commits (npm comparison when the ref is unknown). */
  upToDate?: boolean
  unknownVersions?: boolean
  dirty?: string[]
  untracked?: string[]
  treeClean?: boolean
  upstreamRemotePresent?: boolean
  lastCheckedAt?: number | null
  checkError?: string | null
  /** Soft note when the version check succeeded but the upstream git fetch failed. */
  fetchNote?: string | null
  lastUpdateResult?: OperationResult | null
  /** Result of the last one-click commit+push (working-tree sync to the fork). */
  lastCommitPushResult?: OperationResult | null
  operation?: Operation | null
}

interface Operation {
  running: boolean
  step: string
  log: string[]
  startedAt: number
  finishedAt?: number
  result?: OperationResult
}

interface OperationResult {
  ok: boolean
  from?: string
  to?: string
  headBefore?: string
  headAfter?: string
  versionBefore?: string | null
  versionAfter?: string | null
  upToDate?: boolean
  conflict?: boolean
  conflictedFiles?: string[]
  message?: string
  install?: { code: number | null; ok: boolean }
  /** Commit+push specifics. */
  branch?: string
  /** Committed locally but the push to the fork failed. */
  partial?: boolean
  /** Number of working-tree changes staged/committed. */
  committedFiles?: number
}

/** The parts of `git describe` we surface. */
function describeParts(describe: string): { clean: string; version: string | null } {
  const clean = describe.replace(/^dsh-v/i, '')
  const dirty = clean.endsWith('-dirty')
  const body = dirty ? clean.slice(0, -'-dirty'.length) : clean
  // `tag-N-g<hash>` means N commits past the tag; the tag is still the
  // version this source is based on.
  const match = /^(.*?)(?:-([0-9]+)-g[0-9a-f]+)?$/i.exec(body)
  const version = match?.[1] !== undefined && match[1].length > 0 ? match[1] : null
  return { clean, version }
}

/**
 * Read the local upstream/<branch> ref state — offline (no network): the tip
 * tag and how many commits HEAD is behind. Resolves to null when the ref
 * does not exist (remote missing or never fetched); the verdict then falls
 * back to the npm registry.
 */
async function readUpstreamRef(
  path: string,
  remote: string,
  branch: string,
): Promise<{ version: string | null; ahead: number | null } | null> {
  const safe = async (args: string[]): Promise<string | null> => {
    try {
      return await execGit(path, args)
    } catch {
      return null
    }
  }
  const ref = `${remote}/${branch}`
  const [describe, aheadCount] = await Promise.all([
    safe(['describe', '--tags', ref]),
    safe(['rev-list', '--count', `HEAD..${ref}`]),
  ])
  if (describe === null && aheadCount === null) return null
  let ahead: number | null = null
  if (aheadCount !== null) {
    const parsed = Number.parseInt(aheadCount, 10)
    ahead = Number.isNaN(parsed) ? null : parsed
  }
  return {
    version: describe === null ? null : describeParts(describe).version,
    ahead,
  }
}

async function collectStatus(env: Env): Promise<StatusData> {
  const { install } = env
  const base: StatusData = { ok: true, resolved: install.resolved }
  if (!install.resolved || install.path === undefined) {
    base.message = 'installPath not resolved — set the dsh-updater installPath config'
    return base
  }
  const path = install.path
  base.installPath = path
  base.expectedBranch = env.patchesBranch

  // Repo sanity. Each probe is independent so one failure does not hide the rest.
  let isRepo = false
  try {
    await execGit(path, ['rev-parse', '--is-inside-work-tree'])
    isRepo = true
  } catch {
    base.error = 'not-a-git-repo'
  }
  if (!isRepo) return base

  const safe = async (args: string[], timeoutMs?: number): Promise<string | null> => {
    try {
      return await execGit(path, args, timeoutMs)
    } catch {
      return null
    }
  }

  const [branch, head, describe, porcelain, upstreamUrl] = await Promise.all([
    safe(['rev-parse', '--abbrev-ref', 'HEAD']),
    safe(['rev-parse', '--short', 'HEAD']),
    safe(['describe', '--tags', '--always', '--dirty']),
    safe(['status', '--porcelain']),
    safe(['remote', 'get-url', env.upstreamRemote]),
  ])

  if (branch !== null) base.branch = branch
  if (head !== null) base.head = head
  if (describe !== null) base.describe = describe.replace(/^dsh-v/i, '')
  base.upstreamRemotePresent = upstreamUrl !== null && upstreamUrl.length > 0

  const dirty: string[] = []
  const untracked: string[] = []
  for (const line of (porcelain ?? '').split('\n')) {
    if (line.length === 0) continue
    const code = line.slice(0, 2)
    const file = line.slice(3)
    if (code === '??') untracked.push(file)
    else dirty.push(file)
  }
  base.dirty = dirty
  base.untracked = untracked
  base.treeClean = dirty.length === 0 && untracked.length === 0

  const describeInfo = describe === null ? undefined : describeParts(describe)
  base.sourceVersion = describeInfo?.version ?? readPackageJsonVersion(path)
  base.runningVersion = env.runningVersion
  base.needsRestart = env.runningVersion !== null
    && base.sourceVersion !== null
    && env.runningVersion !== base.sourceVersion

  // Official-latest verdict. The update rebases onto the upstream remote
  // tip, so that ref is authoritative; the npm registry is a fallback for
  // installs without a usable upstream ref (the npm release may lag behind
  // the git repo — a npm-primary verdict would hide real updates).
  const upstreamRef = await readUpstreamRef(path, env.upstreamRemote, env.upstreamBranch)
  base.npmVersion = env.latestVersion
  base.upstreamFresh = env.upstreamFresh
  if (upstreamRef !== null) {
    base.upstreamVersion = upstreamRef.version
    base.upstreamAhead = upstreamRef.ahead
    if (upstreamRef.ahead === null) {
      base.outdated = false
      base.upToDate = false
      base.unknownVersions = true
    } else {
      base.outdated = upstreamRef.ahead > 0
      base.upToDate = upstreamRef.ahead === 0 && env.upstreamFresh
      base.unknownVersions = false
    }
    base.latestVersion = upstreamRef.version ?? env.latestVersion
  } else {
    const latestParsed = env.latestVersion === null ? null : parseVersion(env.latestVersion)
    const sourceParsed = base.sourceVersion === null ? null : parseVersion(base.sourceVersion)
    if (latestParsed !== null && sourceParsed !== null) {
      const cmp = compareVersions(sourceParsed, latestParsed)
      base.outdated = cmp < 0
      base.upToDate = cmp >= 0
      base.unknownVersions = false
    } else {
      base.outdated = false
      base.upToDate = false
      base.unknownVersions = true
    }
    base.latestVersion = env.latestVersion
  }
  base.lastCheckedAt = env.lastCheckedAt
  base.checkError = env.checkError
  base.fetchNote = env.fetchNote
  base.lastUpdateResult = env.lastUpdateResult
  base.lastCommitPushResult = env.lastCommitPushResult
  base.operation = env.operation
  base.lastUpdateResult = env.lastUpdateResult
  return base
}

/* ------------------------------------------------------------------------- *
 * Update preview (dry-run).                                                  *
 * ------------------------------------------------------------------------- */

/** What an update WOULD do, computed without mutating anything (fetch refs
 * are refreshed — the same side effect as a version check). */
interface PreviewResult {
  ok: boolean
  resolved: boolean
  installPath?: string
  message?: string
  branch?: string
  expectedBranch?: string
  treeClean?: boolean
  dirty?: string[]
  untracked?: string[]
  sourceVersion?: string | null
  targetVersion?: string | null
  headBefore?: string
  headAfter?: string
  upToDate?: boolean
  /** New upstream commits (HEAD..target), newest first, capped. */
  newCommits?: string[]
  /** Local commits that would be replayed (target..HEAD), i.e. your patches. */
  localCommits?: string[]
  fetchNote?: string | null
}

const MAX_PREVIEW_COMMITS = 40

async function runPreview(env: Env): Promise<PreviewResult> {
  const { install } = env
  const base: PreviewResult = { ok: false, resolved: install.resolved }
  if (!install.resolved || install.path === undefined) {
    base.message = 'installPath not resolved — set the dsh-updater installPath config'
    return base
  }
  const path = install.path
  base.installPath = path
  base.expectedBranch = env.patchesBranch

  const safe = async (args: string[], timeoutMs?: number): Promise<string | null> => {
    try {
      return await execGit(path, args, timeoutMs)
    } catch {
      return null
    }
  }

  try {
    await execGit(path, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    base.message = 'not a git repository'
    return base
  }
  base.ok = true

  const branch = await safe(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch !== null) base.branch = branch
  const porcelain = await safe(['status', '--porcelain'])
  const dirty: string[] = []
  const untracked: string[] = []
  for (const line of (porcelain ?? '').split('\n')) {
    if (line.length === 0) continue
    if (line.startsWith('??')) untracked.push(line.slice(3))
    else dirty.push(line.slice(3))
  }
  base.dirty = dirty
  base.untracked = untracked
  base.treeClean = dirty.length === 0 && untracked.length === 0

  // Refresh the upstream refs (best-effort) so the comparison is current.
  let fetchOk = false
  try {
    await execGit(path, ['fetch', '--tags', env.upstreamRemote, env.upstreamBranch], 90_000)
    fetchOk = true
  } catch (error) {
    base.fetchNote = `git fetch: ${error instanceof Error ? error.message : String(error)}`
  }

  const describeInfo = await safe(['describe', '--tags', '--always', '--dirty'])
  base.sourceVersion = describeInfo === null ? null : describeParts(describeInfo).version

  const headBefore = await safe(['rev-parse', '--short', 'HEAD'])
  if (headBefore !== null) base.headBefore = headBefore

  if (fetchOk) {
    const target = await safe(['rev-parse', `${env.upstreamRemote}/${env.upstreamBranch}`])
    if (target !== null) {
      base.headAfter = target.slice(0, 12)
      // Target version: nearest tag on the upstream tip, else its package.json.
      const targetDescribe = await safe(['describe', '--tags', '--always', env.upstreamRemote + '/' + env.upstreamBranch])
      if (targetDescribe !== null) base.targetVersion = describeParts(targetDescribe).version
      if (base.targetVersion === null) {
        try {
          const pkg = await execGit(path, ['show', `${env.upstreamRemote}/${env.upstreamBranch}:package.json`])
          const parsed = JSON.parse(pkg) as { version?: unknown }
          if (typeof parsed.version === 'string') base.targetVersion = parsed.version
        } catch { /* keep null */ }
      }
      const newCommits = await safe(['log', '--oneline', '-n', String(MAX_PREVIEW_COMMITS), `HEAD..${env.upstreamRemote}/${env.upstreamBranch}`])
      if (newCommits !== null && newCommits.length > 0) base.newCommits = newCommits.split('\n').filter(line => line.length > 0)
      const localCommits = await safe(['log', '--oneline', '-n', '20', `${env.upstreamRemote}/${env.upstreamBranch}..HEAD`])
      if (localCommits !== null && localCommits.length > 0) base.localCommits = localCommits.split('\n').filter(line => line.length > 0)
      // "Up to date" means there is nothing NEW upstream to pull — our own
      // commits sitting on top of the same upstream tip are not an update.
      base.upToDate = (base.newCommits ?? []).length === 0
    }
  }
  return base
}

/* ------------------------------------------------------------------------- *
 * Update execution.                                                          *
 * ------------------------------------------------------------------------- */

interface Env {
  install: { path: string | undefined; resolved: boolean }
  runningVersion: string | null
  upstreamRemote: string
  upstreamBranch: string
  patchesBranch: string
  registryBase: string
  registryPackage: string
  /** npm registry `latest` dist-tag (fallback signal; refreshed by /check). */
  latestVersion: string | null
  /** True only when the last upstream fetch in this session succeeded. */
  upstreamFresh: boolean
  lastCheckedAt: number | null
  checkError: string | null
  fetchNote: string | null
  lastUpdateResult: OperationResult | null
  lastCommitPushResult: OperationResult | null
  operation: Operation | null
}

function logLine(env: Env, line: string): void {
  const op = env.operation
  if (op === null) return
  op.log.push(line)
  if (op.log.length > 400) op.log.splice(0, op.log.length - 400)
}

async function runUpdate(env: Env, withInstall: boolean): Promise<OperationResult> {
  const { install } = env
  const path = install.path
  const result: OperationResult = { ok: false }
  if (!install.resolved || path === undefined) {
    result.message = 'installPath not resolved — set the dsh-updater installPath config'
    return result
  }

  // 0) Preflight: repo, branch, clean tree, upstream remote. Any failure
  // refuses the update — an automatic updater never stashes or discards work.
  logLine(env, `preflight: ${path}`)
  let branch: string
  try {
    branch = await execGit(path, ['rev-parse', '--abbrev-ref', 'HEAD'])
  } catch {
    result.message = 'not a git repository'
    return result
  }
  if (branch !== env.patchesBranch) {
    result.message = `refusing to update on branch "${branch}" — expected "${env.patchesBranch}" (the branch that carries your local patches)`
    return result
  }
  let porcelain: string
  try {
    porcelain = await execGit(path, ['status', '--porcelain'])
  } catch {
    result.message = 'cannot read working-tree state'
    return result
  }
  const changes = porcelain.split('\n').filter(line => line.length > 0)
  if (changes.length > 0) {
    result.message = `working tree has uncommitted changes (${changes.length}): ${changes.slice(0, 5).join('; ')}${changes.length > 5 ? '…' : ''} — commit or stash them first`
    return result
  }
  try {
    await execGit(path, ['remote', 'get-url', env.upstreamRemote])
  } catch {
    result.message = `missing "${env.upstreamRemote}" remote — add the official repo as ${env.upstreamRemote}`
    return result
  }

  // 1) Refresh the upstream remote-tracking refs + tags.
  env.operation = { running: true, step: 'git fetch', log: [], startedAt: Date.now() }
  logLine(env, `$ git fetch --tags ${env.upstreamRemote} ${env.upstreamBranch}`)
  let fetchCode: number | null = null
  await execGitLogged(env, path, ['fetch', '--tags', env.upstreamRemote, env.upstreamBranch], 180_000)
    .then(code => { fetchCode = code })
    .catch(() => { fetchCode = 1 })
  env.upstreamFresh = fetchCode === 0
  if (fetchCode !== 0) {
    env.operation.running = false
    env.operation.finishedAt = Date.now()
    env.operation.result = { ok: false, message: `git fetch failed (code ${fetchCode}) — network or remote error, nothing was changed` }
    env.lastUpdateResult = env.operation.result
    return env.lastUpdateResult
  }

  // 2) Compare heads.
  let headBefore = ''
  let target = ''
  try {
    headBefore = await execGit(path, ['rev-parse', 'HEAD'])
    target = await execGit(path, ['rev-parse', `${env.upstreamRemote}/${env.upstreamBranch}`])
  } catch {
    env.operation.running = false
    env.operation.finishedAt = Date.now()
    const failure: OperationResult = { ok: false, message: 'cannot resolve HEAD/upstream — run a check first' }
    env.lastUpdateResult = failure
    return failure
  }
  result.headBefore = headBefore.slice(0, 12)
  result.from = result.headBefore
  let describeBefore = ''
  try {
    describeBefore = await execGit(path, ['describe', '--tags', '--always', '--dirty'])
  } catch {
    describeBefore = ''
  }
  result.versionBefore = describeBefore === '' ? null : describeParts(describeBefore).version
  if (headBefore === target) {
    logLine(env, 'already up to date')
    env.operation.running = false
    env.operation.finishedAt = Date.now()
    const done: OperationResult = {
      ok: true,
      upToDate: true,
      from: result.headBefore,
      to: result.headBefore,
      versionBefore: result.versionBefore,
      versionAfter: result.versionBefore,
    }
    env.operation.result = done
    env.lastUpdateResult = done
    return done
  }

  // 3) Rebase the patches branch onto the official latest.
  env.operation.step = 'git rebase'
  logLine(env, `$ git rebase ${env.upstreamRemote}/${env.upstreamBranch}`)
  const rebaseCode = await execGitLogged(env, path, ['rebase', `${env.upstreamRemote}/${env.upstreamBranch}`], 300_000)
    .catch(() => 1)
  if (rebaseCode !== 0) {
    // Conflict or other failure: the repo now sits mid-rebase. Report the
    // unmerged files and STOP — the user resolves (or `git rebase --abort`).
    const conflicted = (await safeGit(path, ['diff', '--name-only', '--diff-filter=U']).catch(() => ''))
      .split('\n').filter(line => line.length > 0)
    env.operation.running = false
    env.operation.finishedAt = Date.now()
    const failure: OperationResult = {
      ok: false,
      conflict: true,
      conflictedFiles: conflicted,
      message: conflicted.length > 0
        ? `rebase stopped on conflicts in ${conflicted.length} file(s) — resolve them, then continue the rebase or run 'git rebase --abort'`
        : `git rebase failed (code ${rebaseCode}) — see the log`,
    }
    env.operation.result = failure
    env.lastUpdateResult = failure
    return failure
  }

  // 4) Report the new head + version.
  let headAfter = ''
  let describeAfter = ''
  try {
    headAfter = (await execGit(path, ['rev-parse', 'HEAD'])).slice(0, 12)
    describeAfter = await execGit(path, ['describe', '--tags', '--always', '--dirty'])
  } catch {
    headAfter = '?'
    describeAfter = '?'
  }
  const versionAfter = describeAfter === '?' ? null : describeParts(describeAfter).version
  logLine(env, `updated ${result.headBefore} → ${headAfter} (${versionAfter ?? describeAfter})`)

  // 5) Optional dependency reinstall (frozen lockfile — never rewrites the
  // committed lockfile, keeps the tree clean).
  let installResult: OperationResult['install'] | undefined = undefined
  if (withInstall) {
    env.operation.step = 'pnpm install'
    logLine(env, '$ pnpm install --frozen-lockfile')
    const pnpmCode = await runPnpmInstall(env, path)
    installResult = { code: pnpmCode, ok: pnpmCode === 0 }
    logLine(env, pnpmCode === 0 ? 'dependencies installed' : `pnpm install finished with code ${pnpmCode}`)
  }

  const done: OperationResult = {
    ok: true,
    from: result.headBefore,
    to: headAfter,
    headBefore: result.headBefore,
    headAfter,
    versionBefore: result.versionBefore,
    versionAfter,
    ...(installResult !== undefined ? { install: installResult } : {}),
  }
  env.operation.running = false
  env.operation.finishedAt = Date.now()
  env.operation.result = done
  env.lastUpdateResult = done
  return done
}

/**
 * One-click working-tree sync: stage everything, commit on the current
 * branch, then push to `origin` (the user's fork). Refuses when the tree is
 * clean (the UI only enables the button then anyway). Bypasses git hooks
 * (`--no-verify`) so a WIP backup is fast and never blocked by lint/
 * typecheck gates. A commit that fails to push is reported as `partial` —
 * your work is committed locally, only the network hop failed.
 */
async function runCommitPush(env: Env): Promise<OperationResult> {
  const { install } = env
  const path = install.path
  const result: OperationResult = { ok: false }
  // Finalize the shared operation + remember the result for /status.
  const finish = (res: OperationResult): OperationResult => {
    if (env.operation !== null) {
      env.operation.running = false
      env.operation.finishedAt = Date.now()
      env.operation.result = res
    }
    env.lastCommitPushResult = res
    return res
  }
  if (!install.resolved || path === undefined) {
    return finish({ ok: false, message: 'installPath not resolved — set the dsh-updater installPath config' })
  }
  env.operation = { running: true, step: 'preflight', log: [], startedAt: Date.now() }
  logLine(env, `preflight: ${path}`)

  let branch: string
  try {
    branch = await execGit(path, ['rev-parse', '--abbrev-ref', 'HEAD'])
  } catch {
    return finish({ ok: false, message: 'not a git repository' })
  }
  result.branch = branch
  let porcelain: string
  try {
    porcelain = await execGit(path, ['status', '--porcelain'])
  } catch {
    return finish({ ok: false, message: 'cannot read working-tree state' })
  }
  const changes = porcelain.split('\n').filter(line => line.length > 0)
  if (changes.length === 0) {
    return finish({ ok: false, branch, message: 'working tree is clean — nothing to commit or push' })
  }
  result.committedFiles = changes.length

  // 1) Stage + commit everything.
  env.operation.step = 'git add'
  logLine(env, `$ git add -A  (${changes.length} change(s))`)
  const addCode = await execGitLogged(env, path, ['add', '-A'], 30_000).catch(() => 1)
  if (addCode !== 0) {
    return finish({ ok: false, branch, committedFiles: changes.length, message: `git add failed (code ${addCode})` })
  }
  env.operation.step = 'git commit'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const message = `local: working tree sync (dsh-updater ${stamp})`
  logLine(env, `$ git commit --no-verify -m "${message}"`)
  const commitCode = await execGitLogged(env, path, ['commit', '--no-verify', '-m', message], 60_000).catch(() => 1)
  if (commitCode !== 0) {
    return finish({ ok: false, branch, committedFiles: changes.length, message: `git commit failed (code ${commitCode})` })
  }
  let headAfter = '?'
  try {
    headAfter = (await execGit(path, ['rev-parse', '--short', 'HEAD'])).slice(0, 12)
  } catch { /* keep '?' */ }
  result.to = headAfter
  logLine(env, `committed ${changes.length} change(s) → ${headAfter} on ${branch}`)

  // 2) Push to the fork (origin).
  env.operation.step = 'git push'
  logLine(env, `$ git push --no-verify origin ${branch}`)
  const pushCode = await execGitLogged(env, path, ['push', '--no-verify', 'origin', branch], 180_000).catch(() => 1)
  if (pushCode !== 0) {
    return finish({
      ok: false,
      partial: true,
      branch,
      to: headAfter,
      committedFiles: changes.length,
      message: `committed locally (${headAfter}), but push to origin/${branch} failed (code ${pushCode}) — retry the button or run 'git push'`,
    })
  }
  return finish({
    ok: true,
    branch,
    to: headAfter,
    committedFiles: changes.length,
    message: `committed ${changes.length} change(s) and pushed to origin/${branch} (${headAfter})`,
  })
}

/** Run a git command streaming output lines into the operation log. */
function execGitLogged(env: Env, path: string, args: string[], timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    execFile('git', ['-C', path, ...args], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const out = `${stdout}${stdout.length > 0 && stderr.length > 0 ? '\n' : ''}${stderr}`.trim()
      if (out.length > 0) logLine(env, out)
      resolve(exitCode(error))
    })
  })
}

async function safeGit(path: string, args: string[]): Promise<string> {
  return await execGit(path, args)
}

/** Run `pnpm install --frozen-lockfile` in the checkout. On Windows the pnpm
 * entry is a batch file, so the command goes through cmd.exe. */
function runPnpmInstall(env: Env, path: string): Promise<number> {
  return new Promise((resolve) => {
    const args = 'install --frozen-lockfile --prefer-offline'
    const child = execFile(
      process.platform === 'win32' ? 'cmd.exe' : 'pnpm',
      process.platform === 'win32'
        ? ['/d', '/s', '/c', `pnpm ${args}`]
        : args.split(' '),
      { cwd: path, timeout: 600_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const out = `${stdout}${stdout.length > 0 && stderr.length > 0 ? '\n' : ''}${stderr}`.trim()
        if (out.length > 0) logLine(env, out)
        resolve(exitCode(error))
      },
    )
    // Stream pnpm's progress incrementally into the operation log.
    child.stdout?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim().length > 0) logLine(env, line.replace(/\r$/, ''))
      }
    })
  })
}

/* ------------------------------------------------------------------------- *
 * HTTP surface.                                                              *
 * ------------------------------------------------------------------------- */

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      data += chunk
      if (data.length > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/** A one-update-at-a-time guard keyed by a unique token. */
function makeGate(): { tryAcquire: () => boolean; release: () => void } {
  let held = false
  return {
    tryAcquire: () => {
      if (held) return false
      held = true
      return true
    },
    release: () => { held = false },
  }
}

export function apply(ctx: Context, config: Config): void {
  const install = {
    path: resolveInstallPath(config.installPath),
    resolved: true,
  }
  install.resolved = install.path !== undefined
  const env: Env = {
    install,
    runningVersion: install.path !== undefined ? readPackageJsonVersion(install.path) : null,
    upstreamRemote: config.upstreamRemote ?? 'upstream',
    upstreamBranch: config.upstreamBranch ?? 'master',
    patchesBranch: config.patchesBranch ?? 'local-patches',
    registryBase: config.registryBase ?? 'https://registry.npmjs.org',
    registryPackage: config.registryPackage ?? '@deepseek-ai/dsh',
    latestVersion: null,
    upstreamFresh: false,
    lastCheckedAt: null,
    checkError: null,
    fetchNote: null,
    lastUpdateResult: null,
    lastCommitPushResult: null,
    operation: null,
  }
  const gate = makeGate()

  async function handleRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://dsh')
      const path = url.pathname.replace(/\/+$/, '') || ROUTE_PREFIX
      const method = req.method ?? 'GET'

      if (method === 'GET' && path === ROUTE_PREFIX) {
        sendJson(res, 200, { ok: true, name, operations: ['status', 'check', 'preview', 'update', 'commit-push'] })
        return
      }
      if (method === 'GET' && path === `${ROUTE_PREFIX}/status`) {
        sendJson(res, 200, await collectStatus(env))
        return
      }
      if (method === 'GET' && path === `${ROUTE_PREFIX}/info`) {
        sendJson(res, 200, {
          ok: true,
          name,
          installPath: install.path ?? null,
          installResolved: install.resolved,
          upstreamRemote: env.upstreamRemote,
          upstreamBranch: env.upstreamBranch,
          patchesBranch: env.patchesBranch,
          registryPackage: env.registryPackage,
        })
        return
      }
      if (method === 'POST' && path === `${ROUTE_PREFIX}/check`) {
        // Refresh both version signals. The upstream git fetch is
        // authoritative (the update rebases onto it); the npm registry
        // lookup is the fallback for installs without a usable upstream ref.
        // A failed git fetch does not clear the known ref — it marks the
        // verdict unverified (upstreamFresh=false) and records a note.
        env.lastCheckedAt = Date.now()
        env.checkError = null
        env.fetchNote = null
        if (install.path !== undefined) {
          try {
            await execGit(install.path, ['fetch', '--tags', env.upstreamRemote, env.upstreamBranch], 90_000)
            env.upstreamFresh = true
          } catch (error) {
            env.upstreamFresh = false
            env.fetchNote = `git fetch: ${error instanceof Error ? error.message : String(error)}`
          }
        }
        const latest = await fetchLatestVersion(env.registryBase, env.registryPackage)
        env.latestVersion = latest.version
        env.checkError = latest.error
        sendJson(res, 200, await collectStatus(env))
        return
      }
      if (method === 'POST' && path === `${ROUTE_PREFIX}/preview`) {
        // Dry-run: refresh upstream refs and report exactly what an update
        // would do (from→to versions, new upstream commits, the local commits
        // that would be replayed, and the working-tree guard state) WITHOUT
        // rebasing anything. The browser shows this before the real update.
        sendJson(res, 200, await runPreview(env))
        return
      }
      if (method === 'POST' && path === `${ROUTE_PREFIX}/update`) {
        let payload: { withInstall?: unknown } | null = null
        try {
          payload = JSON.parse(await readBody(req)) as { withInstall?: unknown }
        } catch {
          sendJson(res, 400, { ok: false, error: 'bad-json' })
          return
        }
        if (env.operation?.running === true) {
          sendJson(res, 409, { ok: false, error: 'busy', message: 'an update is already running' })
          return
        }
        if (!gate.tryAcquire()) {
          sendJson(res, 409, { ok: false, error: 'busy' })
          return
        }
        const withInstall = payload?.withInstall === true
        // Fire-and-forget: the client polls GET /status for the operation
        // log and the final result, so long fetch/rebase/install steps stream
        // live progress instead of holding the HTTP response open.
        env.operation = { running: true, step: 'starting', log: [], startedAt: Date.now() }
        sendJson(res, 200, { ok: true, started: true })
        void runUpdate(env, withInstall)
          .catch((error: unknown) => {
            ctx.logger.warn(`dsh-updater: ${String(error)}`)
            const failure: OperationResult = { ok: false, message: String(error) }
            env.lastUpdateResult = failure
            env.operation = env.operation ?? { running: false, step: 'failed', log: [], startedAt: Date.now() }
            env.operation.running = false
            env.operation.finishedAt = Date.now()
            env.operation.result = failure
          })
          .finally(() => { gate.release() })
        return
      }
      if (method === 'POST' && path === `${ROUTE_PREFIX}/commit-push`) {
        // One-click working-tree sync to the fork: stage + commit + push.
        // The button is only enabled when /status reports a non-clean tree.
        if (env.operation?.running === true) {
          sendJson(res, 409, { ok: false, error: 'busy', message: 'an operation is already running' })
          return
        }
        if (!gate.tryAcquire()) {
          sendJson(res, 409, { ok: false, error: 'busy' })
          return
        }
        env.operation = { running: true, step: 'starting', log: [], startedAt: Date.now() }
        sendJson(res, 200, { ok: true, started: true })
        void runCommitPush(env)
          .catch((error: unknown) => {
            ctx.logger.warn(`dsh-updater: ${String(error)}`)
            const failure: OperationResult = { ok: false, message: String(error) }
            env.lastCommitPushResult = failure
            if (env.operation !== null) {
              env.operation.running = false
              env.operation.finishedAt = Date.now()
              env.operation.result = failure
            }
          })
          .finally(() => { gate.release() })
        return
      }
      sendJson(res, 404, { ok: false, error: 'not-found' })
    } catch (error) {
      ctx.logger.warn(`dsh-updater: ${String(error)}`)
      sendJson(res, 500, { ok: false, error: 'internal', message: String(error) })
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => handleRoute(req, res),
  }), 'dsh-updater: http surface')
}
