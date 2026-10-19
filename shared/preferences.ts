import type { ProjectSort } from './projects.js'

// Per-user display choices, stored on the member so they follow the person across browsers. Folder sorting and manual
// order are only a view: they never rename or move anything on the mail server.
export type Preferences = {
  displayMode?: 'messages' | 'threads'; listOrder?: 'newest' | 'oldest'; conversationOrder?: 'newest' | 'oldest'
  contactCollapsed?: boolean; autoRefresh?: boolean; openFolders?: string[]; folderSort?: ProjectSort; folderOrder?: string[]
}
export const preferenceKeys = ['displayMode', 'listOrder', 'conversationOrder', 'contactCollapsed', 'autoRefresh', 'openFolders', 'folderSort', 'folderOrder'] as const
// Kept here rather than imported so this module has no runtime dependency; `satisfies` keeps it in step with projectSorts.
const folderSorts = { manual: 1, 'name-asc': 1, 'name-desc': 1, recent: 1, oldest: 1, code: 1, 'code-desc': 1 } satisfies Record<ProjectSort, 1>
const folderIds = (value: unknown) => value === undefined || (Array.isArray(value) && value.length <= 10_000 && value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 100))

export function isPreferences(value: unknown): value is Preferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Preferences
  const order = (v: unknown) => v === undefined || v === 'newest' || v === 'oldest'
  const flag = (v: unknown) => v === undefined || typeof v === 'boolean'
  return Object.keys(item).every((key) => (preferenceKeys as readonly string[]).includes(key)) &&
    (item.displayMode === undefined || item.displayMode === 'messages' || item.displayMode === 'threads') &&
    order(item.listOrder) && order(item.conversationOrder) && flag(item.contactCollapsed) && flag(item.autoRefresh) &&
    folderIds(item.openFolders) && folderIds(item.folderOrder) && (item.folderSort === undefined || Object.hasOwn(folderSorts, item.folderSort))
}

export function pickPreferences(source: Preferences): Preferences {
  return Object.fromEntries(preferenceKeys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]))
}
