/**
 * dsh-updater — browser half: the Settings "Updates" section plus the
 * sidebar footer version badge. All facts come from the plugin's host
 * `/__dsh-update` surface; the core RPC map has no version/update methods,
 * so nothing is added there. The section drives loads/checks/updates; the
 * badge shares the same snapshot store and only reflects it.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the sidebar's SlotMap merge (the 'sidebar.footer.action' entry).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { UpdateSection } from './UpdateSection.tsx'
import type { UpdateSectionInjected } from './UpdateSection.tsx'
import { UpdateBadge } from './UpdateBadge.tsx'
import type { UpdateBadgeInjected } from './UpdateBadge.tsx'
import { UpdatesController } from './updates-store.ts'
import { t } from './locales.ts'

export type { UpdateSectionInjected, UpdateSectionProps } from './UpdateSection.tsx'
export type { UpdateBadgeInjected, UpdateBadgeProps } from './UpdateBadge.tsx'
export type { UpdateState, VersionStatus, OperationResult, PreviewResult } from './updates-store.ts'

/** Required services (cordis fiber inject). */
export const inject = ['slots']

/**
 * Mount the Updates section and the sidebar badge.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const controller = new UpdatesController()

  const sectionInjected = (): UpdateSectionInjected => ({
    hooks: {
      version: controller.hooks,
    },
    load: () => controller.load(),
    check: () => controller.check(),
    confirmUpdate: (withInstall: boolean | null) => { controller.confirmUpdate(withInstall) },
    runUpdate: () => controller.runUpdate(),
    dismissToast: () => { controller.dismissToast() },
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-updater',
    order: 40,
    label: () => t('nav'),
    inject: sectionInjected,
  }, UpdateSection))

  const badgeInjected = (): UpdateBadgeInjected => ({
    hooks: {
      version: controller.hooks,
    },
    load: () => controller.load(),
  })

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-updater-badge',
    order: 10,
    inject: badgeInjected,
  }, UpdateBadge))
}
