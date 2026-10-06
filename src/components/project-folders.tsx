import { useId, useLayoutEffect, useRef, useState, type DragEvent } from 'react'
import type { Mailbox, Project } from '../../shared/mailbox'
import { projectColor, projectColors, projectSorts, sortProjects, type ProjectInput, type ProjectSort } from '../../shared/projects'
import { filterProjects } from '../lib/mailbox'
import { Icon } from './icon'

const colorNames = { green: 'Vert', orange: 'Orange', blue: 'Bleu', purple: 'Violet', rose: 'Rose', slate: 'Gris' }
export type FolderFailure = { message: string; revision: number }

export function ProjectFolders({ mailbox, revision, currentId, sort, order, disabled, dropTarget, movingMail, onSelect, onSave, onSort, onReorder, onMailOver, onMailLeave, onMailDrop }: {
  mailbox: Mailbox; currentId: string | null; sort: ProjectSort; order: string[]; disabled: boolean
  revision: number
  dropTarget: string | null; movingMail: boolean
  onSelect: (id: string) => void
  onSave: (input: ProjectInput, editingId: string | null, position: number | null, revision: number) => Promise<FolderFailure | null>
  onSort: (sort: ProjectSort) => void
  onReorder: (id: string, targetId: string, after: boolean) => Promise<boolean>
  onMailOver: (event: DragEvent<HTMLDivElement>, id: string) => void
  onMailLeave: (event: DragEvent<HTMLDivElement>) => void
  onMailDrop: (event: DragEvent<HTMLDivElement>, id: string) => void
}) {
  const id = useId()
  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [input, setInput] = useState<ProjectInput>({ id: '', name: '', color: 'blue' })
  const [position, setPosition] = useState(0)
  const [positionChanged, setPositionChanged] = useState(false)
  const [expectedRevision, setExpectedRevision] = useState(revision)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState<string | null>(null)
  const [target, setTarget] = useState<{ id: string; after: boolean } | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const codeInput = useRef<HTMLInputElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const dragged = useRef<string | null>(null)
  const keyboardHandle = useRef<HTMLButtonElement | null>(null)
  const manual = sortProjects(mailbox.projects, 'manual', order)
  const visible = filterProjects(sortProjects(mailbox.projects, sort, order), query)
  const canReorder = sort === 'manual' && !query.trim() && !disabled
  const sharedProject = editingId ? mailbox.projects.find((item) => item.id === editingId) : undefined

  useLayoutEffect(() => {
    const handle = keyboardHandle.current
    if (!disabled && handle?.isConnected) {
      handle.focus()
      handle.closest('.folder-row')?.scrollIntoView({ block: 'nearest' })
      keyboardHandle.current = null
    }
  }, [order, disabled])

  function open(project?: Project) {
    setEditingId(project?.id ?? null)
    setInput(project ?? { id: '', name: '', color: 'blue' })
    setPosition(project ? manual.findIndex((item) => item.id === project.id) : manual.length)
    setPositionChanged(false)
    setExpectedRevision(revision)
    setError('')
    if (!dialog.current!.open) dialog.current!.showModal()
    if (project) nameInput.current!.focus()
    else codeInput.current!.focus()
  }

  function finishDrag() { dragged.current = null; setDragging(null); setTarget(null) }

  return <section className="folder-section" aria-label="Dossiers de projets">
    <div className="folder-heading"><h2>Dossiers <span>{mailbox.projects.length}</span></h2><button className="folder-add icon-button" aria-label="Créer un dossier" title="Créer un dossier" disabled={disabled} onClick={() => open()}><Icon name="plus" /></button></div>
    <div className="folder-tools">
      <div className="folder-search"><Icon name="search" /><input aria-label="Rechercher un dossier" placeholder="Code ou nom du dossier…" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      <label className="folder-sort"><span className="sr-only">Trier les dossiers</span><select aria-label="Trier les dossiers" value={sort} disabled={disabled} onChange={(event) => onSort(event.target.value as ProjectSort)}>{Object.entries(projectSorts).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><span className="shared-label" title="Réglages communs à toute l’équipe"><Icon name="users" /></span></label>
    </div>
    <p className="folder-hint">{sort !== 'manual' ? 'Tri partagé avec l’équipe' : query.trim() ? 'Effacez la recherche pour réordonner' : 'Glisser la poignée pour réordonner'}</p>
    <nav className="project-nav" aria-label="Projets">
      {visible.map((project, index) => {
        const count = mailbox.conversations.filter((item) => item.projectId === project.id).length
        return <div key={project.id} data-project-id={project.id} className={`folder-row ${currentId === project.id ? 'selected' : ''} ${dragging === project.id ? 'folder-dragging' : ''} ${target?.id === project.id ? target.after ? 'insert-after' : 'insert-before' : ''} ${dropTarget === project.id ? 'drop-target' : ''} ${movingMail ? 'drop-available' : ''}`}
          onDragOver={(event) => {
            if (!dragged.current) { onMailOver(event, project.id); return }
            if (!canReorder || dragged.current === project.id) return
            event.preventDefault(); event.dataTransfer.dropEffect = 'move'
            const rect = event.currentTarget.getBoundingClientRect()
            setTarget({ id: project.id, after: event.clientY > rect.top + rect.height / 2 })
          }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTarget(null); onMailLeave(event) }}
          onDrop={(event) => {
            if (!dragged.current) { onMailDrop(event, project.id); return }
            event.preventDefault()
            if (canReorder && target?.id === project.id) void onReorder(dragged.current, project.id, target.after)
            finishDrag()
          }}>
          {sort === 'manual' ? <button className="folder-grip" draggable={canReorder} disabled={!canReorder} aria-label={`Réordonner ${project.id} — ${project.name}`} aria-describedby={`${id}-reorder-help`} title="Glisser, ou utiliser les flèches ↑ ↓ au clavier"
            onDragStart={(event) => {
              if (!canReorder) { event.preventDefault(); return }
              dragged.current = project.id; setDragging(project.id)
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData('application/x-courrier-folder', project.id)
              event.dataTransfer.setDragImage(event.currentTarget.closest('.folder-row')!, 20, 20)
            }} onDragEnd={finishDrag}
            onKeyDown={(event) => {
              if (!canReorder || !['ArrowUp', 'ArrowDown'].includes(event.key)) return
              event.preventDefault()
              const next = visible[index + (event.key === 'ArrowUp' ? -1 : 1)]
              if (next) { keyboardHandle.current = event.currentTarget; void onReorder(project.id, next.id, event.key === 'ArrowDown') }
            }}><Icon name="grip" /></button> : null}
          <button className="project-button" aria-current={currentId === project.id ? 'page' : undefined} onClick={() => onSelect(project.id)} title={`${project.id} — ${project.name}`}>
            <span className="folder-icon" style={{ color: projectColor(project.color) }}><Icon name="folder" /></span>
            <span className="folder-text"><small>{project.id}</small><span>{project.name}</span></span>
            <b aria-label={`${count} conversation${count > 1 ? 's' : ''}`}>{count}</b>
          </button>
          <button className="folder-edit icon-button" aria-label={`Modifier le dossier ${project.id}`} title="Modifier le dossier" disabled={disabled} onClick={() => open(project)}><Icon name="edit" /></button>
        </div>
      })}
      {!visible.length ? <p className="folder-no-results" role="status">Aucun dossier trouvé.</p> : null}
    </nav>
    <span className="sr-only" id={`${id}-reorder-help`}>Utilisez les flèches haut et bas pour déplacer ce dossier. Vous pouvez aussi choisir sa position dans Modifier le dossier.</span>
    <dialog className="folder-dialog" ref={dialog} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}>
      <form onSubmit={async (event) => {
        event.preventDefault()
        const failure = await onSave(input, editingId, positionChanged ? position : null, expectedRevision)
        if (failure) { setError(failure.message); setExpectedRevision(failure.revision) }
        else dialog.current!.close()
      }}>
        <header><div><span className="eyebrow">Dossier de projet</span><h2 id={`${id}-title`}>{editingId ? 'Modifier le dossier' : 'Créer un dossier'}</h2></div><button className="icon-button" type="button" aria-label="Fermer" onClick={() => dialog.current!.close()}><Icon name="close" /></button></header>
        <p id={`${id}-description`}>Nom, couleur et position partagés avec toute l’équipe.</p>
        <label className="dialog-field" htmlFor={`${id}-code`}>Code du projet<input id={`${id}-code`} ref={codeInput} value={input.id} required maxLength={32} readOnly={!!editingId} placeholder="Ex. 2401" onChange={(event) => setInput({ ...input, id: event.target.value })} />{editingId ? <small>Le code reste identique pour conserver les échanges associés.</small> : <small>Lettres, chiffres, tirets et points. Un code unique par dossier.</small>}</label>
        <label className="dialog-field" htmlFor={`${id}-name`}>Nom du projet<input id={`${id}-name`} ref={nameInput} value={input.name} required maxLength={100} placeholder="Ex. Résidence des Tilleuls" onChange={(event) => setInput({ ...input, name: event.target.value })} /></label>
        <fieldset className="folder-colors"><legend>Couleur du dossier</legend><div className="color-options">{Object.entries(projectColors).map(([key, color]) => <label className="color-swatch" title={colorNames[key as keyof typeof colorNames]} key={key}><input className="sr-only" type="radio" name={`${id}-color`} value={key} aria-label={colorNames[key as keyof typeof colorNames]} checked={input.color === key} onChange={() => setInput({ ...input, color: key })} /><span style={{ backgroundColor: color }} /></label>)}<label className="custom-color" title="Couleur personnalisée"><input type="color" aria-label="Couleur personnalisée" value={projectColor(input.color)} onChange={(event) => setInput({ ...input, color: event.target.value })} /><span>Personnalisée</span></label></div></fieldset>
        <label className="dialog-field" htmlFor={`${id}-position`}>Position dans l’ordre manuel<select id={`${id}-position`} value={positionChanged ? Math.min(position, mailbox.projects.length - (editingId ? 1 : 0)) : editingId ? manual.findIndex((item) => item.id === editingId) : manual.length} onChange={(event) => { setPosition(Number(event.target.value)); setPositionChanged(true) }}>{Array.from({ length: mailbox.projects.length + (editingId ? 0 : 1) }, (_, index) => <option key={index} value={index}>{index + 1}{index === 0 ? ' · En premier' : index === mailbox.projects.length - (editingId ? 1 : 0) ? ' · En dernier' : ''}</option>)}</select></label>
        <div className="folder-preview"><span className="folder-icon" style={{ color: projectColor(input.color) }}><Icon name="folder" /></span><span><small>{input.id.trim() || 'CODE'}</small><strong>{input.name.trim() || 'Nom du projet'}</strong></span></div>
        {error ? <p className="dialog-error" role="alert">{error}</p> : null}
        {error && sharedProject ? <div className="folder-conflict"><span>Version partagée actuelle</span><p><span className="project-dot" style={{ backgroundColor: projectColor(sharedProject.color) }} />{sharedProject.id} — {sharedProject.name}</p><button className="secondary-button" type="button" onClick={() => open(sharedProject)}>Charger cette version</button></div> : null}
        <footer><button className="secondary-button" type="button" onClick={() => dialog.current!.close()}>Annuler</button><button className="primary-button" type="submit" disabled={disabled}>{disabled ? 'Enregistrement…' : editingId ? 'Enregistrer' : 'Créer le dossier'}</button></footer>
      </form>
    </dialog>
  </section>
}
