import type { Project, ProjectSettings } from './mailbox.js'

export const projectColors = {
  green: '#22a06b', orange: '#e09a35', blue: '#5385d9',
  purple: '#8b5cf6', rose: '#e45380', slate: '#71717a',
}
export const projectSorts = {
  manual: 'Ordre manuel', 'name-asc': 'Nom · A → Z', 'name-desc': 'Nom · Z → A',
  recent: 'Création récente', oldest: 'Création ancienne', code: 'Code du projet',
}
export type ProjectSort = keyof typeof projectSorts
export type ProjectInput = Pick<Project, 'id' | 'name' | 'color'>
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
    Array.isArray(item.order) && item.order.length === item.projects.length &&
    new Set(item.order).size === item.order.length && item.order.every((id) => typeof id === 'string' && item.projects.some((project) => project.id === id))
}

export function isProject(value: unknown): value is Project {
  if (!value || typeof value !== 'object') return false
  const item = value as Project
  return typeof item.id === 'string' && /^[a-z0-9][a-z0-9._-]{0,31}$/i.test(item.id) &&
    typeof item.name === 'string' && item.name === item.name.trim() && item.name.length > 0 && item.name.length <= 100 &&
    !/[\u0000-\u001f/\\]/.test(item.name) && typeof item.color === 'string' && isProjectColor(item.color) &&
    (item.createdAt === undefined || (typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt))))
}

export function prepareProject(input: ProjectInput, projects: Project[], editingId: string | null): Project {
  const previous = editingId ? projects.find((item) => item.id === editingId) : undefined
  if (editingId && (!previous || input.id !== editingId)) throw new Error('Le code d’un dossier existant ne peut pas être modifié.')
  const project = { ...previous, id: input.id.trim(), name: input.name.trim(), color: input.color,
    createdAt: editingId ? previous?.createdAt : new Date().toISOString() }
  if (!isProject(project)) throw new Error('Indiquez un code valide, un nom de 1 à 100 caractères sans / ni \\, et une couleur valide.')
  if (projects.some((item) => item.id !== editingId && item.id.toLowerCase() === project.id.toLowerCase())) throw new Error('Ce code de projet existe déjà.')
  return project
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
