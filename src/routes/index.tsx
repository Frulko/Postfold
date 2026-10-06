import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { filterConversations, moveConversations, updateSelection } from '../lib/mailbox'
import { getDemoMailbox, saveProjectSettings, updateConversationState } from '../server/demo'
import { Icon } from '../components/icon'
import { ProjectPicker } from '../components/project-picker'
import { MailboxRefresh } from '../components/mailbox-refresh'
import { ProjectFolders, type FolderFailure } from '../components/project-folders'
import { positionProject, prepareProject, projectColor, sortProjects, type ProjectInput, type ProjectSort } from '../../shared/projects'
import type { ConversationPatch, ConversationState, ProjectSettings } from '../../shared/mailbox'
import { applyConversationStates, conversationStatuses as statuses, mergeConversationStates } from '../../shared/conversation-state'
import { ConversationActions } from '../components/conversation-actions'

export const Route = createFileRoute('/')({ loader: () => getDemoMailbox(), component: MailboxPage })

type Note = { id: string; contactId: string; body: string; createdAt: string }
type LocalData = { notes: Note[]; drafts: Record<string, string>; placements?: Record<string, string> }
const storageKey = 'mailer-support:demo:v1'
const initials = (name: string) => name.split(' ').map((part) => part[0]).slice(0, 2).join('')
const demoPresence = [
  { name: 'Julie', initials: 'JD', state: 'online', activity: 'Disponible' },
  { name: 'Marc', initials: 'ML', state: 'busy', activity: 'Rédige une réponse' },
  { name: 'Emma', initials: 'EM', state: 'online', activity: 'Disponible' },
]

function isLocalData(value: unknown): value is LocalData {
  if (!value || typeof value !== 'object' || !('notes' in value) || !('drafts' in value)) return false
  return Array.isArray(value.notes) && value.notes.every((note) =>
    note && typeof note.id === 'string' && typeof note.contactId === 'string' &&
    typeof note.body === 'string' && typeof note.createdAt === 'string' &&
    Number.isFinite(Date.parse(note.createdAt))) &&
    !!value.drafts && typeof value.drafts === 'object' && !Array.isArray(value.drafts) &&
    Object.values(value.drafts).every((draft) => typeof draft === 'string') &&
    (!('placements' in value) || (!!value.placements && typeof value.placements === 'object' &&
      !Array.isArray(value.placements) && Object.values(value.placements).every((id) => typeof id === 'string')))
}

function MailboxPage() {
  const initialMailbox = Route.useLoaderData()
  const latestStates = useRef(initialMailbox.conversationStates)
  const stateQueue = useRef(Promise.resolve())
  const stateJobs = useRef(0)
  const [baseMailbox, setBaseMailbox] = useState(initialMailbox)
  const refreshMailbox = useCallback(async () => {
    const freshMailbox = await getDemoMailbox()
    const states = mergeConversationStates(latestStates.current, freshMailbox.conversationStates)
    latestStates.current = states
    setBaseMailbox((current) => ({ ...freshMailbox,
      projects: freshMailbox.projectSettings.revision >= current.projectSettings.revision ? freshMailbox.projects : current.projects,
      projectSettings: freshMailbox.projectSettings.revision >= current.projectSettings.revision ? freshMailbox.projectSettings : current.projectSettings,
      conversationStates: states, conversations: applyConversationStates(freshMailbox.conversations, states),
    }))
  }, [])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [view, setView] = useState<'mail' | 'contacts'>('mail')
  const [status, setStatus] = useState('all')
  const [selectedId, setSelectedId] = useState('plans')
  const [contactId, setContactId] = useState('paul')
  const [composerOpen, setComposerOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({})
  const [local, setLocal] = useState<LocalData>({ notes: [], drafts: {} })
  const [storageReady, setStorageReady] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [chosenIds, setChosenIds] = useState<string[]>([])
  const [bulkOpen, setBulkOpen] = useState(false)
  const [draggingIds, setDraggingIds] = useState<string[]>([])
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [folderBusy, setFolderBusy] = useState(false)
  const [folderFeedback, setFolderFeedback] = useState('')
  const [folderFailed, setFolderFailed] = useState(false)
  const [stateBusy, setStateBusy] = useState(false)
  const [conversationFeedback, setConversationFeedback] = useState('')
  const [conversationFailed, setConversationFailed] = useState(false)
  const folderWrite = useRef(false)
  const selectionAnchor = useRef<string | null>(null)
  const dragSession = useRef<string[]>([])
  const ghostTemplate = useRef<HTMLDivElement>(null)
  const selectAllControl = useRef<HTMLInputElement>(null)
  const bulkTools = useRef<HTMLDivElement>(null)
  const bulkTrigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!bulkOpen) return
    const closeOutside = (event: PointerEvent) => { if (!bulkTools.current?.contains(event.target as Node)) setBulkOpen(false) }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [bulkOpen])

  useEffect(() => {
    try {
      const stored = localStorage.getItem(storageKey)
      if (stored) {
        const parsed: unknown = JSON.parse(stored)
        if (!isLocalData(parsed)) throw new Error('Données locales non reconnues.')
        setLocal(parsed)
      }
      setStorageReady(true)
    } catch {
      setError('Impossible de lire les données locales. Elles ont été conservées ; les nouvelles écritures sont désactivées.')
    }
  }, [])

  function save(next: LocalData) {
    if (!storageReady) return false
    try {
      localStorage.setItem(storageKey, JSON.stringify(next))
      setLocal(next)
      setError('')
      return true
    } catch {
      setError('L’enregistrement local a échoué. Votre saisie reste affichée : copiez-la avant de quitter cette page.')
      return false
    }
  }

  const mailbox = { ...baseMailbox, conversations: baseMailbox.conversations.map((item) => {
    const placement = local.placements?.[item.id]
    return placement && baseMailbox.projects.some((project) => project.id === placement) ? { ...item, projectId: placement } : item
  }) }
  const conversations = filterConversations(mailbox, projectId, query)
    .filter((item) => status === 'all' || (status === 'unread' ? item.unread : item.status === status))
  const conversation = mailbox.conversations.find((item) => item.id === selectedId)!
  const contact = mailbox.contacts.find((item) => item.id === (view === 'mail' ? conversation.contactId : contactId))!
  const project = mailbox.projects.find((item) => item.id === conversation.projectId)!
  const selectedProject = mailbox.projects.find((item) => item.id === projectId)
  const showConversation = !projectId || conversation.projectId === projectId
  const folderSettings: ProjectSettings = { ...baseMailbox.projectSettings, projects: mailbox.projects }
  const contactNotes = local.notes.filter((item) => item.contactId === contact.id)
  const note = noteDrafts[contact.id] ?? ''
  const setNote = (body: string) => setNoteDrafts((current) => ({ ...current, [contact.id]: body }))
  const visibleIds = conversations.map((item) => item.id)
  const chosen = chosenIds.filter((id) => visibleIds.includes(id))
  const allChosen = conversations.length > 0 && chosen.length === conversations.length

  function acceptStates(incoming: ConversationState[]) {
    const states = mergeConversationStates(latestStates.current, incoming)
    latestStates.current = states
    setBaseMailbox((current) => ({ ...current, conversationStates: states, conversations: applyConversationStates(current.conversations, states) }))
  }

  function changeConversations(ids: string[], patch: ConversationPatch, announce = true): Promise<boolean> {
    const selected = [...new Set(ids)]
    stateJobs.current += 1
    setStateBusy(true)
    // Les ouvertures rapides sont exécutées dans l’ordre, avec les dernières révisions reçues.
    const attempt = stateQueue.current.then(async () => {
      try {
        const states = selected.map((id) => latestStates.current.find((item) => item.id === id))
        if (!states.length || states.some((item) => !item)) throw new Error('Une conversation n’existe plus.')
        const current = states as ConversationState[]
        const result = await updateConversationState({ data: { targets: current.map(({ id, revision }) => ({ id, revision })), ...patch } })
        if (result.states) acceptStates(result.states)
        if (!result.ok) {
          setConversationFailed(true)
          setConversationFeedback(result.error ?? 'La modification a échoué.')
          return false
        }
        if (announce) {
          const label = patch.unread !== undefined ? patch.unread ? 'Non lu' : 'Lu' : statuses[patch.status!]
          setConversationFailed(false)
          setConversationFeedback(`${selected.length} conversation${selected.length > 1 ? 's' : ''} : ${label}. État enregistré pour toute l’équipe.`)
        }
        return true
      } catch {
        setConversationFailed(true)
        setConversationFeedback('Impossible de confirmer la modification. Les données affichées sont conservées ; vérifiez les états à la relève avant de réessayer.')
        return false
      } finally { stateJobs.current -= 1; setStateBusy(stateJobs.current > 0) }
    })
    stateQueue.current = attempt.then(() => {})
    return attempt
  }

  // L’échange déjà affiché à l’arrivée est une ouverture. Les changements lu/non lu ne relancent pas cet effet.
  useEffect(() => { void changeConversations(['plans'], { unread: false }, false) }, [])

  function clearSelection() {
    setChosenIds([])
    setBulkOpen(false)
    selectionAnchor.current = null
  }

  function choose(id: string, checked: boolean, range: boolean) {
    setBulkOpen(false)
    const anchor = selectionAnchor.current
    setChosenIds((current) => updateSelection(current, visibleIds, id, checked, anchor, range))
    if (!range || !selectionAnchor.current) selectionAnchor.current = id
  }

  function move(ids: string[], targetId: string) {
    if (!ids.length) return false
    try {
      const nextMailbox = moveConversations(mailbox, ids, targetId)
      const changed = nextMailbox.conversations.filter((item) => ids.includes(item.id) &&
        mailbox.conversations.find((previous) => previous.id === item.id)?.projectId !== item.projectId)
      if (!changed.length) { setNotice('Ces conversations sont déjà dans ce projet.'); return true }
      const next: LocalData = {
        ...local,
        placements: { ...local.placements, ...Object.fromEntries(changed.map((item) => [item.id, item.projectId])) },
        drafts: composerOpen ? { ...local.drafts, [conversation.id]: draft } : local.drafts,
      }
      if (!save(next)) return false
      if (document.activeElement?.getAttribute('role') === 'combobox') selectAllControl.current?.focus()
      clearSelection()
      const target = mailbox.projects.find((item) => item.id === targetId)!
      setNotice(`${changed.length} conversation${changed.length > 1 ? 's déplacées' : ' déplacée'} vers ${target.id} — ${target.name}. Déplacement enregistré localement.`)
      return true
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Le déplacement a échoué.')
      return false
    }
  }

  function finishDrag() {
    dragSession.current = []
    setDraggingIds([])
    setDropTarget(null)
  }

  function startDrag(event: DragEvent<HTMLDivElement>, id: string) {
    if (!storageReady || (event.target as HTMLElement).closest('.selection-hit')) { event.preventDefault(); return }
    const ids = chosen.includes(id) ? chosen : [id]
    dragSession.current = ids
    setDraggingIds(ids)
    setBulkOpen(false)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('application/x-courrier-conversations', JSON.stringify(ids))
    const ghost = ghostTemplate.current!.cloneNode(true) as HTMLDivElement
    ghost.hidden = false
    ghost.querySelector('.ghost-title')!.textContent = ids.length === 1 ? mailbox.conversations.find((item) => item.id === id)!.subject : `${ids.length} conversations`
    ghost.querySelector('.ghost-count')!.textContent = String(ids.length)
    ghost.classList.toggle('ghost-multiple', ids.length > 1)
    document.body.append(ghost)
    event.dataTransfer.setDragImage(ghost, 20, 24)
    // Le navigateur capture le ghost à la fin de dragstart, avant son retrait.
    setTimeout(() => ghost.remove(), 0)
  }

  function preserveDraft() {
    return !composerOpen || draft === (local.drafts[conversation.id] ?? '') ||
      save({ ...local, drafts: { ...local.drafts, [conversation.id]: draft } })
  }

  function openConversation(id: string) {
    if (!preserveDraft()) return false
    setSelectedId(id)
    setComposerOpen(false)
    setNotice('')
    void changeConversations([id], { unread: false }, false)
    return true
  }

  function selectProject(id: string | null, threadId?: string) {
    const first = threadId ?? filterConversations(mailbox, id, query)[0]?.id
    if (first ? !openConversation(first) : !preserveDraft()) return
    setProjectId(id)
    setView('mail')
    setStatus('all')
    setComposerOpen(false)
    clearSelection()
  }

  async function commitFolders(next: ProjectSettings): Promise<FolderFailure | null> {
    if (folderWrite.current) return { message: 'Un enregistrement est déjà en cours.', revision: next.revision }
    folderWrite.current = true
    setFolderBusy(true)
    try {
      const result = await saveProjectSettings({ data: next })
      if (result.settings) {
        const settings = result.settings
        setBaseMailbox((current) => settings.revision >= current.projectSettings.revision ?
          { ...current, projects: settings.projects, projectSettings: { revision: settings.revision, sort: settings.sort, order: settings.order } } : current)
      }
      const failure = result.ok ? null : result.error ?? 'L’enregistrement partagé a échoué.'
      setFolderFailed(!!failure)
      setFolderFeedback(failure ?? 'Dossiers et réglages enregistrés pour toute l’équipe.')
      return failure ? { message: failure, revision: result.settings?.revision ?? next.revision } : null
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : 'L’enregistrement partagé a échoué. Votre saisie est conservée.'
      setFolderFailed(true); setFolderFeedback(message)
      return { message, revision: next.revision }
    } finally { folderWrite.current = false; setFolderBusy(false) }
  }

  async function saveFolder(input: ProjectInput, editingId: string | null, position: number | null, revision: number) {
    try {
      const folder = prepareProject(input, mailbox.projects, editingId)
      const manual = sortProjects(mailbox.projects, 'manual', folderSettings.order)
      const projects = editingId ? manual.map((item) => item.id === editingId ? folder : item) : [...manual, folder]
      const ordered = position === null ? projects : positionProject(projects, folder.id, Math.min(position, projects.length - 1))
      return await commitFolders({ ...folderSettings, revision, projects: ordered, order: ordered.map((item) => item.id) })
    } catch (failure) { return { message: failure instanceof Error ? failure.message : 'Dossier invalide.', revision } }
  }

  async function reorderFolder(id: string, targetId: string, after: boolean) {
    const manual = sortProjects(mailbox.projects, 'manual', folderSettings.order)
    const sourceIndex = manual.findIndex((item) => item.id === id)
    const targetIndex = manual.findIndex((item) => item.id === targetId)
    if (sourceIndex < 0 || targetIndex < 0 || id === targetId) return false
    const insertion = targetIndex + (after ? 1 : 0)
    const position = insertion - (sourceIndex < insertion ? 1 : 0)
    const projects = positionProject(manual, id, position)
    return !(await commitFolders({ ...folderSettings, order: projects.map((item) => item.id) }))
  }

  function sortFolders(sort: ProjectSort) { void commitFolders({ ...folderSettings, sort }) }

  return (
    <div className="workspace">
      <aside className="sidebar" aria-label="Navigation principale">
        <a className="brand" href="/" aria-label="Postfold, accueil"><span className="brand-mark"><Icon name="mail" /></span>Postfold<span className="brand-label">Support</span></a>
        <div className="workspace-name"><span className="workspace-avatar">S</span><div>Équipe support<small>Espace de démonstration</small></div></div>
        <nav className="main-nav">
          <button className={view === 'mail' && !projectId ? 'nav-button active' : 'nav-button'} onClick={() => selectProject(null)}><Icon name="mail" />Boîte de réception<b>{mailbox.conversations.length}</b></button>
          <button className={view === 'contacts' ? 'nav-button active' : 'nav-button'} onClick={() => { if (!preserveDraft()) return; setView('contacts'); setComposerOpen(false); setNotice(''); clearSelection() }}><Icon name="users" />Contacts<b>{mailbox.contacts.length}</b></button>
        </nav>
        <ProjectFolders mailbox={mailbox} revision={folderSettings.revision} currentId={view === 'mail' ? projectId : null} sort={folderSettings.sort} order={folderSettings.order} disabled={folderBusy} dropTarget={dropTarget} movingMail={!!draggingIds.length}
          onSelect={selectProject} onSave={saveFolder} onSort={sortFolders} onReorder={reorderFolder}
          onMailOver={(event, id) => { if (!dragSession.current.length) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(id) }}
          onMailLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null) }}
          onMailDrop={(event, id) => { if (!dragSession.current.length) return; event.preventDefault(); move(dragSession.current, id); finishDrag() }} />
        {folderFeedback ? <p className={`folder-feedback ${folderFailed ? 'failed' : ''}`} role={folderFailed ? 'alert' : 'status'}>{folderFeedback}</p> : null}
        <div className="sidebar-bottom"><span className="user-avatar">JD</span><div>Julie · Démo<small>Votre espace de travail</small></div></div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="breadcrumb"><span>Support</span><Icon name="chevron" /><strong>{view === 'contacts' ? 'Contacts' : selectedProject?.name ?? 'Tous les échanges'}</strong></div>
          <div className="header-indicators">
            <MailboxRefresh onRefresh={refreshMailbox} />
            <div className="presence-group">
              <ul className="presence-list" aria-label="Présences de démonstration">
                {demoPresence.map((person) => <li className="presence-item" key={person.name}>
                  <span className={`presence-avatar ${person.state}`} role="img" tabIndex={0} aria-label={`${person.name} : ${person.activity}, présence simulée`} aria-describedby={`presence-${person.name}`}>
                    {person.initials}<span className="presence-dot" aria-hidden="true" />
                  </span>
                  <span className="presence-tooltip" id={`presence-${person.name}`} role="tooltip"><strong>{person.name}</strong><small>{person.activity} · Démo</small></span>
                </li>)}
              </ul>
              <span className="presence-count">{demoPresence.length} en ligne <span className="sr-only">dans la démonstration</span></span>
            </div>
            <span className="demo-badge">Démonstration</span>
          </div>
        </header>
        <div className="demo-banner"><Icon name="info" /><span>Dossiers, lecture et suivi partagés avec l’équipe. Aucune boîte mail connectée ; notes, brouillons et déplacements restent locaux dans cette démo.</span></div>
        {error ? <div role="alert" className="error-banner">{error}</div> : null}
        {conversationFeedback ? <div role={conversationFailed ? 'alert' : 'status'} className={`conversation-feedback ${conversationFailed ? 'failed' : ''}`}>{conversationFeedback}</div> : null}
        <div className="content-grid">
          <section className="conversation-list" aria-label={view === 'contacts' ? 'Liste des contacts' : 'Liste des conversations'} onKeyDown={(event) => {
            if (view !== 'mail' || (event.target as HTMLElement).closest('textarea, select, input:not([type="checkbox"])')) return
            if (event.key === 'Escape') clearSelection()
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); setChosenIds(visibleIds) }
          }}>
            <div className="list-heading"><span className="eyebrow">{view === 'contacts' ? 'Carnet d’adresses' : 'Conversations'}</span><h1>{view === 'contacts' ? 'Contacts' : selectedProject ? `${selectedProject.id} — ${selectedProject.name}` : 'Boîte de réception'}</h1></div>
            {view === 'mail' ? <>
              <div className="search-field"><Icon name="search" /><input aria-label="Rechercher les échanges" placeholder="Rechercher un échange…" value={query} onChange={(event) => { setQuery(event.target.value); clearSelection() }} /></div>
              <div className="filters" role="group" aria-label="État des conversations">{[['all', 'Tous'], ['unread', 'Non lus'], ['open', 'À traiter'], ['waiting', 'En attente'], ['closed', 'Terminés']].map(([key, label]) => <button key={key} aria-pressed={status === key} onClick={() => { setStatus(key); clearSelection() }}>{label}</button>)}</div>
              <div className="list-tools" ref={bulkTools} onKeyDown={(event) => {
                if (event.key === 'Escape' && !event.defaultPrevented && bulkOpen) {
                  event.preventDefault(); event.stopPropagation(); setBulkOpen(false); bulkTrigger.current?.focus()
                }
              }}>
                <label className="selection-hit"><input type="checkbox" aria-label="Sélectionner toutes les conversations affichées" checked={allChosen} disabled={!conversations.length} ref={(node) => { selectAllControl.current = node; if (node) node.indeterminate = chosen.length > 0 && !allChosen }} onChange={(event) => { setBulkOpen(false); setChosenIds(event.target.checked ? visibleIds : []); selectionAnchor.current = null }} /></label>
                <span aria-live="polite">{chosen.length ? `${chosen.length} sélectionnée${chosen.length > 1 ? 's' : ''}` : `${conversations.length} conversation${conversations.length > 1 ? 's' : ''}`}</span>
                {chosen.length ? <>
                  <button className="bulk-trigger" ref={bulkTrigger} aria-expanded={bulkOpen} aria-controls={bulkOpen ? 'bulk-actions' : undefined} onClick={() => setBulkOpen(!bulkOpen)}>Actions<Icon name="chevron" /></button>
                  <button className="clear-selection" aria-label="Annuler la sélection" onClick={clearSelection}><Icon name="close" /></button>
                  {bulkOpen ? <div className="bulk-actions" id="bulk-actions" role="group" aria-label="Actions du lot"><ConversationActions disabled={stateBusy} onChange={(patch) => changeConversations(chosen, patch)} /><ProjectPicker projects={sortProjects(mailbox.projects, folderSettings.sort, folderSettings.order)} disabled={!storageReady} onSelect={(targetId) => move(chosen, targetId)} /><small>Maj : sélectionner une plage · Ctrl / ⌘ : ajouter</small></div> : null}
                </> : null}
              </div>
              {conversations.length ? conversations.map((item) => {
                const sender = mailbox.contacts.find((person) => person.id === item.contactId)!
                const folder = mailbox.projects.find((folder) => folder.id === item.projectId)!
                return <div key={item.id} data-conversation-id={item.id} className={`thread-row ${item.unread ? 'unread' : ''} ${selectedId === item.id ? 'selected' : ''} ${chosen.includes(item.id) ? 'checked' : ''} ${draggingIds.includes(item.id) ? 'dragging' : ''}`} draggable={storageReady} onDragStart={(event) => startDrag(event, item.id)} onDragEnd={finishDrag}>
                  <label className="selection-hit row-selection"><input type="checkbox" aria-label={`Sélectionner ${item.subject}`} checked={chosen.includes(item.id)} onChange={(event) => choose(item.id, event.target.checked, event.nativeEvent instanceof MouseEvent && event.nativeEvent.shiftKey)} /></label>
                  <button className="thread-open" aria-pressed={selectedId === item.id} onClick={(event) => {
                    if (event.shiftKey || event.metaKey || event.ctrlKey) { choose(item.id, event.shiftKey || !chosen.includes(item.id), event.shiftKey); return }
                    if (openConversation(item.id)) { clearSelection(); selectionAnchor.current = item.id }
                  }}>
                  <div className="row-top"><strong>{sender.name}</strong><time>{item.time}</time></div>
                  <div className="row-subject">{item.unread ? <span className="unread-dot" title="Non lu"><span className="sr-only">Non lu : </span></span> : <span className="sr-only">Lu : </span>}{item.subject}</div>
                  <p>{item.preview}</p><div className="row-bottom"><span className="folder-label">{folder.id} · {folder.name}</span><span className={`status ${item.status}`}>{statuses[item.status]}</span></div>
                  </button>
                </div>
              }) : <div className="empty-state">Aucun échange ne correspond à votre recherche.</div>}
            </> : mailbox.contacts.map((person) => <button className={`contact-row ${person.id === contactId ? 'selected' : ''}`} key={person.id} onClick={() => { setContactId(person.id); setNotice('') }}>
              <span className="contact-avatar">{initials(person.name)}</span><span><strong>{person.name}</strong><small>{person.company}</small></span><span className="contact-arrow"><Icon name="chevron" /></span>
            </button>)}
          </section>

          <section className="reading-pane" aria-label={view === 'mail' ? 'Conversation sélectionnée' : 'Historique du contact'}>
            {view === 'mail' ? showConversation ? <>
              <div className="reading-toolbar"><ConversationActions unread={conversation.unread} status={conversation.status} disabled={stateBusy} onChange={(patch) => changeConversations([conversation.id], patch)} /><span className="assignee">{conversation.assignee ? `Attribué à ${conversation.assignee}` : 'Non attribué'}</span></div>
              <div className="message-heading"><span className="eyebrow">{project.id} — {project.name}</span><h2>{conversation.subject}</h2><p>Un échange avec {contact.name}</p></div>
              <article className="message"><header><span className="contact-avatar">{initials(contact.name)}</span><div><strong>{contact.name}</strong><small>{contact.email}</small></div><time>{conversation.time}</time></header><div className="message-body">{conversation.body}</div></article>
              {composerOpen ? <form className="composer" onSubmit={(event) => { event.preventDefault(); if (save({ ...local, drafts: { ...local.drafts, [conversation.id]: draft } })) setNotice('Brouillon enregistré dans ce navigateur. Aucun email envoyé.') }}>
                <label htmlFor="reply">Votre brouillon <small>À : {contact.email}</small></label><textarea id="reply" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Bonjour…" rows={7} />
                <footer><span id="send-unavailable">Connectez une boîte mail pour envoyer.</span><div className="composer-actions"><button className="secondary-button" disabled={!storageReady} type="submit">Enregistrer le brouillon</button><button className="primary-button" type="button" disabled aria-describedby="send-unavailable" title="Aucune boîte mail connectée"><Icon name="send" />Envoyer</button></div></footer>
              </form> : <div className="reply-bar"><span>{local.drafts[conversation.id] ? 'Brouillon enregistré' : 'Aucune réponse préparée'}</span><button className="primary-button" onClick={() => { setDraft(local.drafts[conversation.id] ?? ''); setComposerOpen(true); setNotice('') }}><Icon name="reply" />{local.drafts[conversation.id] ? 'Reprendre le brouillon' : 'Préparer une réponse'}</button></div>}
            </> : <div className="empty-folder"><span className="empty-folder-icon" style={{ color: projectColor(selectedProject!.color) }}><Icon name="folder" /></span><span className="eyebrow">{selectedProject!.id} — {selectedProject!.name}</span><h2>Ce dossier est vide</h2><p>Déposez des conversations dans ce dossier ou utilisez « Déplacer vers un projet » depuis la boîte de réception.</p></div> : <div className="contact-history"><span className="eyebrow">Historique des échanges</span><h2>Les échanges avec {contact.name.split(' ')[0]}</h2><p>Tous les projets et conversations associés à ce contact.</p>{mailbox.conversations.filter((item) => item.contactId === contact.id).map((item) => <button className="history-item" key={item.id} onClick={() => selectProject(item.projectId, item.id)}><span><strong>{item.subject}</strong><small>{mailbox.projects.find((project) => project.id === item.projectId)?.name}</small></span><span className={`status ${item.status}`}>{statuses[item.status]}</span></button>)}</div>}
            {notice ? <p role="status" className="notice">{notice}</p> : null}
          </section>

          {view === 'contacts' || showConversation ? <aside className="contact-panel" aria-label="Fiche du contact">
            <span className="section-label">Fiche contact</span><div className="profile-avatar">{initials(contact.name)}</div><h2>{contact.name}</h2><p className="company">{contact.company}</p>
            <dl className="contact-details"><dt>Email</dt><dd>{contact.email}</dd><dt>Téléphone</dt><dd>{contact.phone}</dd></dl>
            <div className="panel-section"><h3>Projets associés</h3>{mailbox.projects.filter((item) => mailbox.conversations.some((thread) => thread.contactId === contact.id && thread.projectId === item.id)).map((item) => <button key={item.id} className="linked-project" onClick={() => selectProject(item.id)}><span className="project-dot" style={{ backgroundColor: projectColor(item.color) }} /><span>{item.id} — {item.name}</span><Icon name="arrow" /></button>)}</div>
            <div className="panel-section"><h3>Notes internes <span>{contactNotes.length}</span></h3>{contactNotes.map((item) => <article className="contact-note" key={item.id}><p>{item.body}</p><small>Julie · {new Date(item.createdAt).toLocaleDateString('fr-FR')}</small></article>)}
              <form onSubmit={(event) => { event.preventDefault(); const body = note.trim(); if (!body) return; if (save({ ...local, notes: [...local.notes, { id: crypto.randomUUID(), contactId: contact.id, body, createdAt: new Date().toISOString() }] })) { setNote(''); setNotice('Note enregistrée dans ce navigateur.') } }}>
                <label className="sr-only" htmlFor="contact-note">Ajouter une note sur {contact.name}</label><textarea id="contact-note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Un détail utile pour la prochaine fois…" rows={4} maxLength={5000} />
                <button className="note-button" disabled={!storageReady || !note.trim()} type="submit"><Icon name="plus" />Ajouter une note</button>
              </form><small className="private-hint">Visible ici uniquement · jamais envoyé au contact</small>
            </div>
          </aside> : null}
        </div>
      </main>
      <div className="drag-ghost" hidden ref={ghostTemplate} aria-hidden="true"><div className="ghost-card"><span className="ghost-icon"><Icon name="mail" /></span><div><strong className="ghost-title" /><small>Déplacer vers un projet</small></div><b className="ghost-count" /></div></div>
    </div>
  )
}
