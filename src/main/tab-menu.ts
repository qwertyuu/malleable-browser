import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import type { Bubble } from '../shared/ipc.js'

export interface TabMenuDeps {
  win: BrowserWindow
  /** Adaptation host slug of the right-clicked tab; null for pages with no host. */
  host: string | null
  bubbles: Bubble[]
  /** Start a new bubble holding only `host`. Consent is the callee's job. */
  startBubble: (host: string) => void
  /** Add `host` to an existing bubble. Consent is the callee's job. */
  addToBubble: (bubble: Bubble, host: string) => void
}

/**
 * The tab strip's right-click menu. Native rather than rendered by the chrome:
 * a React popover would drop into the content area, where the page's
 * WebContentsView paints over it.
 */
export function showTabContextMenu(deps: TabMenuDeps): void {
  Menu.buildFromTemplate(buildBubbleItems(deps)).popup({ window: deps.win })
}

export interface BubbleChipMenuDeps {
  win: BrowserWindow
  bubble: Bubble
  /** Host of the focused tab; null when it shows no site. */
  activeHost: string | null
  /** Member sites with no visible tab open. */
  missingHosts: string[]
  addActiveTab: (host: string) => void
  openMissingSites: () => void
}

/** The menu behind a bubble chip in the tab strip. */
export function showBubbleChipMenu(deps: BubbleChipMenuDeps): void {
  Menu.buildFromTemplate(buildBubbleChipItems(deps)).popup({ window: deps.win })
}

function buildBubbleChipItems(deps: BubbleChipMenuDeps): MenuItemConstructorOptions[] {
  const { bubble, activeHost, missingHosts } = deps
  const alreadyIn = activeHost !== null && bubble.hosts.includes(activeHost)
  return [
    { label: `${bubble.name}: ${bubble.hosts.join(', ') || 'no sites'}`, enabled: false },
    { type: 'separator' },
    {
      label: !activeHost
        ? 'Add current tab (no site on this tab)'
        : alreadyIn
          ? `Current tab (${activeHost}) is already in`
          : `Add current tab (${activeHost})`,
      enabled: activeHost !== null && !alreadyIn,
      click: () => activeHost && deps.addActiveTab(activeHost)
    },
    {
      label: missingHosts.length
        ? `Open sites without a tab (${missingHosts.length})`
        : 'Every site is already open',
      enabled: missingHosts.length > 0,
      click: deps.openMissingSites
    }
  ]
}

function buildBubbleItems(deps: TabMenuDeps): MenuItemConstructorOptions[] {
  const { host } = deps
  const startItem: MenuItemConstructorOptions = {
    label: host ? `New bubble from ${host}` : 'New bubble (no site on this tab)',
    enabled: host !== null,
    click: () => host && deps.startBubble(host)
  }
  const joinable = host ? deps.bubbles.filter((b) => !b.hosts.includes(host)) : []
  if (!host || joinable.length === 0) return [startItem]
  return [
    startItem,
    {
      label: 'Add to bubble',
      submenu: joinable.map((b) => ({
        label: `${b.name} (${b.hosts.join(', ')})`,
        click: () => deps.addToBubble(b, host)
      }))
    }
  ]
}
