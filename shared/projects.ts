import type { Label, Project, ProjectSettings } from './mailbox.js'

export const projectColors = {
  green: '#22a06b', orange: '#e09a35', blue: '#5385d9',
  purple: '#8b5cf6', rose: '#e45380', slate: '#71717a',
}
export const projectSorts = {
  manual: 'Ordre manuel', 'name-asc': 'Nom · A → Z', 'name-desc': 'Nom · Z → A',
  recent: 'Création récente', oldest: 'Création ancienne', code: 'Code du projet',
}
export type ProjectSort = keyof typeof projectSorts
export type ProjectInput = Pick<Project, 'id' | 'name' | 'color' | 'parentId'>
export const isProjectSort = (value: string): value is ProjectSort => Object.hasOwn(projectSorts, value)
export const isProjectColor = (value: string) => Object.hasOwn(projectColors, value) || /^#[0-9a-f]{6}$/i.test(value)
export const projectColor = (value: string) => projectColors[value as keyof typeof projectColors] ?? (/^#[0-9a-f]{6}$/i.test(value) ? value : '#71717a')

export function isProjectSettings(value: unknown): value is ProjectSettings {
  if (!value || typeof value !== 'object') return false
  const item = value as ProjectSettings
  return Number.isSafeInteger(item.revision) && item.revision >= 0 &&
    typeof item.sort === 'string' && isProjectSort(item.sort) && Array.isArray(item.projects) &&
    item.projects.length > 0 && item.projects.length <= 1000 && item.projects.every(isProject) &&
    new Set(item.projects.map((project) => project.id.toLowerCase())).size === item.projects.length &&
    isProjectHierarchy(item.projects) && isLabels(item.labels ?? []) &&
    Array.isArray(item.order) && item.order.length === item.projects.length &&
    new Set(item.order).size === item.order.length && item.order.every((id) => typeof id === 'string' && item.projects.some((project) => project.id === id))
}

export function isProject(value: unknown): value is Project {
  if (!value || typeof value !== 'object') return false
  const item = value as Project
  return typeof item.id === 'string' && /^[a-z0-9][a-z0-9._-]{0,31}$/i.test(item.id) &&
    typeof item.name === 'string' && item.name === item.name.trim() && item.name.length > 0 && item.name.length <= 100 &&
    !/[\u0000-\u001f/\\]/.test(item.name) && typeof item.color === 'string' && isProjectColor(item.color) &&
    (item.parentId === undefined || item.parentId === null || (typeof item.parentId === 'string' && item.parentId.length > 0)) &&
    (item.createdAt === undefined || (typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt))))
}

export function prepareProject(input: ProjectInput, projects: Project[], editingId: string | null): Project {
  const previous = editingId ? projects.find((item) => item.id === editingId) : undefined
  if (editingId && (!previous || input.id !== editingId)) throw new Error('Le code d’un dossier existant ne peut pas être modifié.')
  const project = { ...previous, id: input.id.trim(), name: input.name.trim(), color: input.color, parentId: input.parentId ?? null,
    createdAt: editingId ? previous?.createdAt : new Date().toISOString() }
  if (!isProject(project)) throw new Error('Indiquez un code valide, un nom de 1 à 100 caractères sans / ni \\, et une couleur valide.')
  if (projects.some((item) => item.id !== editingId && item.id.toLowerCase() === project.id.toLowerCase())) throw new Error('Ce code de projet existe déjà.')
  if (!isProjectHierarchy([...projects.filter((item) => item.id !== editingId), project])) throw new Error('Parent invalide, nom déjà utilisé ou profondeur maximale de 8 dossiers atteinte.')
  return project
}

export function isLabels(value: unknown): value is Label[] {
  if (!Array.isArray(value) || value.length > 1000) return false
  return value.every((item) => item && typeof item.id === 'string' && /^[a-z0-9][a-z0-9._-]{0,31}$/i.test(item.id) && typeof item.name === 'string' && item.name === item.name.trim() && item.name.length > 0 && item.name.length <= 60 && !/[\u0000-\u001f]/.test(item.name) && typeof item.color === 'string' && isProjectColor(item.color)) &&
    new Set(value.map((item) => item.id)).size === value.length && new Set(value.map((item) => item.name.toLocaleLowerCase('fr'))).size === value.length
}

export function isProjectHierarchy(projects: Project[]) {
  const byId = new Map(projects.map((item) => [item.id, item]))
  const siblings = new Set<string>()
  return projects.every((project) => {
    if (project.parentId) {
      const key = `${project.parentId}/${project.name.toLocaleLowerCase('fr')}`
      if (siblings.has(key)) return false
      siblings.add(key)
    }
    let item: Project | undefined = project
    const seen = new Set<string>()
    while (item) {
      if (seen.has(item.id) || seen.size >= 8) return false
      seen.add(item.id)
      if (!item.parentId) return true
      item = byId.get(item.parentId)
      if (!item) return false
    }
    return false
  })
}

export function projectPath(projects: Project[], id: string): string {
  const project = projects.find((item) => item.id === id)
  if (!project) return ''
  return project.parentId ? `${projectPath(projects, project.parentId)} / ${project.name}` : `${project.id} — ${project.name}`
}

export function projectTree(projects: Project[], sort: ProjectSort, order: string[], collapsed: string[] = [], query = '') {
  const ordered = sortProjects(projects, sort, order)
  const needle = query.trim().normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('fr')
  // ponytail: scan paths for demo-sized catalogs; index ancestry if folder searches become slow.
  const result: { project: Project; depth: number }[] = []
  function visit(parentId: string | null, depth: number) {
    for (const project of ordered.filter((item) => (item.parentId ?? null) === parentId)) {
      const matches = !needle || projectPath(projects, project.id).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('fr').includes(needle)
      if (matches || (needle && ordered.some((item) => projectPath(projects, item.id).startsWith(`${projectPath(projects, project.id)} /`) && projectPath(projects, item.id).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('fr').includes(needle)))) result.push({ project, depth })
      if (needle || !collapsed.includes(project.id)) visit(project.id, depth + 1)
    }
  }
  visit(null, 0)
  return result
}

export function sortProjects(projects: Project[], sort: ProjectSort, order: string[] = []) {
  const manual = [...new Set(order)].map((id) => projects.find((item) => item.id === id)).filter((item): item is Project => !!item)
  manual.push(...projects.filter((item) => !order.includes(item.id)))
  if (sort === 'manual') return manual
  const compare = (a: string, b: string) => a.localeCompare(b, 'fr', { sensitivity: 'base', numeric: true })
  return manual.sort((a, b) => {
    if (sort === 'code') return compare(a.id, b.id)
    if (sort === 'name-asc' || sort === 'name-desc') return compare(a.name, b.name) * (sort === 'name-desc' ? -1 : 1) || compare(a.id, b.id)
    const dates = (a.createdAt ? Date.parse(a.createdAt) : 0) - (b.createdAt ? Date.parse(b.createdAt) : 0)
    return dates * (sort === 'recent' ? -1 : 1) || compare(a.id, b.id)
  })
}

export function positionProject(projects: Project[], id: string, position: number) {
  const project = projects.find((item) => item.id === id)
  if (!project || !Number.isInteger(position) || position < 0 || position >= projects.length) throw new Error('Position de dossier invalide.')
  const result = projects.filter((item) => item.id !== id)
  result.splice(position, 0, project)
  return result
}
