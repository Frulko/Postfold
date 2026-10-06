import { useI18n } from '../lib/i18n'
import { useId, useLayoutEffect, useRef, useState, type DragEvent } from 'react'
import type { Mailbox, Project } from '../../shared/mailbox'
import { projectColor, projectColors, projectSorts, projectPath, projectTree, sortProjects, type ProjectInput, type ProjectSort } from '../../shared/projects'
import { Icon } from './icon'

const colorNames = { green: 'Vert', orange: 'Orange', blue: 'Bleu', purple: 'Violet', rose: 'Rose', slate: 'Gris' }
export type FolderFailure = { message: string; revision: number }

export function ProjectFolders({ mailbox, revision, currentId, sort, order, disabled, allowDelete = true, dropTarget, movingMail, onSelect, onSave, onSort, onReorder, onDelete, onMailOver, onMailLeave, onMailDrop }: {
  mailbox: Mailbox; currentId: string | null; sort: ProjectSort; order: string[]; disabled: boolean
  revision: number
  allowDelete?: boolean
  dropTarget: string | null; movingMail: boolean
  onSelect: (id: string) => void
  onSave: (input: ProjectInput, editingId: string | null, position: number | null, revision: number) => Promise<FolderFailure | null>
  onSort: (sort: ProjectSort) => void
  onDelete: (id: string, revision: number) => Promise<FolderFailure | null>
  onReorder: (id: string, targetId: string, placement: 'before' | 'inside' | 'after') => Promise<boolean>
  onMailOver: (event: DragEvent<HTMLDivElement>, id: string) => void
  onMailLeave: (event: DragEvent<HTMLDivElement>) => void
  onMailDrop: (event: DragEvent<HTMLDivElement>, id: string) => void
}) {
  const { t } = useI18n()
  const id = useId()
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [input, setInput] = useState<ProjectInput>({ id: '', name: '', color: 'blue' })
  const [position, setPosition] = useState(0)
  const [positionChanged, setPositionChanged] = useState(false)
  const [expectedRevision, setExpectedRevision] = useState(revision)
  const [error, setError] = useState('')
  const [collapsed, setCollapsed] = useState<string[]>([])
  const [dragging, setDragging] = useState<string | null>(null)
  const [target, setTarget] = useState<{ id: string; placement: 'before' | 'inside' | 'after' } | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const codeInput = useRef<HTMLInputElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const dragged = useRef<string | null>(null)
  const keyboardHandle = useRef<HTMLButtonElement | null>(null)
  const manual = sortProjects(mailbox.projects, 'manual', order)
  const visible = projectTree(mailbox.projects, sort, order, collapsed, query)
  const siblings = manual.filter((item) => (item.parentId ?? null) === (input.parentId ?? null))
  const siblingCount = siblings.filter((item) => item.id !== editingId).length
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

  function open(project?: Project, parentId: string | null = null) {
    setExpanded(true)
    setEditingId(project?.id ?? null)
    setInput(project ?? { id: parentId ? `f_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}` : '', name: '', color: 'blue', parentId })
    setPosition(project ? manual.filter((item) => (item.parentId ?? null) === (project.parentId ?? null)).findIndex((item) => item.id === project.id) : manual.filter((item) => (item.parentId ?? null) === parentId).length)
    setPositionChanged(false)
    setExpectedRevision(revision)
    setError('')
    if (!dialog.current!.open) dialog.current!.showModal()
    if (project || parentId) nameInput.current!.focus()
    else codeInput.current!.focus()
  }

  function finishDrag() { dragged.current = null; setDragging(null); setTarget(null) }

  return <section className="folder-section" data-expanded={expanded} aria-label={t("Dossiers de projets")}>
    <div className="folder-heading"><h2>{t("Dossiers")} <span>{mailbox.projects.length}</span></h2><button className="mobile-section-toggle" aria-label={t("Afficher les dossiers")} aria-expanded={expanded} aria-controls={`${id}-folders`} onClick={() => setExpanded(!expanded)}><Icon name="chevron" /></button><button className="folder-add icon-button" aria-label={t("Créer un dossier")} title={t("Créer un dossier")} disabled={disabled} onClick={() => open()}><Icon name="plus" /></button></div>
    <div className="folder-content" id={`${id}-folders`}>
    <div className="folder-tools">
      <div className="folder-search"><Icon name="search" /><input aria-label={t("Rechercher un dossier")} placeholder={t("Code ou nom du dossier…")} value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      <label className="folder-sort"><span className="sr-only">{t("Trier les dossiers")}</span><select aria-label={t("Trier les dossiers")} value={sort} disabled={disabled} onChange={(event) => onSort(event.target.value as ProjectSort)}>{Object.entries(projectSorts).map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}</select><span className="shared-label" title={t("Réglages communs à toute l’équipe")}><Icon name="users" /></span></label>
    </div>
    <p className="folder-hint">{sort !== 'manual' ? t("Tri partagé avec l’équipe") : query.trim() ? t("Effacez la recherche pour réordonner") : t("Glisser la poignée pour réordonner")}</p>
    <nav className="project-nav" aria-label={t("Projets")}>
      {visible.map(({ project, depth }) => {
        const count = mailbox.conversations.filter((item) => item.projectId === project.id || projectPath(mailbox.projects, item.projectId).startsWith(`${projectPath(mailbox.projects, project.id)} /`)).length
        const hasChildren = mailbox.projects.some((item) => item.parentId === project.id)
        const siblingRows = manual.filter((item) => (item.parentId ?? null) === (project.parentId ?? null))
        const index = siblingRows.findIndex((item) => item.id === project.id)
        return <div key={project.id} data-project-id={project.id} data-depth={depth} className={`folder-row ${currentId === project.id ? 'selected' : ''} ${dragging === project.id ? 'folder-dragging' : ''} ${target?.id === project.id ? `insert-${target.placement}` : ''} ${dropTarget === project.id ? 'drop-target' : ''} ${movingMail ? 'drop-available' : ''}`} style={{ marginLeft: depth * 12 }}
          onDragOver={(event) => {
            if (!dragged.current) { onMailOver(event, project.id); return }
            if (!canReorder || dragged.current === project.id || projectPath(mailbox.projects, project.id).startsWith(`${projectPath(mailbox.projects, dragged.current)} /`)) return
            event.preventDefault(); event.dataTransfer.dropEffect = 'move'
            const rect = event.currentTarget.getBoundingClientRect()
            const ratio = (event.clientY - rect.top) / rect.height
            setTarget({ id: project.id, placement: ratio < .25 ? 'before' : ratio > .75 ? 'after' : 'inside' })
          }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTarget(null); onMailLeave(event) }}
          onDrop={(event) => {
            if (!dragged.current) { onMailDrop(event, project.id); return }
            event.preventDefault()
            if (canReorder && target?.id === project.id) { void onReorder(dragged.current, project.id, target.placement); if (target.placement === 'inside') setCollapsed((current) => current.filter((item) => item !== project.id)) }
            finishDrag()
          }}>
          {sort === 'manual' ? <button className="folder-grip" draggable={canReorder} disabled={!canReorder} aria-label={t("Réordonner {0}", projectPath(mailbox.projects, project.id))} aria-describedby={`${id}-reorder-help`} title={t("Glisser, ou utiliser les flèches ↑ ↓ au clavier")}
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
              const next = siblingRows[index + (event.key === 'ArrowUp' ? -1 : 1)]
              if (next) { keyboardHandle.current = event.currentTarget; void onReorder(project.id, next.id, event.key === 'ArrowDown' ? 'after' : 'before') }
            }}><Icon name="grip" /></button> : null}
          {hasChildren ? <button className="folder-collapse" aria-label={`${collapsed.includes(project.id) ? t("Déplier") : t("Replier")} ${project.name}`} aria-expanded={!collapsed.includes(project.id)} onClick={() => setCollapsed((current) => current.includes(project.id) ? current.filter((item) => item !== project.id) : [...current, project.id])}><Icon name="chevron" /></button> : <span className="folder-branch" aria-hidden="true" />}
          <button className="project-button" aria-current={currentId === project.id ? 'page' : undefined} onClick={() => onSelect(project.id)} title={projectPath(mailbox.projects, project.id)}>
            <span className="folder-icon" style={{ color: projectColor(project.color) }}><Icon name="folder" /></span>
            <span className="folder-text">{!project.parentId && project.code !== null ? <small>{project.code ?? project.id}</small> : null}<span>{project.name}</span></span>
            <b aria-label={t("{0} conversation{1}", count, count > 1 ? 's' : '')}>{count}</b>
          </button>
          <button className="folder-edit icon-button" aria-label={t("Modifier le dossier {0}", projectPath(mailbox.projects, project.id))} title={t("Modifier le dossier")} disabled={disabled} onClick={() => open(project)}><Icon name="edit" /></button>
        </div>
      })}
      {!visible.length ? <p className="folder-no-results" role="status">{t("Aucun dossier trouvé.")}</p> : null}
    </nav>
    </div>
    <span className="sr-only" id={`${id}-reorder-help`}>{t("Utilisez les flèches haut et bas pour déplacer ce dossier. Vous pouvez aussi choisir sa position dans Modifier le dossier.")}</span>
    <dialog className="folder-dialog" ref={dialog} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}>
      <form onSubmit={async (event) => {
        event.preventDefault()
        const failure = await onSave(input, editingId, positionChanged ? position : null, expectedRevision)
        if (failure) { setError(failure.message); setExpectedRevision(failure.revision) }
        else dialog.current!.close()
      }}>
        <header><div><span className="eyebrow">{t("Dossier de projet")}</span><h2 id={`${id}-title`}>{editingId ? t("Modifier le dossier") : t("Créer un dossier")}</h2></div><button className="icon-button" type="button" aria-label={t("Fermer")} onClick={() => dialog.current!.close()}><Icon name="close" /></button></header>
        <p id={`${id}-description`}>{t("Nom, couleur et position partagés avec toute l’équipe.")}</p>
        {!input.parentId && (!editingId || mailbox.projects.find((item) => item.id === editingId)?.code !== null) ? <label className="dialog-field" htmlFor={`${id}-code`}>{t("Code du projet")}<input id={`${id}-code`} ref={codeInput} value={input.id} required maxLength={32} readOnly={!!editingId} placeholder={t("Ex. 2401")} onChange={(event) => setInput({ ...input, id: event.target.value })} />{editingId ? <small>{t("Le code reste identique pour conserver les échanges associés.")}</small> : <small>{t("Lettres, chiffres, tirets et points. Un code unique par dossier.")}</small>}</label> : null}
        <label className="dialog-field" htmlFor={`${id}-name`}>{input.parentId ? t("Nom du sous-dossier") : t("Nom du projet")}<input id={`${id}-name`} ref={nameInput} value={input.name} required maxLength={100} placeholder={t("Ex. Infrastructure")} onChange={(event) => setInput({ ...input, name: event.target.value })} /></label>
        <label className="dialog-field">{t("Dossier parent")}<select value={input.parentId ?? ''} onChange={(event) => {
          const parentId = event.target.value || null
          setInput({ ...input, parentId, id: !editingId && parentId && !input.id ? `f_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}` : input.id })
          setPosition(manual.filter((item) => item.id !== editingId && (item.parentId ?? null) === parentId).length); setPositionChanged(true)
        }}><option value="">{t("Racine · projet")}</option>{mailbox.projects.filter((item) => item.id !== editingId && (!editingId || !projectPath(mailbox.projects, item.id).startsWith(`${projectPath(mailbox.projects, editingId)} /`))).map((item) => <option key={item.id} value={item.id}>{projectPath(mailbox.projects, item.id)}</option>)}</select></label>
        <fieldset className="folder-colors"><legend>{t("Couleur du dossier")}</legend><div className="color-options">{Object.entries(projectColors).map(([key, color]) => <label className="color-swatch" title={t(colorNames[key as keyof typeof colorNames])} key={key}><input className="sr-only" type="radio" name={`${id}-color`} value={key} aria-label={t(colorNames[key as keyof typeof colorNames])} checked={input.color === key} onChange={() => setInput({ ...input, color: key })} /><span style={{ backgroundColor: color }} /></label>)}<label className="custom-color" title={t("Couleur personnalisée")}><input type="color" aria-label={t("Couleur personnalisée")} value={projectColor(input.color)} onChange={(event) => setInput({ ...input, color: event.target.value })} /><span>{t("Personnalisée")}</span></label></div></fieldset>
        <label className="dialog-field" htmlFor={`${id}-position`}>{t("Position dans l’ordre manuel")}<select id={`${id}-position`} value={positionChanged ? Math.min(position, siblingCount) : editingId ? siblings.findIndex((item) => item.id === editingId) : siblings.length} onChange={(event) => { setPosition(Number(event.target.value)); setPositionChanged(true) }}>{Array.from({ length: siblingCount + 1 }, (_, index) => <option key={index} value={index}>{index + 1}{index === 0 ? t(" · En premier") : index === siblingCount ? t(" · En dernier") : ''}</option>)}</select></label>
        <div className="folder-preview"><span className="folder-icon" style={{ color: projectColor(input.color) }}><Icon name="folder" /></span><span>{!input.parentId ? <small>{input.id.trim() || 'CODE'}</small> : <small>{projectPath(mailbox.projects, input.parentId)}</small>}<strong>{input.name.trim() || t("Nom du projet")}</strong></span></div>
        {error ? <p className="dialog-error" role="alert">{error}</p> : null}
        {error && sharedProject ? <div className="folder-conflict"><span>{t("Version partagée actuelle")}</span><p><span className="project-dot" style={{ backgroundColor: projectColor(sharedProject.color) }} />{sharedProject.id} — {sharedProject.name}</p><button className="secondary-button" type="button" onClick={() => open(sharedProject)}>{t("Charger cette version")}</button></div> : null}
        <footer>{editingId ? <><button className="danger-button" type="button" disabled={disabled || !allowDelete} title={!allowDelete ? t("Supprimez les dossiers IMAP depuis votre client mail après vérification.") : undefined} onClick={async () => {
          if (!window.confirm(t("Supprimer « {0} » ? Le dossier doit être vide et sans sous-dossier.", input.name))) return
          const failure = await onDelete(editingId, expectedRevision)
          if (failure) { setError(failure.message); setExpectedRevision(failure.revision) } else dialog.current!.close()
        }}>{t("Supprimer")}</button><button className="secondary-button" type="button" disabled={disabled} onClick={() => open(undefined, editingId)}>{t("Sous-dossier")}</button></> : null}<button className="secondary-button" type="button" onClick={() => dialog.current!.close()}>{t("Annuler")}</button><button className="primary-button" type="submit" disabled={disabled}>{disabled ? t("Enregistrement…") : editingId ? t("Enregistrer") : t("Créer le dossier")}</button></footer>
      </form>
    </dialog>
  </section>
}
