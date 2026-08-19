/**
 * dsh-updater Settings section: version status (source / running / official
 * latest), the working-tree and branch guards, a dry-run preview inside the
 * confirm dialog (from→to versions + the commits that would be added/kept),
 * the check/update actions, a live operation log while an update runs, and a
 * toast when the auto-check finds an update. Everything reads from the shared
 * UpdatesController snapshot; all facts come from the host `/__dsh-update`
 * surface.
 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import {
  Button, IconRefreshOutline16, Modal, Toast, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { UpdateState, OperationResult, PreviewResult } from './updates-store.ts'
import { t } from './locales.ts'
import css from './UpdateSection.module.css'

/** Registration-side business face for the Updates section. */
export interface UpdateSectionInjected {
  hooks: {
    /** Page snapshot bound by the renderer as useVersion. */
    version: SnapshotStore<UpdateState>
  }
  /** Read the host status; called once when the section first renders. */
  load: () => Promise<void>
  /** Force a fresh version check on the host. */
  check: () => Promise<void>
  /** Compute the dry-run preview and show the confirm dialog; null dismisses. */
  confirmUpdate: (withInstall: boolean | null) => void
  /** Run the confirmed update (polls the host until it settles). */
  runUpdate: () => Promise<void>
  /** Dismiss the auto-check toast. */
  dismissToast: () => void
  /** Open or close the one-click commit+push confirm dialog. */
  confirmCommitPush: (open: boolean) => void
  /** Run the confirmed commit+push (polls the host until it settles). */
  runCommitPush: () => Promise<void>
}

/** Full component props. */
export type UpdateSectionProps =
  PropsRuntime<'settings.section'>
  & InjectFace<UpdateSectionInjected>

/** Format an epoch-ms timestamp with the browser locale. */
function formatTime(epochMs: number | undefined | null): string {
  if (epochMs === undefined || epochMs === null || Number.isNaN(epochMs)) return t('neverChecked')
  return new Date(epochMs).toLocaleString()
}

/** Version cell with a fallback for unknown. */
function versionText(value: string | null | undefined): string {
  return value !== null && value !== undefined && value.length > 0 ? value : t('unknown')
}

/** Render the Update section content column. */
export function UpdateSection(props: UpdateSectionProps): ReactNode {
  const { useVersion, load, check, confirmUpdate, runUpdate, dismissToast, confirmCommitPush, runCommitPush } = props
  const state = useVersion(snapshot => snapshot)

  useEffect(() => {
    void load()
  }, [load])

  const v = state.version
  const resolved = v?.resolved ?? false
  const outdated = v?.outdated ?? false
  const unknownVersions = v?.unknownVersions ?? false
  const dirty = (v?.dirty ?? []).concat(v?.untracked ?? [])
  const onExpectedBranch = v?.branch === v?.expectedBranch
  // "Inconsistency detected" = the working tree differs from HEAD.
  const hasChanges = v?.treeClean === false
  const canUpdate = resolved
    && onExpectedBranch
    && dirty.length === 0
    && !state.updating

  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>

      {state.status === 'loading' && state.version === null && (
        <p className={css.status} aria-live="polite">{t('statusLoading')}</p>
      )}

      {state.status === 'error' && state.version === null && (
        <div className={css.status}>
          <p className={css.error} role="alert">{t('checkFailed', { error: state.error ?? '' })}</p>
        </div>
      )}

      {v !== null && !resolved && (
        <div className={css.warning} role="alert">
          {t('installNotResolved')}
        </div>
      )}

      {v !== null && resolved && (
        <div className={css.cards}>
          <div className={css.card}>
            <span className={css.cardLabel}>{t('currentVersion')}</span>
            <span className={css.cardValue}>{versionText(v.sourceVersion)}</span>
          </div>
          <div className={css.card}>
            <span className={css.cardLabel}>{t('runningVersion')}</span>
            <span className={css.cardValue}>{versionText(v.runningVersion)}</span>
          </div>
          <div className={css.card}>
            <span className={css.cardLabel}>{t('latestVersion')}</span>
            <span className={css.cardValue}>{versionText(v.latestVersion)}</span>
          </div>
        </div>
      )}

      {v !== null && resolved && (
        <p className={css.status}>
          {unknownVersions
            ? t('neverChecked')
            : outdated
              ? <span className={css.badgeOutdated}>{t('outdated')}</span>
              : <span className={css.badgeOk}>{t('upToDate')}</span>}
        </p>
      )}

      {v !== null && resolved && v.needsRestart === true && (
        <p className={css.restartHint} role="status">{t('needsRestart')}</p>
      )}

      {v !== null && resolved && (
        <div className={css.meta}>
          <span>{t('branch')}: <code className={css.code}>{v.branch ?? '—'}</code>
            {onExpectedBranch ? '' : `（${t('wrongBranch', { branch: v.expectedBranch ?? '' })}）`}
          </span>
          <span>{v.treeClean === true ? t('treeClean') : t('dirtyTree', { files: dirty.slice(0, 4).join(', ') })}</span>
          {v.upstreamRemotePresent === false && <span className={css.errorInline}>{t('noUpstream')}</span>}
          <span>{t('updatedAt', { time: formatTime(v.lastCheckedAt) })}</span>
        </div>
      )}

      {/* Real check failure (npm lookup failed). */}
      {v !== null && resolved && v.checkError !== null && v.checkError !== undefined && (
        <p className={css.error} role="alert">{t('checkFailed', { error: v.checkError })}</p>
      )}

      {/* Soft note: versions detected, only the upstream git fetch failed. */}
      {v !== null && resolved && v.fetchNote !== null && v.fetchNote !== undefined && (
        <p className={css.fetchNote} role="status">{t('fetchNote', { error: v.fetchNote })}</p>
      )}

      {/* Enhanced dirty-tree guidance: the update button is disabled and the
          host would refuse — tell the user exactly what to do. */}
      {v !== null && resolved && !onExpectedBranch && (
        <div className={css.warningBlock} role="alert">
          {t('wrongBranch', { branch: v.expectedBranch ?? '' })}
        </div>
      )}
      {v !== null && resolved && dirty.length > 0 && (
        <div className={css.warningBlock} role="alert">
          <p className={css.warningText}>{t('dirtyTreeHint')}</p>
          <ul className={css.fileList}>
            {dirty.slice(0, 6).map(file => <li key={file}><code className={css.code}>{file}</code></li>)}
          </ul>
        </div>
      )}

      {state.updateError !== null && (
        <p className={css.error} role="alert">{t('updateFailed', { error: state.updateError })}</p>
      )}

      {state.updateResult !== null && <UpdateResultNotice result={state.updateResult} />}

      {state.commitPushError !== null && (
        <p className={css.error} role="alert">{t('commitPushFailed', { error: state.commitPushError })}</p>
      )}
      {state.commitPushResult !== null && <CommitPushResultNotice result={state.commitPushResult} />}

      <div className={css.actions}>
        <Tooltip label={t('checkNow')} side="top" delayMs={400}>
          <Button
            variant="outline"
            disabled={state.checking}
            onClick={() => { void check() }}
          >
            <IconRefreshOutline16 size={16} />
            {state.checking ? t('checkingNow') : t('checkNow')}
          </Button>
        </Tooltip>
        <Tooltip label={t('update')} side="top" delayMs={400}>
          <Button
            variant="outline"
            disabled={!canUpdate || state.previewing}
            onClick={() => { confirmUpdate(false) }}
          >
            {state.previewing ? t('previewing') : t('update')}
          </Button>
        </Tooltip>
        <Tooltip label={t('updateWithInstall')} side="top" delayMs={400}>
          <Button
            variant="outline"
            disabled={!canUpdate || state.previewing}
            onClick={() => { confirmUpdate(true) }}
          >
            {state.previewing ? t('previewing') : t('updateWithInstall')}
          </Button>
        </Tooltip>
        <Tooltip label={t('commitPush')} side="top" delayMs={400}>
          <Button
            variant="outline"
            disabled={!hasChanges || state.committing}
            onClick={() => { confirmCommitPush(true) }}
          >
            {state.committing ? t('committing') : t('commitPush')}
          </Button>
        </Tooltip>
      </div>

      {!resolved && v !== null && (
        <p className={css.hint}>{t('footerNote')}</p>
      )}

      {state.updating && (
        <div className={css.logBox} aria-live="polite">
          <p className={css.logTitle}>{t('updateLog')} · {t('updating')}</p>
          <pre className={css.log}>{state.updateLog.length > 0 ? state.updateLog.join('\n') : t('noLog')}</pre>
        </div>
      )}

      <UpdateConfirmDialog
        state={state}
        onCancel={() => { confirmUpdate(null) }}
        onConfirm={() => { void runUpdate() }}
      />

      <CommitPushConfirmDialog
        state={state}
        onCancel={() => { confirmCommitPush(false) }}
        onConfirm={() => { void runCommitPush() }}
      />

      {state.toast !== null && (
        <Toast
          text={t('toastOutdated', { version: state.toast })}
          onDone={dismissToast}
        />
      )}
    </div>
  )
}

/** The confirm dialog with the dry-run preview baked in. */
function UpdateConfirmDialog({
  state, onCancel, onConfirm,
}: {
  state: UpdateState
  onCancel: () => void
  onConfirm: () => void
}): ReactNode {
  const preview: PreviewResult | null = state.preview
  const version = state.version
  const blocked = preview !== null && preview.ok !== true && preview.message !== undefined
  const upToDate = preview?.upToDate === true
  const dirtyPreview = preview !== null && preview.treeClean === false

  return (
    <Modal
      open={state.pendingConfirm !== null}
      onClose={onCancel}
      title={t('confirmTitle')}
      closeLabel={t('close')}
      description={state.pendingConfirm === null
        ? t('confirmBody', { path: version?.installPath ?? '' })
        : state.pendingConfirm.withInstall
          ? t('confirmWithInstallBody')
          : t('confirmBody', { path: version?.installPath ?? '' })}
      className={css.confirmDialog as string}
      footer={(
        <>
          <Button
            variant="outline"
            autoFocus
            disabled={state.updating}
            onClick={onCancel}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={state.updating || blocked || upToDate || dirtyPreview}
            onClick={onConfirm}
          >
            {state.updating
              ? t('updating')
              : state.pendingConfirm?.withInstall === true
                ? t('updateWithInstall')
                : t('update')}
          </Button>
        </>
      )}
    >
      {preview !== null && (
        <div className={css.preview}>
          {upToDate && <p className={css.ok} role="status">{t('previewUpToDate')}</p>}
          {blocked && <p className={css.error} role="alert">{t('previewBlocked', { message: preview.message ?? '' })}</p>}
          {dirtyPreview && <p className={css.error} role="alert">{t('previewDirty')}</p>}
          {!upToDate && !blocked && (
            <p className={css.previewLine}>
              <strong>{t('previewTitle')}:</strong>{' '}
              {t('previewFromTo', {
                from: preview.sourceVersion ?? preview.headBefore ?? '?',
                to: preview.targetVersion ?? preview.headAfter ?? '?',
              })}
            </p>
          )}
          {preview.localCommits !== undefined && preview.localCommits.length > 0 && (
            <div className={css.commitGroup}>
              <p className={css.commitTitle}>{t('previewLocalCommits', { n: preview.localCommits.length })}</p>
              <ul className={css.commitList}>
                {preview.localCommits.map(line => <li key={line}><code className={css.code}>{line}</code></li>)}
              </ul>
            </div>
          )}
          {preview.newCommits !== undefined && preview.newCommits.length > 0 && (
            <div className={css.commitGroup}>
              <p className={css.commitTitle}>{t('previewNewCommits', { n: preview.newCommits.length })}</p>
              <ul className={css.commitList}>
                {preview.newCommits.map(line => <li key={line}><code className={css.code}>{line}</code></li>)}
              </ul>
            </div>
          )}
          <p className={css.footerNote}>{t('footerNote')}</p>
        </div>
      )}
    </Modal>
  )
}

/** One-line notice for a finished update. */
function UpdateResultNotice({ result }: { result: OperationResult }): ReactNode {
  if (result.ok && result.upToDate === true) {
    return <p className={css.ok} role="status">{t('updateUpToDate')}</p>
  }
  if (result.ok) {
    return (
      <p className={css.ok} role="status">
        {t('updateOk', { from: result.versionBefore ?? result.from ?? '', to: result.versionAfter ?? result.to ?? '' })}
        {result.install !== undefined && result.install.ok === false
          ? ` · ${t('updateFailed', { error: `pnpm install (${String(result.install.code)})` })}`
          : ''}
        {' · '}{t('restartHint')}
      </p>
    )
  }
  if (result.conflict === true) {
    return (
      <div className={css.errorBlock} role="alert">
        <p className={css.error}>{t('updateConflict')}</p>
        {result.conflictedFiles !== undefined && result.conflictedFiles.length > 0 && (
          <p className={css.error}>{t('conflictFiles', { files: result.conflictedFiles.join(', ') })}</p>
        )}
      </div>
    )
  }
  return <p className={css.error} role="alert">{t('updateFailed', { error: result.message ?? '' })}</p>
}

/** One-click commit+push confirm dialog: lists what will be committed. */
function CommitPushConfirmDialog({
  state, onCancel, onConfirm,
}: {
  state: UpdateState
  onCancel: () => void
  onConfirm: () => void
}): ReactNode {
  const version = state.version
  const files = (version?.dirty ?? []).concat(version?.untracked ?? [])
  return (
    <Modal
      open={state.pendingCommitPush}
      onClose={onCancel}
      title={t('commitPushTitle')}
      closeLabel={t('close')}
      description={t('commitPushBody', { branch: version?.branch ?? '' })}
      className={css.confirmDialog as string}
      footer={(
        <>
          <Button variant="outline" autoFocus disabled={state.committing} onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button variant="primary" disabled={state.committing} onClick={onConfirm}>
            {state.committing ? t('committing') : t('commitPushConfirm')}
          </Button>
        </>
      )}
    >
      {files.length > 0 && (
        <ul className={css.fileList}>
          {files.slice(0, 12).map(file => <li key={file}><code className={css.code}>{file}</code></li>)}
          {files.length > 12 && <li><code className={css.code}>… +{files.length - 12}</code></li>}
        </ul>
      )}
      <p className={css.footerNote}>{t('commitPushNote')}</p>
    </Modal>
  )
}

/** One-line notice for a finished commit+push. */
function CommitPushResultNotice({ result }: { result: OperationResult }): ReactNode {
  if (result.ok) {
    return <p className={css.ok} role="status">{result.message ?? t('commitPushOk')}</p>
  }
  if (result.partial === true) {
    return (
      <div className={css.warningBlock} role="alert">
        <p className={css.warningText}>{result.message ?? t('commitPushPartial')}</p>
      </div>
    )
  }
  return <p className={css.error} role="alert">{result.message ?? t('commitPushFailed', { error: '' })}</p>
}
