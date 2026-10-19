import type { Label, Project, ProjectSettings } from './mailbox.js'

export const projectColors = {
  green: '#22a06b', orange: '#e09a35', blue: '#5385d9',
  purple: '#8b5cf6', rose: '#e45380', slate: '#71717a',
}
export const projectSorts = {
  manual: 'Ordre manuel', 'name-asc': 'Nom · A → Z', 'name-desc': 'Nom · Z → A',
  recent: 'Création récente', oldest: 'Création ancienne', code: 'Code · croissant', 'code-desc': 'Code · décroissant',
}
export type ProjectSort = keyof typeof projectSorts
export type ProjectInput = Pick<Project, 'id' | 'name' | 'color' | 'parentId'>
export const isProjectSort = (value: string): value is ProjectSort => Object.hasOwn(projectSorts, value)
export const isProjectColor = (value: string) => Object.hasOwn(projectColors, value) || /^#[0-9a-f]{6}$/i.test(value)
export const projectColor = (value: string) => projectColors[value as keyof typeof projectColors] ?? (/^#[0-9a-f]{6}$/i.test(value) ? value : '#71717a')

export function isProjectSettings(value: unknown): value is ProjectSettings {
  if (!value || typeof value !== 'object') return false
  const item = value as ProjectSettings
  const ids = new Set(Array.isArray(item.projects) ? item.projects.map((project) => project?.id) : [])
  return Number.isSafeInteger(item.revision) && item.revision >= 0 &&
    typeof item.sort === 'string' && isProjectSort(item.sort) && Array.isArray(item.projects) &&
    item.projects.length > 0 && item.projects.length <= 10_000 && item.projects.every(isStoredProject) &&
    new Set(item.projects.map((project) => project.id.toLowerCase())).size === item.projects.length &&
    isProjectTree(item.projects) && isLabels(item.labels ?? []) &&
    Array.isArray(item.order) && item.order.length === item.projects.length &&
    new Set(item.order).size === item.order.length && item.order.every((id) => typeof id === 'string' && ids.has(id))
}

// A folder as a person names it in Postfold: trimmed, at most 100 characters, without / or \.
export function isProject(value: unknown): value is Project {
  return isStoredProject(value) && value.name === value.name.trim() && value.name.length <= 100 && !/[/\\]/.test(value.name)
}

// A folder as stored: the names of synchronized IMAP folders are kept as the mail server has them.
export function isStoredProject(value: unknown): value is Project {
  if (!value || typeof value !== 'object') return false
  const item = value as Project
  return typeof item.id === 'string' && /^[a-z0-9][a-z0-9._-]{0,31}$/i.test(item.id) &&
    typeof item.name === 'string' && item.name.trim().length > 0 && item.name.length <= 255 &&
    !/[\u0000-\u001f]/.test(item.name) && typeof item.color === 'string' && isProjectColor(item.color) &&
    (item.parentId === undefined || item.parentId === null || (typeof item.parentId === 'string' && item.parentId.length > 0)) &&
    (item.code === undefined || item.code === null || (typeof item.code === 'string' && /^[a-z0-9][a-z0-9._-]{0,31}$/i.test(item.code))) &&
    (item.createdAt === undefined || (typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt))))
}

export function prepareProject(input: ProjectInput, projects: Project[], editingId: string | null): Project {
  const previous = editingId ? projects.find((item) => item.id === editingId) : undefined
  if (editingId && (!previous || input.id !== editingId)) throw new Error('Le code d’un dossier existant ne peut pas être modifié.')
  const project = { ...previous, id: input.id.trim(), name: input.name.trim(), color: input.color, parentId: input.parentId ?? null,
    createdAt: editingId ? previous?.createdAt : new Date().toISOString() }
  if (!isProject(project)) throw new Error('Indiquez un code valide, un nom de 1 à 100 caractères sans / ni \\, et une couleur valide.')
  if (projects.some((item) => item.id !== editingId && item.id.toLowerCase() === project.id.toLowerCase())) throw new Error('Ce code de projet existe déjà.')
  if (!isProjectChange([...projects.filter((item) => item.id !== editingId), project], project)) throw new Error('Parent invalide, nom déjà utilisé ou profondeur maximale de 8 dossiers atteinte.')
  return project
}

export function isLabels(value: unknown): value is Label[] {
  if (!Array.isArray(value) || value.length > 1000) return false
  return value.every((item) => item && typeof item.id === 'string' && /^[a-z0-9][a-z0-9._-]{0,31}$/i.test(item.id) && typeof item.name === 'string' && item.name === item.name.trim() && item.name.length > 0 && item.name.length <= 60 && !/[\u0000-\u001f]/.test(item.name) && typeof item.color === 'string' && isProjectColor(item.color)) &&
    new Set(value.map((item) => item.id)).size === value.length && new Set(value.map((item) => item.name.toLocaleLowerCase('fr'))).size === value.length
}

// Every parent exists and no folder is its own ancestor. Depth and sibling names are the mail server's business
// for synchronized folders; isProjectChange applies Postfold's own rules to the folders a person edits.
export function isProjectTree(projects: Project[]) {
  const byId = new Map(projects.map((item) => [item.id, item]))
  return projects.every((project) => {
    let item: Project | undefined = project
    for (let depth = 0; item?.parentId; depth++) {
      if (depth >= 64) return false
      item = byId.get(item.parentId)
      if (!item || item.id === project.id) return false
    }
    return !!item
  })
}

// A created, renamed or moved folder: at most 8 levels deep and no sibling with the same name (ignoring case).
export function isProjectChange(projects: Project[], project: Project) {
  const byId = new Map(projects.map((item) => [item.id, item]))
  byId.set(project.id, project)
  let depth = 1
  for (let item = project; item.parentId; depth++) {
    const parent = byId.get(item.parentId)
    if (!parent || parent.id === project.id || depth >= 8) return false
    item = parent
  }
  const name = project.name.toLocaleLowerCase('fr')
  return ![...byId.values()].some((item) => item.id !== project.id && (item.parentId ?? null) === (project.parentId ?? null) && !!project.parentId && item.name.toLocaleLowerCase('fr') === name)
}

// The first folder created or changed in `next` that breaks the naming rules; unchanged IMAP folders are not judged.
export function invalidProjectChange(previous: Project[], next: Project[]) {
  const before = new Map(previous.map((item) => [item.id, item]))
  return next.find((project) => {
    const old = before.get(project.id)
    const changed = !old || old.name !== project.name || (old.parentId ?? null) !== (project.parentId ?? null) || (old.code ?? null) !== (project.code ?? null)
    return changed && (!isProject(project) || !isProjectChange(next, project))
  })
}

export function projectPath(projects: Project[], id: string): string {
  const project = projects.find((item) => item.id === id)
  if (!project) return ''
  return project.parentId ? `${projectPath(projects, project.parentId)} / ${project.name}` : project.code === null ? project.name : `${project.code ?? project.id} — ${project.name}`
}

// Folders sorted level by level: each parent lists its children in the chosen order.
export function projectTree(projects: Project[], sort: ProjectSort, order: string[], collapsed: string[] = [], query = '') {
  const fold = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('fr')
  const needle = fold(query.trim())
  const closed = new Set(collapsed)
  const children = new Map<string | null, Project[]>()
  for (const project of sortProjects(projects, sort, order)) {
    const siblings = children.get(project.parentId ?? null)
    if (siblings) siblings.push(project)
    else children.set(project.parentId ?? null, [project])
  }
  const result: { project: Project; depth: number }[] = []
  // Same path as projectPath, built once per folder; a search keeps the ancestors of every match.
  function visit(parentId: string | null, depth: number, parentPath: string): boolean {
    let found = false
    for (const project of children.get(parentId) ?? []) {
      const path = parentId ? `${parentPath} / ${project.name}` : project.code === null ? project.name : `${project.code ?? project.id} — ${project.name}`
      const start = result.length
      result.push({ project, depth })
      const below = needle || !closed.has(project.id) ? visit(project.id, depth + 1, path) : false
      if (needle && !below && !fold(path).includes(needle)) result.length = start
      else found = true
    }
    return found
  }
  visit(null, 0, '')
  return result
}

// One collator for every comparison: localeCompare with options builds a new one per call (~30× slower on large trees).
const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true })

export function sortProjects(projects: Project[], sort: ProjectSort, order: string[] = []) {
  const byId = new Map(projects.map((item) => [item.id, item]))
  const listed = new Set(order)
  const manual = [...listed].map((id) => byId.get(id)).filter((item): item is Project => !!item)
  manual.push(...projects.filter((item) => !listed.has(item.id)))
  if (sort === 'manual') return manual
  const compare = collator.compare
  // Subfolders have no project code: they sort by name. Ties (IMAP folders share their first sync date) fall back to the name.
  const code = (item: Project) => item.parentId || item.code === null ? item.name : item.code ?? item.id
  return manual.sort((a, b) => {
    if (sort === 'code' || sort === 'code-desc') return (compare(code(a), code(b)) || compare(a.name, b.name) || compare(a.id, b.id)) * (sort === 'code-desc' ? -1 : 1)
    if (sort === 'name-asc' || sort === 'name-desc') return (compare(a.name, b.name) || compare(a.id, b.id)) * (sort === 'name-desc' ? -1 : 1)
    const dates = (a.createdAt ? Date.parse(a.createdAt) : 0) - (b.createdAt ? Date.parse(b.createdAt) : 0)
    return dates * (sort === 'recent' ? -1 : 1) || compare(a.name, b.name) || compare(a.id, b.id)
  })
}

export function positionProject(projects: Project[], id: string, position: number) {
  const project = projects.find((item) => item.id === id)
  if (!project || !Number.isInteger(position) || position < 0 || position >= projects.length) throw new Error('Position de dossier invalide.')
  const result = projects.filter((item) => item.id !== id)
  result.splice(position, 0, project)
  return result
}
