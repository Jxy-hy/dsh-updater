/**
 * dsh-updater sidebar footer badge: a compact version pill beside Settings
 * at the sidebar foot. The dot color reflects the check outcome; the label
 * shows the source version. Clicking refreshes the status; details live in
 * Settings → Updates.
 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { UpdateState } from './updates-store.ts'
import { t } from './locales.ts'
import css from './UpdateBadge.module.css'

/** Registration-side business face for the badge. */
export interface UpdateBadgeInjected {
  hooks: {
    /** Shared page snapshot bound as useVersion. */
    version: SnapshotStore<UpdateState>
  }
  /** Refresh the host status (also fired on click). */
  load: () => Promise<void>
}

/** Full component props: the sidebar column state plus the injected face. */
export type UpdateBadgeProps =
  PropsRuntime<'sidebar.footer.action'>
  & InjectFace<UpdateBadgeInjected>

/**
 * Render the version pill. `wide` comes from the sidebar shell: false means
 * the 56px rail, so the label collapses to the dot + short version only.
 */
export function UpdateBadge(props: UpdateBadgeProps): ReactNode {
  const { useVersion, load, wide } = props
  const state = useVersion(snapshot => snapshot)

  useEffect(() => {
    void load()
  }, [load])

  const v = state.version
  const version = v?.sourceVersion ?? v?.runningVersion ?? '?'
  // Upstream ref known with no new commits, but never verified by a
  // successful fetch in this session: the 'up to date' claim is unverified.
  const unverified = v !== null
    && v.upstreamFresh === false
    && v.upstreamAhead === 0
    && v.outdated !== true
    && v.upToDate !== true
    && v.unknownVersions !== true
  const dot = v === null || v.resolved !== true
    ? css.dotUnknown
    : v.outdated === true
      ? css.dotOutdated
      : v.upToDate === true
        ? css.dotOk
        : unverified
          ? css.dotWarn
          : v.checkError !== null && v.checkError !== undefined
            ? css.dotError
            : css.dotUnknown
  const title = v === null
    ? t('badgeTitle', { version })
    : v.outdated === true
      ? `${t('badgeTitle', { version })} — ${t('badgeUpdateAvailable')}`
      : v.upToDate === true
        ? `${t('badgeTitle', { version })} — ${t('badgeUpToDate')}`
        : unverified
          ? `${t('badgeTitle', { version })} — ${t('badgeUnverified')}`
          : v.checkError !== null && v.checkError !== undefined
            ? `${t('badgeTitle', { version })} — ${t('badgeError')}`
            : `${t('badgeTitle', { version })} — ${t('badgeUnknown')}`

  return (
    <button
      type="button"
      className={css.badge}
      title={`${title} · ${t('badgeHint')}`}
      aria-label={title}
      onClick={() => { void load() }}
    >
      <span className={`${css.dot} ${dot}`} aria-hidden="true" />
      {wide && <span className={css.label}>v{version}</span>}
    </button>
  )
}
