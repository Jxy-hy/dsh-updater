/**
 * dsh-updater controller: version status, dry-run preview, the update action,
 * and the auto-check + toast notification.
 *
 * The host stays the single fact source. The page and the sidebar badge read
 * a shared snapshot store; `load`/`check`/`preview`/`runUpdate` talk to the
 * plugin's `/__dsh-update` HTTP surface with same-origin fetch — the core RPC
 * map has no version/update methods, so nothing is added there.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Wire shape of the host `/status` response (the host's StatusData). */
export interface VersionStatus {
  ok?: boolean
  resolved?: boolean
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
  latestVersion?: string | null
  outdated?: boolean
  upToDate?: boolean
  unknownVersions?: boolean
  dirty?: string[]
  untracked?: string[]
  treeClean?: boolean
  upstreamRemotePresent?: boolean
  lastCheckedAt?: number | null
  checkError?: string | null
  fetchNote?: string | null
  lastUpdateResult?: OperationResult | null
  operation?: OperationWire | null
}

/** Wire shape of the host operation-in-progress. */
export interface OperationWire {
  running: boolean
  step: string
  log: string[]
  startedAt: number
  finishedAt?: number
  result?: OperationResult
}

/** Wire shape of a finished update result. */
export interface OperationResult {
  ok: boolean
  upToDate?: boolean
  conflict?: boolean
  conflictedFiles?: string[]
  from?: string
  to?: string
  versionBefore?: string | null
  versionAfter?: string | null
  message?: string
  install?: { code: number | null; ok: boolean }
}

/** Wire shape of the host `/preview` response (dry-run). */
export interface PreviewResult {
  ok?: boolean
  resolved?: boolean
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
  newCommits?: string[]
  localCommits?: string[]
  fetchNote?: string | null
}

/** How stale a version check may be before an automatic re-check. */
const AUTO_CHECK_STALE_MS = 12 * 60 * 60 * 1000
/** Periodic automatic re-check interval. */
const AUTO_CHECK_INTERVAL_MS = 30 * 60 * 1000

/** Page snapshot. */
export interface UpdateState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text; a per-action failure stays in updateError. */
  error: string | null
  /** The latest host status (versions, branch, tree, operation). */
  version: VersionStatus | null
  /** Whether a manual version check is in flight. */
  checking: boolean
  /** Whether a dry-run preview is being computed. */
  previewing: boolean
  /** The last dry-run preview, shown in the confirm dialog. */
  preview: PreviewResult | null
  /** Whether the update operation is in flight. */
  updating: boolean
  /** The confirm dialog target: which update variant is pending. */
  pendingConfirm: { withInstall: boolean } | null
  /** The last update action failure. */
  updateError: string | null
  /** The last finished update result (from the host). */
  updateResult: OperationResult | null
  /** Live operation log lines streamed while an update runs. */
  updateLog: string[]
  /** A transient toast to show (auto-check found an update), or null. */
  toast: string | null
}

const INITIAL: UpdateState = {
  status: 'idle',
  error: null,
  version: null,
  checking: false,
  previewing: false,
  preview: null,
  updating: false,
  pendingConfirm: null,
  updateError: null,
  updateResult: null,
  updateLog: [],
  toast: null,
}

const ROUTE = '/__dsh-update'

export class UpdatesController {
  readonly hooks: SnapshotStore<UpdateState>
  /** Guards so the auto-check never fires more than once per run. */
  private autoChecked = false
  /** Whether the last completed check reported outdated (toast once). */
  private wasOutdated = false

  constructor() {
    this.hooks = createSnapshotStore(INITIAL)
    // Periodic auto re-check: cheap `/status` reads; a full `/check` only when
    // the cached result is stale. Mirrors the per-mount auto-check.
    setInterval(() => { void this.maybeAutoCheck() }, AUTO_CHECK_INTERVAL_MS)
  }

  private async fetchHost<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(path, body === undefined
      ? undefined
      : {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    return await response.json() as T
  }

  private patch(partial: Partial<UpdateState>): void {
    this.hooks.set({ ...this.hooks.getSnapshot(), ...partial })
  }

  /** Read the current host status into the store, then maybe auto-check. */
  async load(): Promise<void> {
    const snapshot = this.hooks.getSnapshot()
    if (snapshot.status === 'loading') return
    this.patch({ status: 'loading', error: null })
    try {
      const status = await this.fetchHost<VersionStatus>(`${ROUTE}/status`)
      this.patch({ status: 'ready', version: status, error: status.message ?? null })
      await this.maybeAutoCheck()
    } catch (error) {
      this.patch({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Run one network check when the cached result is stale and no check is
   * already in flight. Never spams: the callers guard by staleness and this
   * method by `autoChecked` + `checking`.
   */
  private async maybeAutoCheck(): Promise<void> {
    if (this.autoChecked) return
    const status = this.hooks.getSnapshot().version
    if (status === null || status.lastCheckedAt === null || status.lastCheckedAt === undefined) return
    if (Date.now() - status.lastCheckedAt <= AUTO_CHECK_STALE_MS) return
    this.autoChecked = true
    await this.check()
  }

  /** Force a fresh version check (npm latest + upstream fetch) on the host. */
  async check(): Promise<void> {
    const snapshot = this.hooks.getSnapshot()
    if (snapshot.checking) return
    this.patch({ checking: true, updateError: null })
    try {
      const status = await this.fetchHost<VersionStatus>(`${ROUTE}/check`, {})
      const outdated = status.outdated === true
      this.patch({
        status: 'ready',
        checking: false,
        version: status,
        error: status.message ?? null,
      })
      // Toast on a newly-detected update only (not on every re-check).
      if (outdated && !this.wasOutdated && status.latestVersion !== null && status.latestVersion !== undefined) {
        this.patch({ toast: status.latestVersion })
      }
      this.wasOutdated = outdated
    } catch (error) {
      this.patch({
        checking: false,
        updateError: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Dismiss the toast. */
  dismissToast(): void {
    this.patch({ toast: null })
  }

  /** Compute the dry-run preview and show the confirm dialog. */
  async confirmUpdate(withInstall: boolean | null): Promise<void> {
    if (withInstall === null) {
      this.patch({ pendingConfirm: null, preview: null })
      return
    }
    const snapshot = this.hooks.getSnapshot()
    if (snapshot.previewing || snapshot.updating) return
    this.patch({ previewing: true, updateError: null })
    try {
      const preview = await this.fetchHost<PreviewResult>(`${ROUTE}/preview`, {})
      this.patch({ previewing: false, preview, pendingConfirm: { withInstall } })
    } catch (error) {
      this.patch({
        previewing: false,
        updateError: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Run the update. The host responds immediately and streams progress in
   * `operation`; this polls `/status` until the operation settles, then
   * refreshes once more so the page reflects the new state.
   */
  async runUpdate(): Promise<void> {
    const snapshot = this.hooks.getSnapshot()
    const confirm = snapshot.pendingConfirm
    if (confirm === null || snapshot.updating) return
    this.patch({ updating: true, pendingConfirm: null, preview: null, updateError: null, updateResult: null, updateLog: [] })
    try {
      const started = await this.fetchHost<{ ok: boolean; started?: boolean; error?: string }>(
        `${ROUTE}/update`, { withInstall: confirm.withInstall })
      if (!started.ok) throw new Error(started.error ?? 'update not started')
      // Poll until the host operation finishes.
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, 1200))
        const status = await this.fetchHost<VersionStatus>(`${ROUTE}/status`)
        this.patch({
          version: status,
          updateLog: status.operation?.log ?? [],
        })
        if (!status.operation?.running) {
          this.patch({
            updating: false,
            updateResult: status.lastUpdateResult ?? null,
            updateLog: status.operation?.log ?? [],
          })
          break
        }
      }
    } catch (error) {
      this.patch({
        updating: false,
        updateError: error instanceof Error ? error.message : String(error),
      })
    } finally {
      await this.load()
    }
  }
}
