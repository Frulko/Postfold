// Per-user display choices, stored on the member so they follow the person across browsers.
export type Preferences = {
  displayMode?: 'messages' | 'threads'; listOrder?: 'newest' | 'oldest'; conversationOrder?: 'newest' | 'oldest'
  contactCollapsed?: boolean; autoRefresh?: boolean; openFolders?: string[]
}
export const preferenceKeys = ['displayMode', 'listOrder', 'conversationOrder', 'contactCollapsed', 'autoRefresh', 'openFolders'] as const

export function isPreferences(value: unknown): value is Preferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Preferences
  const order = (v: unknown) => v === undefined || v === 'newest' || v === 'oldest'
  const flag = (v: unknown) => v === undefined || typeof v === 'boolean'
  return Object.keys(item).every((key) => (preferenceKeys as readonly string[]).includes(key)) &&
    (item.displayMode === undefined || item.displayMode === 'messages' || item.displayMode === 'threads') &&
    order(item.listOrder) && order(item.conversationOrder) && flag(item.contactCollapsed) && flag(item.autoRefresh) &&
    (item.openFolders === undefined || (Array.isArray(item.openFolders) && item.openFolders.length <= 10_000 &&
      item.openFolders.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 100)))
}

export function pickPreferences(source: Preferences): Preferences {
  return Object.fromEntries(preferenceKeys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]))
}
