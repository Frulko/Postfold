import { useI18n } from '../lib/i18n'
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { filterConversations, mailboxRows, threadKey, updateSelection } from '../lib/mailbox'
import { getDemoMailbox, saveProjectSettings, updateConversationState, syncMailbox, sendReply } from '../server/demo'
import { Icon } from '../components/icon'
import { ProjectPicker } from '../components/project-picker'
import { MailboxRefresh } from '../components/mailbox-refresh'
import { ProjectFolders, type FolderFailure } from '../components/project-folders'
import { prepareProject, projectColor, projectPath, sortProjects, type ProjectInput, type ProjectSort } from '../../shared/projects'
import type { ConversationPatch, ConversationState, ProjectSettings } from '../../shared/mailbox'
import { applyConversationStates, conversationStatuses as statuses, mergeConversationStates } from '../../shared/conversation-state'
import { ConversationActions } from '../components/conversation-actions'
import { LabelManager, LabelPicker } from '../components/labels'

export const Route = createFileRoute('/')({ loader: () => getDemoMailbox(), component: MailboxPage })

type Note = { id: string; contactId: string; body: string; createdAt: string }
type LocalData = { notes: Note[]; drafts: Record<string, string>; sendRequests?: Record<string, string>; placements?: Record<string, string>; displayMode?: 'messages' | 'threads' }
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
    (!('sendRequests' in value) || (!!value.sendRequests && typeof value.sendRequests === 'object' && !Array.isArray(value.sendRequests) && Object.values(value.sendRequests).every((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)))) &&
    (!('displayMode' in value) || value.displayMode === 'messages' || value.displayMode === 'threads') &&
    (!('placements' in value) || (!!value.placements && typeof value.placements === 'object' &&
      !Array.isArray(value.placements) && Object.values(value.placements).every((id) => typeof id === 'string')))
}

function MailboxPage() {
  const { t, locale } = useI18n()
  const navigate = Route.useNavigate()
  const initialMailbox = Route.useLoaderData()
  const storageKey = initialMailbox.connection ? `postfold:mailbox:${initialMailbox.connection.email}:v1` : 'mailer-support:demo:v1'
  const latestStates = useRef(initialMailbox.conversationStates)
  const stateQueue = useRef(Promise.resolve())
  const stateJobs = useRef(0)
  const [baseMailbox, setBaseMailbox] = useState(initialMailbox)
  const refreshMailbox = useCallback(async (synchronize = true) => {
    const freshMailbox = synchronize ? await syncMailbox() : await getDemoMailbox()
    const states = mergeConversationStates(latestStates.current, freshMailbox.conversationStates)
    latestStates.current = states
    setBaseMailbox((current) => ({ ...freshMailbox,
      projects: freshMailbox.projectSettings.revision >= current.projectSettings.revision ? freshMailbox.projects : current.projects,
      labels: freshMailbox.projectSettings.revision >= current.projectSettings.revision ? freshMailbox.labels : current.labels,
      projectSettings: freshMailbox.projectSettings.revision >= current.projectSettings.revision ? freshMailbox.projectSettings : current.projectSettings,
      conversationStates: states, conversations: applyConversationStates(freshMailbox.conversations, states),
    }))
  }, [])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [labelId, setLabelId] = useState<string | null>(null)
  const [view, setView] = useState<'mail' | 'contacts'>('mail')
  const [status, setStatus] = useState('all')
  const [selectedId, setSelectedId] = useState(initialMailbox.conversations[0]?.id ?? '')
  const [contactId, setContactId] = useState(initialMailbox.contacts[0]?.id ?? '')
  const [sendBusy, setSendBusy] = useState(false)
  const [composerOpen, setComposerOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({})
  const [local, setLocal] = useState<LocalData>({ notes: [], drafts: {} })
  const localRef = useRef(local)
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
        if (!isLocalData(parsed)) throw new Error(t("Données locales non reconnues."))
        setLocal(parsed)
        localRef.current = parsed
      }
      setStorageReady(true)
    } catch {
      setError(t("Impossible de lire les données locales. Elles ont été conservées ; les nouvelles écritures sont désactivées."))
    }
  }, [])

  function save(next: LocalData) {
    if (!storageReady) return false
    try {
      localStorage.setItem(storageKey, JSON.stringify(next))
      setLocal(next)
      localRef.current = next
      setError('')
      return true
    } catch {
      setError(t("L’enregistrement local a échoué. Votre saisie reste affichée : copiez-la avant de quitter cette page."))
      return false
    }
  }

  const mailbox = baseMailbox
  const activeLabel = mailbox.labels?.some((item) => item.id === labelId) ? labelId : null
  const conversations = filterConversations(mailbox, projectId, query)
    .filter((item) => (status === 'all' || (status === 'unread' ? item.unread : item.status === status)) && (!activeLabel || item.labelIds?.includes(activeLabel)))
  const displayMode = local.displayMode ?? 'messages'
  const rows = mailboxRows(conversations, displayMode)
  const conversation = mailbox.conversations.find((item) => item.id === selectedId) ?? mailbox.conversations[0] ?? { id: '', projectId: '', contactId: '', subject: '', preview: '', body: '', time: '', status: 'open' as const, assignee: null, unread: false }
  const contact = mailbox.contacts.find((item) => item.id === (view === 'mail' ? conversation.contactId : contactId)) ?? mailbox.contacts[0] ?? { id: '', name: '', email: '', company: '', phone: '' }
  const project = mailbox.projects.find((item) => item.id === conversation.projectId) ?? mailbox.projects[0]
  const selectedProject = mailbox.projects.find((item) => item.id === projectId)
  const threadMessages = displayMode === 'threads' ? mailbox.conversations.filter((item) => threadKey(item) === threadKey(conversation)).sort((a, b) => (Date.parse(a.sentAt ?? '') || 0) - (Date.parse(b.sentAt ?? '') || 0)) : [conversation]
  const readingIds = threadMessages.map((item) => item.id)
  const showConversation = mailbox.conversations.length > 0 && (!projectId || filterConversations(mailbox, projectId, '').some((item) => readingIds.includes(item.id)))
  const delivery = mailbox.deliveries?.find((item) => item.targetId === conversation.id)
  const currentConversation = useRef(conversation.id)
  currentConversation.current = conversation.id
  const folderSettings: ProjectSettings = { ...baseMailbox.projectSettings, projects: mailbox.projects, labels: mailbox.labels ?? [] }
  const contactNotes = local.notes.filter((item) => item.contactId === contact.id)
  const note = noteDrafts[contact.id] ?? ''
  const setNote = (body: string) => setNoteDrafts((current) => ({ ...current, [contact.id]: body }))
  const visibleIds = rows.map((item) => item.id)
  const chosen = chosenIds.filter((id) => visibleIds.includes(id))
  const allChosen = rows.length > 0 && chosen.length === rows.length
  const chosenMessages = expandRows(chosen)

  function expandRows(ids: string[]) {
    return [...new Set(ids.flatMap((id) => {
      const item = mailbox.conversations.find((item) => item.id === id)
      return displayMode === 'threads' && item ? mailbox.conversations.filter((message) => threadKey(message) === threadKey(item)).map((message) => message.id) : [id]
    }))]
  }

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
        if (!states.length || states.some((item) => !item)) throw new Error(t("Une conversation n’existe plus."))
        const current = states as ConversationState[]
        const result = await updateConversationState({ data: { targets: current.map(({ id, revision }) => ({ id, revision })), ...patch } })
        if (result.states) acceptStates(result.states)
        if (!result.ok) {
          setConversationFailed(true)
          setConversationFeedback(result.error ? t(result.error) : t("La modification a échoué."))
          return false
        }
        if (announce) {
          const label = patch.unread !== undefined ? patch.unread ? t("Non lu") : t("Lu") : patch.status ? t(statuses[patch.status]) : patch.projectId ? t("Déplacement") : t("Labels mis à jour")
          setConversationFailed(false)
          setConversationFeedback(t("{0} conversation{1} : {2}. État enregistré pour toute l’équipe.", selected.length, selected.length > 1 ? 's' : '', label))
        }
        return true
      } catch {
        setConversationFailed(true)
        setConversationFeedback(t("Impossible de confirmer la modification. Les données affichées sont conservées ; vérifiez les états à la relève avant de réessayer."))
        return false
      } finally { stateJobs.current -= 1; setStateBusy(stateJobs.current > 0) }
    })
    stateQueue.current = attempt.then(() => {})
    return attempt
  }

  // L’échange déjà affiché à l’arrivée est une ouverture. Les changements lu/non lu ne relancent pas cet effet.
  useEffect(() => { if (storageReady && conversation.id && conversation.imapReady !== false) void changeConversations(expandRows([conversation.id]), { unread: false }, false) }, [storageReady, conversation.id, conversation.imapReady])

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

  async function move(ids: string[], targetId: string) {
    ids = expandRows(ids)
    if (!ids.length || !preserveDraft()) return false
    if (!await changeConversations(ids, { projectId: targetId }, false)) return false
    if (document.activeElement?.getAttribute('role') === 'combobox') selectAllControl.current?.focus()
    clearSelection()
    setNotice(t("{0} conversation{1} déplacée{1} vers {2}. Classement partagé avec l’équipe.", ids.length, ids.length > 1 ? 's' : '', projectPath(mailbox.projects, targetId)))
    return true
  }

  function finishDrag() {
    dragSession.current = []
    setDraggingIds([])
    setDropTarget(null)
  }

  function startDrag(event: DragEvent<HTMLDivElement>, id: string) {
    if (!storageReady || (event.target as HTMLElement).closest('.selection-hit')) { event.preventDefault(); return }
    const ids = expandRows(chosen.includes(id) ? chosen : [id])
    dragSession.current = ids
    setDraggingIds(ids)
    setBulkOpen(false)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('application/x-courrier-conversations', JSON.stringify(ids))
    const ghost = ghostTemplate.current!.cloneNode(true) as HTMLDivElement
    ghost.hidden = false
    ghost.querySelector('.ghost-title')!.textContent = ids.length === 1 ? mailbox.conversations.find((item) => item.id === id)!.subject : t("{0} conversations", ids.length)
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
    void changeConversations(expandRows([id]), { unread: false }, false)
    return true
  }

  function beginReply(id = conversation.id) {
    if (composerOpen && id === selectedId) { document.getElementById('reply')?.focus(); return }
    if (id !== selectedId && !openConversation(id)) return
    setDraft(local.drafts[id] ?? '')
    setComposerOpen(true)
    setNotice('')
  }

  async function send() {
    if (sendBusy || !mailbox.connection || !draft.trim() || delivery || conversation.outgoing) return
    const targetId = conversation.id
    const revision = latestStates.current.find((item) => item.id === targetId)?.revision
    if (revision === undefined) return
    const requestId = local.sendRequests?.[targetId] ?? crypto.randomUUID()
    const saved = { ...local, drafts: { ...local.drafts, [targetId]: draft }, sendRequests: { ...local.sendRequests, [targetId]: requestId } }
    if (!save(saved)) return
    setSendBusy(true)
    setNotice('')
    try {
      const result = await sendReply({ data: { id: targetId, revision, text: draft, requestId } })
      if (result.ok) {
        const latest = localRef.current
        const drafts = { ...latest.drafts }; delete drafts[targetId]
        const sendRequests = { ...latest.sendRequests }; delete sendRequests[targetId]
        if (save({ ...latest, drafts, sendRequests }) && currentConversation.current === targetId) { setDraft(''); setComposerOpen(false) }
        setNotice(t(result.sentCopy ? "Réponse acceptée par le serveur SMTP." : "Réponse acceptée par SMTP ; copie dans Envoyés non confirmée. Ne renvoyez pas le mail."))
      } else setNotice(t(result.error ?? "Envoi non confirmé. Le brouillon est conservé ; vérifiez Envoyés avant de réessayer."))
      await refreshMailbox(false).catch(() => { setConversationFailed(true); setConversationFeedback(t("Actualisation impossible. Vos données restent affichées.")) })
    } catch { setNotice(t("Envoi non confirmé. Le brouillon est conservé ; vérifiez Envoyés avant de réessayer.")) }
    finally { setSendBusy(false) }
  }

  function selectProject(id: string | null, threadId?: string) {
    const first = threadId ?? mailboxRows(filterConversations(mailbox, id, query), displayMode)[0]?.id
    if (first ? !openConversation(first) : !preserveDraft()) return
    setProjectId(id)
    setView('mail')
    setStatus('all')
    setLabelId(null)
    setComposerOpen(false)
    clearSelection()
  }

  async function commitFolders(next: ProjectSettings): Promise<FolderFailure | null> {
    if (folderWrite.current) return { message: t("Un enregistrement est déjà en cours."), revision: next.revision }
    folderWrite.current = true
    setFolderBusy(true)
    try {
      const result = await saveProjectSettings({ data: next })
      if (result.settings) {
        const settings = result.settings
        setBaseMailbox((current) => settings.revision >= current.projectSettings.revision ?
          { ...current, projects: settings.projects, labels: settings.labels ?? [], projectSettings: { revision: settings.revision, sort: settings.sort, order: settings.order, labels: settings.labels ?? [] } } : current)
      }
      const failure = result.ok ? null : t(result.error ?? 'L’enregistrement partagé a échoué.')
      setFolderFailed(!!failure)
      setFolderFeedback(failure ?? t("Dossiers, labels et réglages enregistrés pour toute l’équipe."))
      return failure ? { message: failure, revision: result.settings?.revision ?? next.revision } : null
    } catch (failure) {
      const message = failure instanceof Error ? t(failure.message) : t("L’enregistrement partagé a échoué. Votre saisie est conservée.")
      setFolderFailed(true); setFolderFeedback(message)
      return { message, revision: next.revision }
    } finally { folderWrite.current = false; setFolderBusy(false) }
  }

  async function saveFolder(input: ProjectInput, editingId: string | null, position: number | null, revision: number) {
    try {
      const folder = prepareProject(input, mailbox.projects, editingId)
      const projects = editingId ? mailbox.projects.map((item) => item.id === editingId ? folder : item) : [...mailbox.projects, folder]
      const manual = sortProjects(projects, 'manual', folderSettings.order)
      let ordered = manual
      if (position !== null) {
        ordered = manual.filter((item) => item.id !== folder.id)
        const siblings = ordered.filter((item) => (item.parentId ?? null) === (folder.parentId ?? null))
        const anchor = siblings[position]
        const insertion = anchor ? ordered.indexOf(anchor) : siblings.length ? ordered.indexOf(siblings.at(-1)!) + 1 : ordered.length
        ordered.splice(insertion, 0, folder)
      }
      return await commitFolders({ ...folderSettings, revision, projects: ordered, order: ordered.map((item) => item.id) })
    } catch (failure) { return { message: failure instanceof Error ? t(failure.message) : t("Dossier invalide."), revision } }
  }

  async function reorderFolder(id: string, targetId: string, placement: 'before' | 'inside' | 'after') {
    const manual = sortProjects(mailbox.projects, 'manual', folderSettings.order)
    const source = manual.find((item) => item.id === id)
    const target = manual.find((item) => item.id === targetId)
    if (!source || !target || id === targetId) return false
    const rest = manual.filter((item) => item.id !== id)
    const moved = { ...source, parentId: placement === 'inside' ? targetId : target.parentId ?? null }
    const siblings = rest.filter((item) => item.parentId === targetId)
    const anchor = placement === 'inside' && siblings.length ? siblings.at(-1)! : target
    rest.splice(rest.indexOf(anchor) + (placement === 'before' ? 0 : 1), 0, moved)
    return !(await commitFolders({ ...folderSettings, projects: rest, order: rest.map((item) => item.id) }))
  }

  function sortFolders(sort: ProjectSort) { void commitFolders({ ...folderSettings, sort }) }

  return (
    <div className="workspace">
      <aside className="sidebar" aria-label={t("Navigation principale")}>
        <a className="brand" href={`/?lang=${locale}`} aria-label={t("Postfold, accueil")}><img className="brand-mark" src="/icon.svg" width="30" height="30" alt="" />Postfold<span className="brand-label">{t("Support")}</span></a>
        <div className="workspace-name"><span className="workspace-avatar">S</span><div>{t("Équipe support")}<small>{mailbox.connection?.email ?? t("Espace de démonstration")}</small></div></div>
        <nav className="main-nav">
          <button className={view === 'mail' && !projectId ? 'nav-button active' : 'nav-button'} onClick={() => selectProject(null)}><Icon name="mail" />{t("Boîte de réception")}<b>{mailboxRows(mailbox.conversations, displayMode).length}</b></button>
          <button className={view === 'contacts' ? 'nav-button active' : 'nav-button'} onClick={() => { if (!preserveDraft()) return; setView('contacts'); setComposerOpen(false); setNotice(''); clearSelection() }}><Icon name="users" />{t("Contacts")}<b>{mailbox.contacts.length}</b></button>
        </nav>
        <ProjectFolders mailbox={mailbox} revision={folderSettings.revision} currentId={view === 'mail' ? projectId : null} sort={folderSettings.sort} order={folderSettings.order} disabled={folderBusy} allowDelete={!mailbox.connection} dropTarget={dropTarget} movingMail={!!draggingIds.length}
          onSelect={selectProject} onSave={saveFolder} onSort={sortFolders} onReorder={reorderFolder} onDelete={async (id, revision) => { const projects = mailbox.projects.filter((item) => item.id !== id); const failure = await commitFolders({ ...folderSettings, revision, projects, order: folderSettings.order.filter((item) => item !== id) }); if (!failure && projectId === id) setProjectId(null); return failure }}
          onMailOver={(event, id) => { if (!dragSession.current.length) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(id) }}
          onMailLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null) }}
          onMailDrop={(event, id) => { if (!dragSession.current.length) return; event.preventDefault(); move(dragSession.current, id); finishDrag() }} />
        <LabelManager labels={mailbox.labels ?? []} conversations={mailbox.conversations} revision={folderSettings.revision} disabled={folderBusy} selectedId={activeLabel} onSelect={(id) => { setLabelId(id); setView('mail'); clearSelection() }} onSave={async (labels, revision) => { const failure = await commitFolders({ ...folderSettings, labels, revision }); if (!failure) await refreshMailbox(); return failure }} />
        {folderFeedback ? <p className={`folder-feedback ${folderFailed ? 'failed' : ''}`} role={folderFailed ? 'alert' : 'status'}>{folderFeedback}</p> : null}
        <div className="sidebar-bottom"><span className="user-avatar">{mailbox.connection ? 'PF' : 'JD'}</span><div>{t(mailbox.connection ? "Boîte partagée" : "Julie · Démo")}<small>{t("Votre espace de travail")}</small></div></div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="breadcrumb"><span>{t("Support")}</span><Icon name="chevron" /><strong>{view === 'contacts' ? t("Contacts") : selectedProject?.name ?? t("Tous les échanges")}</strong></div>
          <div className="header-indicators">
            <select className="language-switch" aria-label={t("Langue")} value={locale} onChange={(event) => { setConversationFeedback(''); setFolderFeedback(''); setNotice(''); void navigate({ search: { lang: event.target.value === 'en' ? 'en' : 'fr' }, replace: true }) }}><option value="fr">FR</option><option value="en">EN</option></select>
            <MailboxRefresh onRefresh={refreshMailbox} connected={!!mailbox.connection} />
            {!mailbox.connection ? <div className="presence-group">
              <ul className="presence-list" aria-label={t("Présences de démonstration")}>
                {demoPresence.map((person) => <li className="presence-item" key={person.name}>
                  <span className={`presence-avatar ${person.state}`} role="img" tabIndex={0} aria-label={t("{0} : {1}, présence simulée", person.name, t(person.activity))} aria-describedby={`presence-${person.name}`}>
                    {person.initials}<span className="presence-dot" aria-hidden="true" />
                  </span>
                  <span className="presence-tooltip" id={`presence-${person.name}`} role="tooltip"><strong>{person.name}</strong><small>{t(person.activity)} {t("· Démo")}</small></span>
                </li>)}
              </ul>
              <span className="presence-count">{demoPresence.length} {t("en ligne")} <span className="sr-only">{t("dans la démonstration")}</span></span>
            </div> : null}
            <span className="demo-badge">{t(mailbox.connection ? "IMAP / SMTP" : "Démonstration")}</span>
          </div>
        </header>
        <div className="demo-banner"><Icon name="info" /><span>{t(mailbox.connection ? "Boîte IMAP connectée · réponses SMTP protégées contre les doublons. Notes et brouillons restent dans ce navigateur." : "Dossiers, classement, labels et suivi partagés avec l’équipe. Aucune boîte mail connectée ; notes et brouillons restent locaux dans cette démo.")}{mailbox.connection?.error ? ` ${t("La dernière relève a échoué ; les mails en cache sont conservés.")}` : ''}</span></div>
        {error ? <div role="alert" className="error-banner">{error}</div> : null}
        {conversationFeedback ? <div role={conversationFailed ? 'alert' : 'status'} className={`conversation-feedback ${conversationFailed ? 'failed' : ''}`}>{conversationFeedback}</div> : null}
        <div className="content-grid">
          <section className="conversation-list" aria-label={view === 'contacts' ? t("Liste des contacts") : t("Liste des conversations")} onKeyDown={(event) => {
            if (view !== 'mail' || (event.target as HTMLElement).closest('textarea, select, input:not([type="checkbox"])')) return
            if (event.key === 'Escape') clearSelection()
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); setChosenIds(visibleIds) }
          }}>
            <div className="list-heading"><span className="eyebrow">{view === 'contacts' ? t("Carnet d’adresses") : t(displayMode === 'threads' ? "Conversations" : "Messages")}</span><h1>{view === 'contacts' ? t("Contacts") : selectedProject ? projectPath(mailbox.projects, selectedProject.id) : t("Boîte de réception")}</h1></div>
            {view === 'mail' ? <>
              <label className="display-mode"><span>{t("Affichage")}</span><select aria-label={t("Mode d’affichage")} value={displayMode} disabled={!storageReady} onChange={(event) => {
                const next = event.target.value === 'threads' ? 'threads' : 'messages'
                const drafts = composerOpen ? { ...local.drafts, [conversation.id]: draft } : local.drafts
                if (save({ ...local, drafts, displayMode: next })) { clearSelection(); setNotice(''); if (next === 'threads') void changeConversations(mailbox.conversations.filter((item) => threadKey(item) === threadKey(conversation)).map((item) => item.id), { unread: false }, false) }
              }}><option value="messages">{t("Tous les mails")}</option><option value="threads">{t("Conversations")}</option></select></label>
              <div className="search-field"><Icon name="search" /><input aria-label={t("Rechercher les échanges")} placeholder={t("Rechercher un échange…")} value={query} onChange={(event) => { setQuery(event.target.value); clearSelection() }} /></div>
              <div className="filters" role="group" aria-label={t("État des conversations")}>{[['all', t("Tous")], ['unread', t("Non lus")], ['open', t("À traiter")], ['waiting', t("En attente")], ['closed', t("Terminés")]].map(([key, label]) => <button key={key} aria-pressed={status === key} onClick={() => { setStatus(key); clearSelection() }}>{label}</button>)}</div>
              <div className="list-tools" ref={bulkTools} onKeyDown={(event) => {
                if (event.key === 'Escape' && !event.defaultPrevented && bulkOpen) {
                  event.preventDefault(); event.stopPropagation(); setBulkOpen(false); bulkTrigger.current?.focus()
                }
              }}>
                <label className="selection-hit"><input type="checkbox" aria-label={t("Sélectionner toutes les conversations affichées")} checked={allChosen} disabled={!rows.length} ref={(node) => { selectAllControl.current = node; if (node) node.indeterminate = chosen.length > 0 && !allChosen }} onChange={(event) => { setBulkOpen(false); setChosenIds(event.target.checked ? visibleIds : []); selectionAnchor.current = null }} /></label>
                <span aria-live="polite">{chosen.length ? t("{0} sélectionnée{1}", chosen.length, chosen.length > 1 ? 's' : '') : t(displayMode === 'threads' ? "{0} conversation{1}" : "{0} mail{1}", rows.length, rows.length > 1 ? 's' : '')}</span>
                {chosen.length ? <>
                  <button className="bulk-trigger" ref={bulkTrigger} aria-expanded={bulkOpen} aria-controls={bulkOpen ? 'bulk-actions' : undefined} onClick={() => setBulkOpen(!bulkOpen)}>{t("Actions")}<Icon name="chevron" /></button>
                  <button className="clear-selection" aria-label={t("Annuler la sélection")} onClick={clearSelection}><Icon name="close" /></button>
                  {bulkOpen ? <div className="bulk-actions" id="bulk-actions" role="group" aria-label={t("Actions du lot")}><ConversationActions disabled={stateBusy} onChange={(patch) => changeConversations(chosenMessages, patch)} /><ProjectPicker projects={sortProjects(mailbox.projects, folderSettings.sort, folderSettings.order)} disabled={stateBusy || !storageReady} onSelect={(targetId) => move(chosen, targetId)} /><LabelPicker labels={mailbox.labels ?? []} conversations={mailbox.conversations.filter((item) => chosenMessages.includes(item.id))} disabled={stateBusy} onChange={(patch) => changeConversations(chosenMessages, patch)} /><small>{t("Maj : sélectionner une plage · Ctrl / ⌘ : ajouter")}</small></div> : null}
                </> : null}
              </div>
              {rows.length ? rows.map((item) => {
                const sender = item.sender ?? mailbox.contacts.find((person) => person.id === item.contactId)!
                const folder = mailbox.projects.find((folder) => folder.id === item.projectId)!
                return <div key={item.id} data-conversation-id={item.id} data-folder-id={item.projectId} className={`thread-row ${item.unread ? 'unread' : ''} ${item.messageIds.includes(selectedId) ? 'selected' : ''} ${chosen.includes(item.id) ? 'checked' : ''} ${draggingIds.includes(item.id) ? 'dragging' : ''}`} draggable={storageReady} onDragStart={(event) => startDrag(event, item.id)} onDragEnd={finishDrag}>
                  <label className="selection-hit row-selection"><input type="checkbox" aria-label={t("Sélectionner {0}", item.subject)} checked={chosen.includes(item.id)} onChange={(event) => choose(item.id, event.target.checked, event.nativeEvent instanceof MouseEvent && event.nativeEvent.shiftKey)} /></label>
                  <button className="thread-open" aria-pressed={item.messageIds.includes(selectedId)} onClick={(event) => {
                    if (event.shiftKey || event.metaKey || event.ctrlKey) { choose(item.id, event.shiftKey || !chosen.includes(item.id), event.shiftKey); return }
                    if (openConversation(displayMode === 'threads' ? item.messageIds.at(-1)! : item.id)) { clearSelection(); selectionAnchor.current = item.id }
                  }}>
                  <div className="row-top"><strong>{sender.name}</strong><time>{t(item.time)}</time></div>
                  <div className="row-subject">{item.unread ? <span className="unread-dot" title={t("Non lu")}><span className="sr-only">{t("Non lu :")} </span></span> : <span className="sr-only">{t("Lu :")} </span>}{item.subject}{displayMode === 'threads' && item.messageIds.length > 1 ? <span className="thread-count" title={t("{0} mails dans ce fil", item.messageIds.length)}>{item.messageIds.length}</span> : null}</div>
                  <p title={item.preview}>{item.preview}</p><div className="row-bottom"><span className="folder-label" title={projectPath(mailbox.projects, folder.id)}>{projectPath(mailbox.projects, folder.id)}</span><span className={`status ${item.status}`}>{t(statuses[item.status])}</span></div>{item.labelIds?.length ? <div className="message-labels">{(mailbox.labels ?? []).filter((label) => item.labelIds?.includes(label.id)).map((label) => <span className="label-chip" key={label.id}><span className="project-dot" style={{ backgroundColor: projectColor(label.color) }} />{label.name}</span>)}</div> : null}
                  </button>
                </div>
              }) : <div className="empty-state">{t("Aucun échange ne correspond à votre recherche.")}</div>}
            </> : mailbox.contacts.map((person) => <button className={`contact-row ${person.id === contactId ? 'selected' : ''}`} key={person.id} onClick={() => { setContactId(person.id); setNotice('') }}>
              <span className="contact-avatar">{initials(person.name)}</span><span><strong>{person.name}</strong><small>{person.company}</small></span><span className="contact-arrow"><Icon name="chevron" /></span>
            </button>)}
          </section>

          <section className="reading-pane" aria-label={view === 'mail' ? t("Conversation sélectionnée") : t("Historique du contact")}>
            {view === 'mail' ? showConversation ? <>
              <div className="reading-toolbar"><ConversationActions unread={threadMessages.some((item) => item.unread)} status={conversation.status} disabled={stateBusy} onChange={(patch) => changeConversations(readingIds, patch)} /><LabelPicker labels={mailbox.labels ?? []} conversations={threadMessages} disabled={stateBusy} onChange={(patch) => changeConversations(readingIds, patch)} /><span className="assignee">{conversation.assignee ? t("Attribué à {0}", conversation.assignee) : t("Non attribué")}</span></div>
              <div className="message-heading"><span className="eyebrow">{projectPath(mailbox.projects, project.id)}</span><h2>{displayMode === 'threads' ? threadMessages[0].subject : conversation.subject}</h2><p>{t("Un échange avec")} {contact.name}</p></div>
              {threadMessages.map((message) => {
                const sender = message.sender ?? mailbox.contacts.find((item) => item.id === message.contactId)!
                const header = <><span className="contact-avatar">{initials(sender.name)}</span><div><strong>{sender.name}</strong><small>{sender.email}</small></div><time>{t(message.time)}</time></>
                const body = <><div className="message-body">{message.body}</div><button className="message-reply secondary-button" onClick={() => beginReply(message.id)}><Icon name="reply" />{t("Répondre à ce mail")}</button></>
                return displayMode === 'threads' ? <details className="message thread-message" key={message.id} data-message-id={message.id} open={message.id === selectedId}><summary>{header}<Icon name="chevron" /></summary>{body}</details> : <article className="message" key={message.id} data-message-id={message.id}><header>{header}</header>{body}</article>
              })}
              {composerOpen ? <form className="composer" onSubmit={(event) => { event.preventDefault(); if (save({ ...local, drafts: { ...local.drafts, [conversation.id]: draft } })) setNotice(t("Brouillon enregistré dans ce navigateur. Aucun email envoyé.")) }}>
                <label htmlFor="reply">{t("Votre brouillon")} <small>{t("À :")} {contact.email}</small></label><textarea id="reply" value={draft} disabled={sendBusy} onChange={(event) => setDraft(event.target.value)} placeholder={t("Bonjour…")} rows={7} maxLength={100_000} />
                <footer><span id="send-unavailable">{t(!mailbox.connection ? "Connectez une boîte mail pour envoyer." : delivery ? delivery.status === 'sent' ? "Une réponse a déjà été envoyée à ce mail." : "Envoi en cours ou incertain : vérifiez Envoyés, ne renvoyez pas." : "Le brouillon sera sauvegardé avant l’envoi.")}</span><div className="composer-actions"><button className="secondary-button" disabled={!storageReady || sendBusy} type="submit">{t("Enregistrer le brouillon")}</button><button className="primary-button" type="button" disabled={!mailbox.connection || !storageReady || !draft.trim() || sendBusy || stateBusy || !!delivery || !!conversation.outgoing} onClick={() => void send()} aria-describedby="send-unavailable" aria-busy={sendBusy}><Icon name="send" />{t(sendBusy ? "Envoi…" : "Envoyer")}</button></div></footer>
              </form> : <div className="reply-bar"><span>{local.drafts[conversation.id] ? t("Brouillon enregistré") : t("Aucune réponse préparée")}</span><button className="primary-button" onClick={() => beginReply()}><Icon name="reply" />{local.drafts[conversation.id] ? t("Reprendre le brouillon") : t("Préparer une réponse")}</button></div>}
            </> : <div className="empty-folder"><span className="empty-folder-icon" style={{ color: projectColor(selectedProject?.color ?? 'slate') }}><Icon name="folder" /></span><span className="eyebrow">{selectedProject ? projectPath(mailbox.projects, selectedProject.id) : t("Dossier indisponible")}</span><h2>{t("Ce dossier est vide")}</h2><p>{t("Déposez des conversations dans ce dossier ou utilisez « Déplacer vers un projet » depuis la boîte de réception.")}</p></div> : <div className="contact-history"><span className="eyebrow">{t("Historique des échanges")}</span><h2>{t("Les échanges avec")} {contact.name.split(' ')[0]}</h2><p>{t("Tous les projets et conversations associés à ce contact.")}</p>{mailbox.conversations.filter((item) => item.contactId === contact.id).map((item) => <button className="history-item" key={item.id} onClick={() => selectProject(item.projectId, item.id)}><span><strong>{item.subject}</strong><small>{mailbox.projects.find((project) => project.id === item.projectId)?.name}</small></span><span className={`status ${item.status}`}>{t(statuses[item.status])}</span></button>)}</div>}
            {notice ? <p role="status" className="notice">{notice}</p> : null}
          </section>

          {(view === 'contacts' && mailbox.contacts.length > 0) || showConversation ? <aside className="contact-panel" aria-label={t("Fiche du contact")}>
            <span className="section-label">{t("Fiche contact")}</span><div className="profile-avatar">{initials(contact.name)}</div><h2>{contact.name}</h2><p className="company">{contact.company}</p>
            <dl className="contact-details"><dt>{t("Email")}</dt><dd>{contact.email}</dd><dt>{t("Téléphone")}</dt><dd>{contact.phone}</dd></dl>
            <div className="panel-section"><h3>{t("Projets associés")}</h3>{mailbox.projects.filter((item) => mailbox.conversations.some((thread) => thread.contactId === contact.id && thread.projectId === item.id)).map((item) => <button key={item.id} className="linked-project" onClick={() => selectProject(item.id)}><span className="project-dot" style={{ backgroundColor: projectColor(item.color) }} /><span>{projectPath(mailbox.projects, item.id)}</span><Icon name="arrow" /></button>)}</div>
            <div className="panel-section"><h3>{t("Notes internes")} <span>{contactNotes.length}</span></h3>{contactNotes.map((item) => <article className="contact-note" key={item.id}><p>{item.body}</p><small>{mailbox.connection ? t("Note locale") : "Julie"} · {new Date(item.createdAt).toLocaleDateString(locale === 'en' ? 'en-GB' : 'fr-FR')}</small></article>)}
              <form onSubmit={(event) => { event.preventDefault(); const body = note.trim(); if (!body) return; if (save({ ...local, notes: [...local.notes, { id: crypto.randomUUID(), contactId: contact.id, body, createdAt: new Date().toISOString() }] })) { setNote(''); setNotice(t("Note enregistrée dans ce navigateur.")) } }}>
                <label className="sr-only" htmlFor="contact-note">{t("Ajouter une note sur")} {' '}{contact.name}</label><textarea id="contact-note" value={note} onChange={(event) => setNote(event.target.value)} placeholder={t("Un détail utile pour la prochaine fois…")} rows={4} maxLength={5000} />
                <button className="note-button" disabled={!storageReady || !note.trim()} type="submit"><Icon name="plus" />{t("Ajouter une note")}</button>
              </form><small className="private-hint">{t("Visible ici uniquement · jamais envoyé au contact")}</small>
            </div>
          </aside> : null}
        </div>
      </main>
      <div className="drag-ghost" hidden ref={ghostTemplate} aria-hidden="true"><div className="ghost-card"><span className="ghost-icon"><Icon name="mail" /></span><div><strong className="ghost-title" /><small>{t("Déplacer vers un projet")}</small></div><b className="ghost-count" /></div></div>
    </div>
  )
}
