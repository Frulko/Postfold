import { useEffect, useId, useState } from 'react'
import { filterProjects, type Project } from '../lib/mailbox'
import { Icon } from './icon'
import { projectColor } from '../../shared/projects'

export function ProjectPicker({ projects, disabled, onSelect }: {
  projects: Project[]
  disabled: boolean
  onSelect: (id: string) => boolean
}) {
  const id = useId()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const results = filterProjects(projects, query)
  const activeId = open && results[activeIndex] ? `${id}-${results[activeIndex].id}` : undefined

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  function select(projectId: string) {
    if (!onSelect(projectId)) return
    setOpen(false)
    setQuery('')
    setActiveIndex(-1)
  }

  return <div className="project-picker">
    <label className="picker-label" htmlFor={`${id}-input`}>Déplacer vers un projet</label>
    <div className="picker-field"><Icon name="search" /><input id={`${id}-input`} role="combobox" aria-expanded={open} aria-controls={open ? `${id}-list` : undefined} aria-autocomplete="list" aria-activedescendant={activeId} autoComplete="off" placeholder="Rechercher un ID ou un nom…" disabled={disabled} value={query}
      onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
      onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); setOpen(true) }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) { event.preventDefault(); setOpen(false); return }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          setOpen(true)
          setActiveIndex((index) => event.key === 'ArrowDown' ? Math.min(index + 1, results.length - 1) : index < 0 ? results.length - 1 : Math.max(index - 1, 0))
        }
        if (event.key === 'Enter' && open && results[activeIndex]) { event.preventDefault(); select(results[activeIndex].id) }
      }} /></div>
    {open ? <div className="picker-popup">
      <ul id={`${id}-list`} role="listbox" aria-label="Projets de destination">
        {results.map((project, index) => <li id={`${id}-${project.id}`} role="option" aria-selected={activeIndex === index} key={project.id}
          onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActiveIndex(index)} onClick={() => select(project.id)}>
          <span className="project-dot" style={{ backgroundColor: projectColor(project.color) }} /><span className="picker-project-id">{project.id}</span><span className="picker-project-name">{project.name}</span>
        </li>)}
      </ul>
      {!results.length ? <p className="picker-empty" role="status">Aucun projet trouvé.</p> : null}
    </div> : null}
  </div>
}
