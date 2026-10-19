import type { ComposedMail } from '../components/mail-composer'
import type { SettingsTab } from '../components/authoring-settings'
import { richDraft, isRichDraft, type RichDraft } from '../../shared/authoring'
import { deleteDraftFiles } from '../lib/draft-attachments'
import { useI18n } from '../lib/i18n'
import { Suspense, lazy, useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { compareMessages, filterConversations, includesContact, mailboxRows, suggestProjects, threadContacts, threadKey, updateSelection, type MailOrder } from '../lib/mailbox'
import { getDemoMailbox, listMailbox, searchContacts, saveProjectSettings, savePreferences, updateConversationState, syncMailbox, sendReply } from '../server/demo'
import { Icon } from '../components/icon'
import { ProjectPicker } from '../components/project-picker'
import { MailboxRefresh } from '../components/mailbox-refresh'
import { ProjectFolders, type FolderFailure } from '../components/project-folders'
import { prepareProject, projectColor, projectPath, sortProjects, type ProjectInput, type ProjectSort } from '../../shared/projects'
import type { Contact, ConversationPatch, ConversationState, DemoMailbox, MailboxQuery, ProjectSettings } from '../../shared/mailbox'
import { applyConversationStates, conversationStatuses as statuses, mergeConversationStates, patchState } from '../../shared/conversation-state'
import { pickPreferences } from '../../shared/preferences'
import { OFFLINE_HOURS, OUTBOX_LIMIT, forgetOfflineCopy, isNoop, isOutbox, offlineDeadline, rebaseTargets, recordAccepted, rememberDeadline, useOfflineLock, useOnline, type PendingChange } from '../lib/offline'
import { ConversationActions } from '../components/conversation-actions'
import { LabelManager, LabelPicker } from '../components/labels'
import { AssignmentPicker } from '../components/assignment-picker'
import { ConversationActivity } from '../components/conversation-activity'
import { MessageBody, prefetchMessage } from '../components/message-body'
import { SyncProgressBanner } from '../components/sync-progress'

const MailComposer = lazy(() => import('../components/mail-composer').then(module => ({ default: module.MailComposer })))
const AuthoringPage = lazy(() => import('../components/authoring-settings').then(module => ({ default: module.AuthoringPage })))

export const Route = createFileRoute('/')({ loader: () => getDemoMailbox(), component: MailboxPage })

type Note = { id: string; contactId: string; body: string; createdAt: string }
type LocalData = { notes: Note[]; drafts: Record<string, string | RichDraft>; sendRequests?: Record<string, string>; placements?: Record<string, string>; displayMode?: 'messages' | 'threads'; listOrder?: MailOrder; conversationOrder?: MailOrder; contactCollapsed?: boolean
  autoRefresh?: boolean; openFolders?: string[]; preferencesPending?: boolean }
const ROW_PAGE = 100
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
    Object.values(value.drafts).every((draft) => typeof draft === 'string' || isRichDraft(draft)) &&
    (!('sendRequests' in value) || (!!value.sendRequests && typeof value.sendRequests === 'object' && !Array.isArray(value.sendRequests) && Object.values(value.sendRequests).every((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)))) &&
    (!('displayMode' in value) || value.displayMode === 'messages' || value.displayMode === 'threads') &&
    (!('listOrder' in value) || value.listOrder === 'newest' || value.listOrder === 'oldest') &&
    (!('contactCollapsed' in value) || typeof value.contactCollapsed === 'boolean') &&
    (!('autoRefresh' in value) || typeof value.autoRefresh === 'boolean') && (!('preferencesPending' in value) || typeof value.preferencesPending === 'boolean') &&
    (!('openFolders' in value) || (Array.isArray(value.openFolders) && value.openFolders.every((id) => typeof id === 'string'))) &&
    (!('conversationOrder' in value) || value.conversationOrder === 'newest' || value.conversationOrder === 'oldest') &&
    (!('placements' in value) || (!!value.placements && typeof value.placements === 'object' &&
      !Array.isArray(value.placements) && Object.values(value.placements).every((id) => typeof id === 'string')))
}

function MailboxPage() {
  const { t, locale } = useI18n()
  const navigate = Route.useNavigate()
  const initialMailbox = Route.useLoaderData()
  const storageKey = initialMailbox.viewer ? `postfold:mailbox:${initialMailbox.connection?.email ?? 'demo'}:${initialMailbox.viewer.id}:v1` : initialMailbox.connection ? `postfold:mailbox:${initialMailbox.connection.email}:v1` : 'mailer-support:demo:v1'
  const latestStates = useRef(initialMailbox.conversationStates)
  const stateQueue = useRef(Promise.resolve())
  const stateJobs = useRef(0)
  const [baseMailbox, setBaseMailbox] = useState(initialMailbox)
  // Live mailboxes arrive in windows (current filters, paged by the API); the demo mailbox is complete.
  const windowed = !!initialMailbox.page
  const listQueryRef = useRef<MailboxQuery>({})
  const selectedRef = useRef('')
  const loadedRef = useRef(0)
  // A window fetched for filters that changed meanwhile is dropped instead of replacing the newer one.
  const isCurrent = (key: string) => !windowed || JSON.stringify(listQueryRef.current) === key
  const acceptMailbox = useCallback((freshMailbox: DemoMailbox, append = false) => {
    rememberDeadline(offlineDeadline(freshMailbox.viewer?.sessionExpiresAt))
    const states = mergeConversationStates(latestStates.current, freshMailbox.conversationStates)
    latestStates.current = states
    setBaseMailbox((current) => {
      const newer = freshMailbox.projectSettings.revision >= current.projectSettings.revision
      const byId = <T extends { id: string }>(items: T[]) => [...new Map(items.map((item) => [item.id, item])).values()]
      return { ...freshMailbox,
        projects: newer ? freshMailbox.projects : current.projects,
        labels: newer ? freshMailbox.labels : current.labels,
        projectSettings: newer ? freshMailbox.projectSettings : current.projectSettings,
        contacts: windowed ? byId([...current.contacts, ...freshMailbox.contacts]) : freshMailbox.contacts,
        conversationStates: states, conversations: applyConversationStates(append ? byId([...current.conversations, ...freshMailbox.conversations]) : freshMailbox.conversations, states),
      }
    })
  }, [windowed])
  const refreshMailbox = useCallback(async (synchronize = true) => {
    const key = JSON.stringify(listQueryRef.current)
    // Refreshing keeps what was already scrolled into view and the open conversation.
    const query = { ...listQueryRef.current, limit: Math.min(1000, Math.max(200, loadedRef.current)), include: selectedRef.current ? [selectedRef.current] : [] }
    const freshMailbox = synchronize ? await syncMailbox({ data: query }) : await listMailbox({ data: query })
    if (isCurrent(key)) acceptMailbox(freshMailbox)
    return freshMailbox
  }, [acceptMailbox])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [labelId, setLabelId] = useState<string | null>(null)
  const [memberId, setMemberId] = useState<string | null>(null)
  const [view, setView] = useState<'mail' | 'contacts' | 'settings'>('mail')
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('templates')
  const [status, setStatus] = useState('all')
  const [selectedId, setSelectedId] = useState(initialMailbox.conversations[0]?.id ?? '')
  const [contactId, setContactId] = useState(initialMailbox.contacts[0]?.id ?? '')
  const [inspectedContact, setInspectedContact] = useState<{ threadId: string; id: string } | null>(null)
  const [sendBusy, setSendBusy] = useState(false)
  const [composerFilesBusy, setComposerFilesBusy] = useState(false)
  const [composerOpen, setComposerOpen] = useState(false)
  const [draft, setDraft] = useState<RichDraft>({ text: '', html: '' })
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({})
  const [local, setLocal] = useState<LocalData>({ notes: [], drafts: {} })
  const localRef = useRef(local)
  const [storageReady, setStorageReady] = useState(false)
  const online = useOnline()
  // Conversation changes made offline, kept on this device and replayed in order when the network returns.
  const outboxKey = `${storageKey}:outbox`
  const [outbox, setOutbox] = useState<PendingChange[]>([])
  const outboxRef = useRef(outbox)
  const flushing = useRef(false)
  // Server-side preferences need an identity; null means a shared basic-auth gate, so choices stay in this browser.
  const syncedPreferences = initialMailbox.preferences != null
  const preferencesTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
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
  const readingPane = useRef<HTMLElement>(null)
  const contactReturnScroll = useRef<number | null>(null)

  useEffect(() => {
    if (!bulkOpen) return
    const closeOutside = (event: PointerEvent) => { if (!bulkTools.current?.contains(event.target as Node)) setBulkOpen(false) }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [bulkOpen])

  useEffect(() => {
    try {
      const stored = localStorage.getItem(storageKey)
      const parsed: unknown = stored ? JSON.parse(stored) : { notes: [], drafts: {} }
      if (!isLocalData(parsed)) throw new Error(t("Données locales non reconnues."))
      const loaded = initialMailbox.preferences && !parsed.preferencesPending ? { ...parsed, ...initialMailbox.preferences } : parsed
      setLocal(loaded)
      localRef.current = loaded
      if (parsed.preferencesPending) schedulePreferences()
      const queued: unknown = JSON.parse(localStorage.getItem(outboxKey) ?? '[]')
      if (isOutbox(queued) && queued.length) { outboxRef.current = queued; setOutbox(queued); for (const change of queued) showChange(change.targets.map((item) => item.id), change.patch) }
      if (loaded.displayMode === 'threads') {
        const row = mailboxRows(initialMailbox.conversations, 'threads').find(item => item.messageIds.includes(selectedId))
        if (row) setSelectedId(row.messageIds.at(-1)!)
      }
      setStorageReady(true)
    } catch {
      setError(t("Impossible de lire les données locales. Elles ont été conservées ; les nouvelles écritures sont désactivées."))
    }
  }, [])

  function save(next: LocalData) {
    if (!storageReady) return false
    const changed = JSON.stringify(pickPreferences(next)) !== JSON.stringify(pickPreferences(localRef.current))
    if (changed && syncedPreferences) next = { ...next, preferencesPending: true }
    try {
      localStorage.setItem(storageKey, JSON.stringify(next))
      setLocal(next)
      localRef.current = next
      setError('')
      if (changed) schedulePreferences()
      return true
    } catch {
      setError(t("L’enregistrement local a échoué. Votre saisie reste affichée : copiez-la avant de quitter cette page."))
      return false
    }
  }

  // Sends the reader's display choices shortly after a change; offline they stay pending and leave with the network.
  function schedulePreferences() {
    if (!syncedPreferences) return
    clearTimeout(preferencesTimer.current)
    preferencesTimer.current = setTimeout(() => {
      if (!navigator.onLine) return
      const sent = pickPreferences(localRef.current)
      savePreferences({ data: sent }).then(() => {
        const latest = localRef.current
        if (!latest.preferencesPending || JSON.stringify(pickPreferences(latest)) !== JSON.stringify(sent)) return
        const done = { ...latest, preferencesPending: false }
        try { localStorage.setItem(storageKey, JSON.stringify(done)); localRef.current = done; setLocal(done) } catch { /* Stays pending: sent again next time. */ }
      }).catch(() => { /* Stays pending: retried when the network returns or on the next change. */ })
    }, 800)
  }

  function writeOutbox(next: PendingChange[]) {
    outboxRef.current = next
    setOutbox(next)
    try { if (next.length) localStorage.setItem(outboxKey, JSON.stringify(next)); else localStorage.removeItem(outboxKey) } catch { /* Kept in memory until this tab closes. */ }
  }

  // Shows a queued change right away; the API's states replace it once the change is sent.
  function showChange(ids: string[], patch: ConversationPatch) {
    const assignee = patch.assigneeId !== undefined ? (initialMailbox.members ?? []).find((member) => member.id === patch.assigneeId)?.name ?? null : undefined
    setBaseMailbox((current) => ({ ...current, conversations: current.conversations.map((item) => ids.includes(item.id) ? { ...patchState(item, patch), ...(assignee !== undefined ? { assignee } : {}) } : item) }))
  }

  // Replays offline changes in order, after any change already running. A change a colleague overtook is refused
  // by its revisions and the current shared state is shown instead.
  function flushOutbox() {
    if (flushing.current || !outboxRef.current.length) return
    flushing.current = true
    stateQueue.current = stateQueue.current.then(async () => {
      const accepted = new Map<string, { from: number; to: number }>()
      let sent = 0, refused = 0
      while (outboxRef.current.length && navigator.onLine) {
        const [change] = outboxRef.current
        try {
          const result = await updateConversationState({ data: { targets: rebaseTargets(change, accepted), ...change.patch } })
          if (result.states) acceptStates(result.states)
          if (result.ok && result.states) recordAccepted(accepted, change, result.states)
          if (result.ok) sent++; else refused++
        } catch { break } // Server unreachable: the rest stays queued for the next reconnection.
        writeOutbox(outboxRef.current.slice(1))
      }
      if (!sent && !refused) return
      setConversationFailed(refused > 0)
      setConversationFeedback(refused ? t("{0} modification{1} hors ligne envoyée{1} ; {2} refusée{3} car la conversation ou le dossier a changé entre-temps. L’état partagé actuel est affiché.", sent, sent > 1 ? 's' : '', refused, refused > 1 ? 's' : '')
        : t("{0} modification{1} faite{1} hors ligne envoyée{1} à l’équipe.", sent, sent > 1 ? 's' : ''))
      await refreshMailbox(false).catch(() => {})
    }).finally(() => { flushing.current = false })
  }

  useEffect(() => {
    if (!online || !storageReady) return
    if (localRef.current.preferencesPending) schedulePreferences()
    flushOutbox()
  }, [online, storageReady])

  const offlineLocked = useOfflineLock(online)
  useEffect(() => {
    if (initialMailbox.viewer?.sessionExpiresAt) rememberDeadline(initialMailbox.viewer.sessionExpiresAt)
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
    void navigator.serviceWorker.register('/sw.js').catch(() => {})
    // Loads the lazy screens once online so the service worker keeps them for offline use.
    const idle = setTimeout(() => { void import('../components/mail-composer'); void import('../components/authoring-settings') }, 5000)
    return () => clearTimeout(idle)
  }, [])

  const mailbox = baseMailbox
  const activeLabel = mailbox.labels?.some((item) => item.id === labelId) ? labelId : null
  // Live windows are filtered by colleague in PostgreSQL (assignment and activity); the demo filters its assignments.
  const filtered = (source: DemoMailbox) => filterConversations(source, projectId, query)
    .filter((item) => (status === 'all' || (status === 'unread' ? item.unread : item.status === status)) && (!activeLabel || item.labelIds?.includes(activeLabel)) &&
      (!memberId || windowed || item.assigneeId === memberId))
  const conversations = filtered(mailbox)
  const displayMode = local.displayMode ?? 'messages'
  const listOrder = local.listOrder ?? 'newest'
  const conversationOrder = local.conversationOrder ?? 'oldest'
  const contactCollapsed = view === 'mail' && !!local.contactCollapsed
  const rows = mailboxRows(conversations, displayMode, listOrder)
  const conversation = mailbox.conversations.find((item) => item.id === selectedId) ?? mailbox.conversations[0] ?? { id: '', projectId: '', contactId: '', subject: '', preview: '', body: '', time: '', status: 'open' as const, assignee: null, unread: false }
  const replyContact = mailbox.contacts.find((item) => item.id === conversation.contactId) ?? mailbox.contacts[0] ?? { id: '', name: '', email: '', company: '', phone: '' }
  const project = mailbox.projects.find((item) => item.id === conversation.projectId) ?? mailbox.projects[0]
  const selectedProject = mailbox.projects.find((item) => item.id === projectId)
  const threadMessages = displayMode === 'threads' ? mailbox.conversations.filter((item) => threadKey(item) === threadKey(conversation)).sort((a, b) => compareMessages(a, b, conversationOrder)) : [conversation]
  const participants = threadContacts(mailbox, threadMessages)
  const contact = view === 'contacts' ? mailbox.contacts.find((item) => item.id === contactId) ?? replyContact :
    (inspectedContact?.threadId === threadKey(conversation) ? participants.find((item) => item.id === inspectedContact.id) : undefined) ?? replyContact
  const [debouncedQuery, setDebouncedQuery] = useState('')
  useEffect(() => { const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300); return () => clearTimeout(timer) }, [query])
  // The contacts view loads the history of the selected contact; the mail view loads its filters.
  const listQuery: MailboxQuery = view === 'contacts' ? { query: contact.email, order: 'newest' }
    : { projectId, status: status as MailboxQuery['status'], labelId: activeLabel, memberId, query: debouncedQuery, threads: displayMode === 'threads', order: listOrder }
  const listKey = JSON.stringify(listQuery)
  listQueryRef.current = listQuery
  selectedRef.current = selectedId
  loadedRef.current = mailbox.conversations.length
  const [listBusy, setListBusy] = useState(false)
  const initialListKey = useRef(listKey)
  useEffect(() => {
    if (!windowed || !online || listKey === initialListKey.current) return
    initialListKey.current = ''
    let active = true
    setListBusy(true)
    listMailbox({ data: { ...listQuery, include: composerOpen && selectedId ? [selectedId] : [] } }).then((fresh) => {
      if (!active || !isCurrent(listKey)) return
      acceptMailbox(fresh)
      // The open conversation follows the new filters unless a reply is being written.
      const visible = mailboxRows(filtered(fresh), displayMode, listOrder)
      if (view === 'mail' && !composerOpen && !visible.some((row) => row.messageIds.includes(selectedId))) setSelectedId((displayMode === 'threads' ? visible[0]?.messageIds.at(-1) : visible[0]?.id) ?? '')
    }).catch(() => { if (active) { setConversationFailed(true); setConversationFeedback(t("Actualisation impossible. Vos données restent affichées.")) } })
      .finally(() => { if (active) setListBusy(false) })
    return () => { active = false }
  }, [listKey, online])
  const loadingMore = useRef(false)
  async function loadMore() {
    const cursor = mailbox.page?.nextCursor
    if (!cursor || loadingMore.current || !navigator.onLine) return
    loadingMore.current = true
    setListBusy(true)
    try {
      const fresh = await listMailbox({ data: { ...listQuery, cursor } })
      if (isCurrent(listKey)) acceptMailbox(fresh, true)
    } catch { setConversationFailed(true); setConversationFeedback(t("Actualisation impossible. Vos données restent affichées.")) }
    finally { loadingMore.current = false; setListBusy(false) }
  }
  const [contactQuery, setContactQuery] = useState('')
  const [contactResults, setContactResults] = useState<Contact[] | null>(null)
  useEffect(() => {
    if (!windowed || view !== 'contacts') return
    let active = true
    const timer = setTimeout(() => {
      searchContacts({ data: contactQuery.trim() }).then((found) => {
        if (!active || !found) return
        setContactResults(found)
        setBaseMailbox((current) => ({ ...current, contacts: [...new Map([...current.contacts, ...found].map((person) => [person.id, person])).values()] }))
        if (found.length && !found.some((person) => person.id === contactId)) setContactId(found[0].id)
      }).catch(() => {})
    }, 300)
    return () => { active = false; clearTimeout(timer) }
  }, [windowed, view, contactQuery])
  const threadSubject = mailbox.conversations.find((item) => item.id === threadKey(conversation))?.subject ?? conversation.subject.replace(/^re:\s*/i, '')
  const readingIds = threadMessages.map((item) => item.id)
  const matchingProjects = suggestProjects(mailbox.projects, threadMessages)
  const filingSuggestions = matchingProjects.filter((target) => threadMessages.some((item) => item.projectId !== target.id))
  const showConversation = mailbox.conversations.length > 0 && (!projectId || filterConversations(mailbox, projectId, '').some((item) => readingIds.includes(item.id)))
  const delivery = mailbox.deliveries?.find((item) => item.targetId === conversation.id)
  const currentConversation = useRef(conversation.id)
  currentConversation.current = conversation.id
  const folderSettings: ProjectSettings = { ...baseMailbox.projectSettings, projects: mailbox.projects, labels: mailbox.labels ?? [] }
  const contactNotes = local.notes.filter((item) => item.contactId === contact.id)
  const note = noteDrafts[contact.id] ?? ''
  const setNote = (body: string) => setNoteDrafts((current) => ({ ...current, [contact.id]: body }))
  const visibleIds = rows.map((item) => item.id)
  const visibleSet = new Set(visibleIds)
  const chosen = chosenIds.filter((id) => visibleSet.has(id))
  // ponytail: rows render in pages while scrolling (the selected row is always included); switch to windowing if the DOM itself grows too large.
  const [rowLimit, setRowLimit] = useState(ROW_PAGE)
  useEffect(() => setRowLimit(ROW_PAGE), [view, projectId, query, status, labelId, memberId, displayMode, listOrder])
  const selectedRow = rows.findIndex((item) => item.messageIds.includes(selectedId))
  const shownRows = rows.slice(0, Math.max(rowLimit, selectedRow + 1))
  // Past the loaded rows, the sentinel asks the API for the next window.
  const onSentinel = useRef(() => {})
  onSentinel.current = () => { if (shownRows.length < rows.length) setRowLimit((limit) => limit + ROW_PAGE); else void loadMore() }
  const listTotal = mailbox.page ? Math.max(mailbox.page.total, rows.length) : rows.length
  const moreRows = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    // A fresh sentinel per page re-checks visibility, so fast scrolling keeps loading until the viewport is filled.
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) onSentinel.current() }, { root: node.parentElement, rootMargin: '0px 0px 800px 0px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const allChosen = rows.length > 0 && chosen.length === rows.length
  const chosenMessages = expandRows(chosen)

  const revealInReader = useCallback((target: HTMLElement, align: 'start' | 'end' | 'auto' = 'auto') => {
    const reader = readingPane.current
    if (!reader) return
    const panel = window.matchMedia('(max-width: 820px)').matches ? reader.parentElement! : reader
    const bounds = panel.getBoundingClientRect(), rect = target.getBoundingClientRect()
    const header = reader.querySelector('.reading-context')?.getBoundingClientRect().height ?? 0
    const available = panel.clientHeight - header - 16
    // Scroll only the visible reading surface; never move the fixed workspace.
    const offset = align === 'end' || (align === 'auto' && rect.height <= available) ? rect.bottom - bounds.bottom + 12 : rect.top - bounds.top - header - 8
    panel.scrollTo({ top: panel.scrollTop + offset })
  }, [])

  const revealConversation = useCallback((order = conversationOrder) => {
    const reader = readingPane.current
    if (!reader) return
    if (displayMode === 'messages') {
      const panel = window.matchMedia('(max-width: 820px)').matches ? reader.parentElement! : reader
      panel.scrollTo({ top: panel === reader ? 0 : panel.scrollTop + reader.getBoundingClientRect().top - panel.getBoundingClientRect().top })
      return
    }
    const messages = reader.querySelectorAll<HTMLElement>('[data-message-id]')
    const target = messages.item(order === 'oldest' ? messages.length - 1 : 0)
    if (target) revealInReader(target, order === 'oldest' ? 'end' : 'start')
  }, [displayMode, conversationOrder, revealInReader])

  useEffect(() => {
    if (!storageReady) return
    const frame = requestAnimationFrame(() => {
      if (view === 'mail' && !window.matchMedia('(max-width: 820px)').matches) revealConversation()
      else readingPane.current?.scrollTo({ top: 0 })
    })
    return () => cancelAnimationFrame(frame)
  }, [selectedId, view, contactId, storageReady, revealConversation])

  const revealComposer = useCallback((element: HTMLElement) => {
    element.querySelector<HTMLElement>('#reply')?.focus({ preventScroll: true })
    revealInReader(element)
  }, [revealInReader])

  function toggleContact() {
    if (!save({ ...localRef.current, contactCollapsed: !contactCollapsed })) return
    const mobile = window.matchMedia('(max-width: 820px)').matches
    if (mobile && contactCollapsed) contactReturnScroll.current = readingPane.current?.parentElement?.scrollTop ?? 0
    requestAnimationFrame(() => {
      if (contactCollapsed && mobile) {
        const panel = readingPane.current?.parentElement, profile = document.getElementById('contact-profile')
        if (panel && profile) panel.scrollTo({ top: panel.scrollTop + profile.getBoundingClientRect().top - panel.getBoundingClientRect().top })
        profile?.focus({ preventScroll: true })
      } else {
        if (mobile && contactReturnScroll.current !== null) readingPane.current?.parentElement?.scrollTo({ top: contactReturnScroll.current })
        document.querySelector<HTMLElement>('.contact-toggle')?.focus({ preventScroll: true })
      }
    })
  }

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
        if (!navigator.onLine) {
          if (isNoop(current, outboxRef.current, selected, patch)) return true
          if (outboxRef.current.length >= OUTBOX_LIMIT) {
            setConversationFailed(true)
            setConversationFeedback(t("Trop de modifications hors ligne en attente. Reconnectez-vous pour les envoyer."))
            return false
          }
          writeOutbox([...outboxRef.current, { id: crypto.randomUUID(), targets: current.map(({ id, revision }) => ({ id, revision })), patch }])
          showChange(selected, patch)
          if (announce) { setConversationFailed(false); setConversationFeedback(t("Hors ligne : modification gardée sur cet appareil et envoyée au retour du réseau.")) }
          return true
        }
        const result = await updateConversationState({ data: { targets: current.map(({ id, revision }) => ({ id, revision })), ...patch } })
        if (result.states) acceptStates(result.states)
        if (!result.ok) {
          setConversationFailed(true)
          setConversationFeedback(result.error ? t(result.error) : t("La modification a échoué."))
          return false
        }
        if (announce) {
          const label = patch.unread !== undefined ? patch.unread ? t("Non lu") : t("Lu") : patch.status ? t(statuses[patch.status]) : patch.projectId ? t("Déplacement") : patch.assigneeId !== undefined ? t("Attribution mise à jour") : t("Labels mis à jour")
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
    setNotice(t(navigator.onLine ? "{0} conversation{1} déplacée{1} vers {2}. Classement partagé avec l’équipe." : "{0} conversation{1} déplacée{1} vers {2} sur cet appareil. Le classement sera partagé au retour du réseau.", ids.length, ids.length > 1 ? 's' : '', projectPath(mailbox.projects, targetId)))
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

  useEffect(() => {
    if (!composerOpen || !storageReady || sendBusy) return
    const timer = setTimeout(() => {
      const latest = localRef.current
      if (JSON.stringify(draft) !== JSON.stringify(richDraft(latest.drafts[conversation.id]))) save({ ...latest, drafts: { ...latest.drafts, [conversation.id]: draft } })
    }, 600)
    return () => clearTimeout(timer)
  }, [draft, composerOpen, storageReady, sendBusy, conversation.id])

  function preserveDraft() {
    if (composerFilesBusy) { setNotice(t('Les pièces jointes sont en cours d’enregistrement. Patientez avant de changer de mail.')); return false }
    return !composerOpen || JSON.stringify(draft) === JSON.stringify(richDraft(local.drafts[conversation.id])) ||
      save({ ...local, drafts: { ...local.drafts, [conversation.id]: draft } })
  }

  useEffect(() => {
    if (!composerOpen) return
    const flushDraft = () => { const latest = localRef.current; return save({ ...latest, drafts: { ...latest.drafts, [conversation.id]: draft } }) }
    const beforeUnload = (event: BeforeUnloadEvent) => { if (!flushDraft() || composerFilesBusy) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('pagehide', flushDraft)
    window.addEventListener('beforeunload', beforeUnload)
    return () => { window.removeEventListener('pagehide', flushDraft); window.removeEventListener('beforeunload', beforeUnload) }
  }, [composerOpen, draft, conversation.id, composerFilesBusy, storageReady])

  function openConversation(id: string, reveal = false) {
    if (!preserveDraft()) return false
    setSelectedId(id)
    setComposerOpen(false)
    setNotice('')
    void changeConversations(expandRows([id]), { unread: false }, false)
    if (reveal) requestAnimationFrame(() => revealConversation())
    return true
  }

  function beginReply(id = conversation.id) {
    if (composerOpen && id === selectedId) { const shell = readingPane.current?.querySelector<HTMLElement>('.composer-shell'); if (shell) revealComposer(shell); return }
    if (id !== selectedId && !openConversation(id)) return
    setDraft(richDraft(local.drafts[id]))
    setComposerOpen(true)
    setNotice('')
  }

  async function send(mail: ComposedMail) {
    if (sendBusy || !mailbox.connection || !draft.text.trim() || delivery || conversation.outgoing) return
    const targetId = conversation.id
    const revision = latestStates.current.find((item) => item.id === targetId)?.revision
    if (revision === undefined) return
    const requestId = local.sendRequests?.[targetId] ?? crypto.randomUUID()
    const saved = { ...local, drafts: { ...local.drafts, [targetId]: draft }, sendRequests: { ...local.sendRequests, [targetId]: requestId } }
    if (!save(saved)) return
    setSendBusy(true)
    setNotice('')
    try {
      const result = await sendReply({ data: { id: targetId, revision, ...mail, requestId } })
      if (result.ok) {
        const latest = localRef.current
        const drafts = { ...latest.drafts }; delete drafts[targetId]
        const sendRequests = { ...latest.sendRequests }; delete sendRequests[targetId]
        if (save({ ...latest, drafts, sendRequests }) && currentConversation.current === targetId) { setDraft({ text: '', html: '' }); setComposerOpen(false) }
        await deleteDraftFiles(`${storageKey}:${targetId}`).catch(() => {})
        setNotice(t(result.sentCopy ? "Réponse acceptée par le serveur SMTP." : "Réponse acceptée par SMTP ; copie dans Envoyés non confirmée. Ne renvoyez pas le mail."))
      } else setNotice(t(result.error ?? "Envoi non confirmé. Le brouillon est conservé ; vérifiez Envoyés avant de réessayer."))
      await refreshMailbox(false).then(fresh => {
        const sent = fresh.conversations.find(item => item.id === `sent_${requestId}`)
        if (result.ok && sent && currentConversation.current === targetId) {
          setSelectedId(sent.id)
          requestAnimationFrame(() => {
            const message = [...(readingPane.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])].find(element => element.dataset.messageId === sent.id)
            if (message) revealInReader(message)
          })
        }
      }).catch(() => { setConversationFailed(true); setConversationFeedback(t("Actualisation impossible. Vos données restent affichées.")) })
    } catch { setNotice(t("Envoi non confirmé. Le brouillon est conservé ; vérifiez Envoyés avant de réessayer.")) }
    finally { setSendBusy(false) }
  }

  function selectProject(id: string | null, threadId?: string) {
    const first = threadId ?? mailboxRows(filterConversations(mailbox, id, query), displayMode, listOrder)[0]?.id
    if (first ? !openConversation(first, !!threadId) : !preserveDraft()) return
    setProjectId(id)
    setView('mail')
    setStatus('all')
    setLabelId(null)
    setComposerOpen(false)
    clearSelection()
    if (!threadId) readingPane.current?.parentElement?.scrollTo({ top: 0 })
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

  // Past the offline deadline the mailbox is hidden until the user is back online and signed in.
  if (offlineLocked) return <main className="offline-lock" role="alert"><h1>{t("Reconnexion nécessaire")}</h1>
    <p>{t("L’accès hors connexion a expiré : il s’arrête à la fin de votre session ({0} h au plus). Reconnectez-vous au réseau puis à Postfold.", OFFLINE_HOURS)}</p>
    <p>{t("Vos brouillons et vos {0} modification{1} en attente restent sur cet appareil.", outbox.length, outbox.length > 1 ? 's' : '')}</p>
    <button className="primary-button" disabled={!online} onClick={() => location.reload()}>{t("Se reconnecter")}</button></main>

  return (
    <div className="workspace">
      <aside className="sidebar" aria-label={t("Navigation principale")}>
        <a className="brand" href={`/?lang=${locale}`} aria-label={t("Postfold, accueil")}><img className="brand-mark" src="/icon.svg" width="30" height="30" alt="" />Postfold<span className="brand-label">{t("Support")}</span></a>
        <div className="workspace-name"><span className="workspace-avatar">S</span><div>{t("Équipe support")}<small>{mailbox.connection?.email ?? t("Espace de démonstration")}</small></div></div>
        <nav className="main-nav">
          <button className={view === 'mail' && !projectId ? 'nav-button active' : 'nav-button'} onClick={() => selectProject(null)}><Icon name="mail" />{t("Boîte de réception")}<b>{mailbox.counts ? displayMode === 'threads' ? mailbox.counts.threads : mailbox.counts.messages : mailboxRows(mailbox.conversations, displayMode).length}</b></button>
          <button className={view === 'contacts' ? 'nav-button active' : 'nav-button'} onClick={() => { if (!preserveDraft()) return; setView('contacts'); setComposerOpen(false); setNotice(''); clearSelection() }}><Icon name="users" />{t("Contacts")}{windowed ? null : <b>{mailbox.contacts.length}</b>}</button>
          <button className={view === 'settings' ? 'nav-button active' : 'nav-button'} onClick={() => { if (!preserveDraft()) return; setView('settings'); setComposerOpen(false); clearSelection() }}><Icon name="settings" />{t('Réglages')}</button>
        </nav>
        <ProjectFolders mailbox={mailbox} opened={local.openFolders ?? []} onOpenedChange={(openFolders) => save({ ...localRef.current, openFolders })} counts={mailbox.counts?.folders} revision={folderSettings.revision} currentId={view === 'mail' ? projectId : null} sort={folderSettings.sort} order={folderSettings.order} disabled={folderBusy || !online} allowDelete={!mailbox.connection} dropTarget={dropTarget} movingMail={!!draggingIds.length}
          onSelect={selectProject} onSave={saveFolder} onSort={sortFolders} onReorder={reorderFolder} onDelete={async (id, revision) => { const projects = mailbox.projects.filter((item) => item.id !== id); const failure = await commitFolders({ ...folderSettings, revision, projects, order: folderSettings.order.filter((item) => item !== id) }); if (!failure && projectId === id) setProjectId(null); return failure }}
          onMailOver={(event, id) => { if (!dragSession.current.length) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(id) }}
          onMailLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null) }}
          onMailDrop={(event, id) => { if (!dragSession.current.length) return; event.preventDefault(); move(dragSession.current, id); finishDrag() }} />
        <LabelManager labels={mailbox.labels ?? []} conversations={mailbox.conversations} counts={mailbox.counts?.labels} revision={folderSettings.revision} disabled={folderBusy || !online} selectedId={activeLabel} onSelect={(id) => { setLabelId(id); setView('mail'); clearSelection() }} onSave={async (labels, revision) => { const failure = await commitFolders({ ...folderSettings, labels, revision }); if (!failure) await refreshMailbox(); return failure }} />
        {folderFeedback ? <p className={`folder-feedback ${folderFailed ? 'failed' : ''}`} role={folderFailed ? 'alert' : 'status'}>{folderFeedback}</p> : null}
        <div className="sidebar-bottom"><span className="user-avatar">{mailbox.viewer ? initials(mailbox.viewer.name) : mailbox.connection ? 'PF' : 'JD'}</span><div>{mailbox.viewer?.name ?? t(mailbox.connection ? "Boîte partagée" : "Julie · Démo")}<small>{mailbox.viewer ? 'Keycloak SSO' : t("Votre espace de travail")}</small></div></div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="breadcrumb"><span>{t("Support")}</span><Icon name="chevron" /><strong>{view === 'settings' ? t('Gestion de la boîte') : view === 'contacts' ? t("Contacts") : selectedProject?.name ?? t("Tous les échanges")}</strong></div>
          <div className="header-indicators">
            <select className="language-switch" aria-label={t("Langue")} value={locale} onChange={(event) => { setConversationFeedback(''); setFolderFeedback(''); setNotice(''); void navigate({ search: { lang: event.target.value === 'en' ? 'en' : 'fr' }, replace: true }) }}><option value="fr">FR</option><option value="en">EN</option></select>
            <MailboxRefresh onRefresh={refreshMailbox} connected={!!mailbox.connection} online={online} automatic={local.autoRefresh ?? true} onAutomaticChange={(autoRefresh) => save({ ...localRef.current, autoRefresh })} />
            {mailbox.viewer ? <><span className="identity-badge" title={mailbox.viewer.email}><span className="user-avatar">{initials(mailbox.viewer.name)}</span><span>{mailbox.viewer.name}</span></span><form action="/auth/logout" method="post" onSubmit={(event) => { if (!preserveDraft()) event.preventDefault(); else forgetOfflineCopy(true) }}><button className="secondary-button" type="submit">{t("Se déconnecter")}</button></form></> : null}
            {!mailbox.connection && !mailbox.viewer ? <div className="presence-group">
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
        {!online || outbox.length ? <p className={`offline-banner ${online ? 'sending' : ''}`} role="status">{online
          ? t("Envoi de {0} modification{1} faite{1} hors ligne…", outbox.length, outbox.length > 1 ? 's' : '')
          : t("Hors ligne. Lu, statut, dossier, labels et attribution restent modifiables ({0} en attente, envoyé{1} au retour du réseau). Réponses, gestion des dossiers et relève reprendront en ligne.", outbox.length, outbox.length > 1 ? 's' : '')}</p> : null}
        {mailbox.connection ? <SyncProgressBanner onCycle={() => { void refreshMailbox(false).catch(() => {}) }} /> : null}
        {error ? <div role="alert" className="error-banner">{error}</div> : null}
        {conversationFeedback ? <div role={conversationFailed ? 'alert' : 'status'} className={`conversation-feedback ${conversationFailed ? 'failed' : ''}`}>{conversationFeedback}</div> : null}
        {view === 'settings' ? <Suspense fallback={<p>{t('Chargement…')}</p>}><AuthoringPage projects={mailbox.projects} connected={!!mailbox.connection} tab={settingsTab} onTab={setSettingsTab} onUpdated={() => { void refreshMailbox(false) }} /></Suspense> : <div className="content-grid" data-contact-collapsed={contactCollapsed}>
          <section className="conversation-list" aria-label={view === 'contacts' ? t("Liste des contacts") : t("Liste des conversations")} onKeyDown={(event) => {
            if (view !== 'mail' || (event.target as HTMLElement).closest('textarea, select, input:not([type="checkbox"])')) return
            if (event.key === 'Escape') clearSelection()
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); setChosenIds(visibleIds) }
          }}>
            <div className="list-header">
            <div className="list-heading"><span className="eyebrow">{view === 'contacts' ? t("Carnet d’adresses") : t(displayMode === 'threads' ? "Conversations" : "Messages")}</span><h1>{view === 'contacts' ? t("Contacts") : selectedProject ? projectPath(mailbox.projects, selectedProject.id) : t("Boîte de réception")}</h1></div>
            {view === 'contacts' && windowed ? <div className="search-field"><Icon name="search" /><input aria-label={t("Rechercher un contact")} placeholder={t("Nom ou adresse…")} value={contactQuery} onChange={(event) => setContactQuery(event.target.value)} /></div> : null}
            {view === 'mail' ? <>
              <div className="list-options">
              <label className="display-mode"><span>{t("Affichage")}</span><select aria-label={t("Mode d’affichage")} value={displayMode} disabled={!storageReady} onChange={(event) => {
                const next = event.target.value === 'threads' ? 'threads' : 'messages'
                const drafts = composerOpen ? { ...local.drafts, [conversation.id]: draft } : local.drafts
                if (save({ ...local, drafts, displayMode: next })) {
                  clearSelection(); setNotice('')
                  if (next === 'threads') {
                    const messages = mailbox.conversations.filter(item => threadKey(item) === threadKey(conversation)).sort((a, b) => compareMessages(a, b, 'oldest'))
                    if (!composerOpen) setSelectedId(messages.at(-1)!.id)
                    void changeConversations(messages.map(item => item.id), { unread: false }, false)
                  }
                }
              }}><option value="messages">{t("Tous les mails")}</option><option value="threads">{t("Conversations")}</option></select></label>
              <label className="mail-order"><span>{t("Ordre")}</span><select aria-label={t("Ordre de la liste")} value={listOrder} disabled={!storageReady} onChange={(event) => {
                const drafts = composerOpen ? { ...local.drafts, [conversation.id]: draft } : local.drafts
                if (save({ ...local, drafts, listOrder: event.target.value === 'oldest' ? 'oldest' : 'newest' })) clearSelection()
              }}><option value="newest">{t("Plus récent")}</option><option value="oldest">{t("Plus ancien")}</option></select></label>
              {mailbox.members?.length ? <label className="member-filter" title={t("Mails attribués à cette personne, ou auxquels elle a répondu, ou dont elle a changé le statut, le dossier ou les labels")}><span>{t("Traité par")}</span><select aria-label={t("Traité par")} value={memberId ?? ''} onChange={(event) => { setMemberId(event.target.value || null); clearSelection() }}>
                <option value="">{t("Traités par tout le monde")}</option>
                {mailbox.members.filter((member) => member.active !== false || member.id === memberId).map((member) => <option key={member.id} value={member.id}>{member.id === mailbox.currentMemberId ? t("{0} (moi)", member.name) : member.name}</option>)}
              </select></label> : null}
              </div>
              <div className="search-field"><Icon name="search" /><input aria-label={t("Rechercher les échanges")} placeholder={t("Rechercher un échange…")} value={query} onChange={(event) => { setQuery(event.target.value); clearSelection() }} /></div>
              <div className="filters" role="group" aria-label={t("État des conversations")}>{[['all', t("Tous")], ['unread', t("Non lus")], ['open', t("À traiter")], ['waiting', t("En attente")], ['closed', t("Terminés")]].map(([key, label]) => <button key={key} aria-pressed={status === key} onClick={() => { setStatus(key); clearSelection() }}>{label}</button>)}</div>
              <div className="list-tools" ref={bulkTools} onKeyDown={(event) => {
                if (event.key === 'Escape' && !event.defaultPrevented && bulkOpen) {
                  event.preventDefault(); event.stopPropagation(); setBulkOpen(false); bulkTrigger.current?.focus()
                }
              }}>
                <label className="selection-hit"><input type="checkbox" aria-label={t("Sélectionner toutes les conversations affichées")} checked={allChosen} disabled={!rows.length} ref={(node) => { selectAllControl.current = node; if (node) node.indeterminate = chosen.length > 0 && !allChosen }} onChange={(event) => { setBulkOpen(false); setChosenIds(event.target.checked ? visibleIds : []); selectionAnchor.current = null }} /></label>
                <span aria-live="polite">{chosen.length ? t("{0} sélectionnée{1}", chosen.length, chosen.length > 1 ? 's' : '') : t(displayMode === 'threads' ? "{0} conversation{1}" : "{0} mail{1}", listTotal, listTotal > 1 ? 's' : '')}</span>
                {chosen.length ? <>
                  <button className="bulk-trigger" ref={bulkTrigger} aria-expanded={bulkOpen} aria-controls={bulkOpen ? 'bulk-actions' : undefined} onClick={() => setBulkOpen(!bulkOpen)}>{t("Actions")}<Icon name="chevron" /></button>
                  <button className="clear-selection" aria-label={t("Annuler la sélection")} onClick={clearSelection}><Icon name="close" /></button>
                  {bulkOpen ? <div className="bulk-actions" id="bulk-actions" role="group" aria-label={t("Actions du lot")} ref={(node) => {
                    if (!node) return
                    const update = () => node.style.setProperty('--menu-top', `${node.getBoundingClientRect().top}px`)
                    const observer = new ResizeObserver(update)
                    observer.observe(node.closest('.content-grid')!)
                    observer.observe(node.closest('.list-header')!)
                    window.addEventListener('resize', update)
                    update()
                    return () => { observer.disconnect(); window.removeEventListener('resize', update) }
                  }}><ConversationActions disabled={stateBusy} onChange={(patch) => changeConversations(chosenMessages, patch)} /><ProjectPicker projects={sortProjects(mailbox.projects, folderSettings.sort, folderSettings.order)} disabled={stateBusy || !storageReady} onSelect={(targetId) => move(chosen, targetId)} /><LabelPicker labels={mailbox.labels ?? []} conversations={mailbox.conversations.filter((item) => chosenMessages.includes(item.id))} disabled={stateBusy} onChange={(patch) => changeConversations(chosenMessages, patch)} /><AssignmentPicker members={mailbox.members ?? []} currentId={mailbox.currentMemberId} conversations={mailbox.conversations.filter((item) => chosenMessages.includes(item.id))} disabled={stateBusy} onChange={(patch) => changeConversations(chosenMessages, patch)} /><small>{t("Maj : sélectionner une plage · Ctrl / ⌘ : ajouter")}</small></div> : null}
                </> : null}
              </div>
            </> : null}
            </div>
            <div className="list-rows" tabIndex={0} role="region" aria-label={view === 'contacts' ? t("Liste des contacts") : t("Liste des conversations")}>
              {view === 'mail' ? rows.length ? <>{shownRows.map((item) => {
                const sender = item.sender ?? mailbox.contacts.find((person) => person.id === item.contactId)!
                const folder = mailbox.projects.find((folder) => folder.id === item.projectId)!
                return <div key={item.id} data-conversation-id={item.id} data-folder-id={item.projectId} className={`thread-row ${item.unread ? 'unread' : ''} ${item.messageIds.includes(selectedId) ? 'selected' : ''} ${chosen.includes(item.id) ? 'checked' : ''} ${draggingIds.includes(item.id) ? 'dragging' : ''}`} draggable={storageReady} onDragStart={(event) => startDrag(event, item.id)} onDragEnd={finishDrag}>
                  <label className="selection-hit row-selection"><input type="checkbox" aria-label={t("Sélectionner {0}", item.subject)} checked={chosen.includes(item.id)} onChange={(event) => choose(item.id, event.target.checked, event.nativeEvent instanceof MouseEvent && event.nativeEvent.shiftKey)} /></label>
                  <button className="thread-open" aria-pressed={item.messageIds.includes(selectedId)} onPointerEnter={() => { if (mailbox.connection) item.messageIds.slice(-3).forEach(prefetchMessage) }} onFocus={() => { if (mailbox.connection) item.messageIds.slice(-3).forEach(prefetchMessage) }} onClick={(event) => {
                    if (event.shiftKey || event.metaKey || event.ctrlKey) { choose(item.id, event.shiftKey || !chosen.includes(item.id), event.shiftKey); return }
                    if (openConversation(displayMode === 'threads' ? item.messageIds.at(-1)! : item.id, true)) { clearSelection(); selectionAnchor.current = item.id }
                  }}>
                  <div className="row-top"><strong>{sender.name}</strong><time>{t(item.time)}</time></div>
                  <div className="row-subject">{item.unread ? <span className="unread-dot" title={t("Non lu")}><span className="sr-only">{t("Non lu :")} </span></span> : <span className="sr-only">{t("Lu :")} </span>}{item.subject}{displayMode === 'threads' && item.messageIds.length > 1 ? <span className="thread-count" title={t("{0} mails dans ce fil", item.messageIds.length)}>{item.messageIds.length}</span> : null}</div>
                  <p title={item.preview}>{item.preview}</p><div className="row-bottom"><span className="folder-label" title={projectPath(mailbox.projects, folder.id)}>{projectPath(mailbox.projects, folder.id)}</span>{item.assignee ? <span className="row-assignee" title={t("Attribué à {0}", item.assignee)} aria-label={t("Attribué à {0}", item.assignee)}>{initials(item.assignee)}</span> : null}<span className={`status ${item.status}`}>{t(statuses[item.status])}</span></div>{item.labelIds?.length ? <div className="message-labels">{(mailbox.labels ?? []).filter((label) => item.labelIds?.includes(label.id)).map((label) => <span className="label-chip" key={label.id}><span className="project-dot" style={{ backgroundColor: projectColor(label.color) }} />{label.name}</span>)}</div> : null}
                  </button>
                </div>
              })}{shownRows.length < rows.length || mailbox.page?.nextCursor ? <div key={`${shownRows.length}:${mailbox.conversations.length}`} ref={moreRows} className="list-more" aria-hidden="true" /> : null}{listBusy ? <div className="empty-state">{t("Chargement…")}</div> : null}</> : <div className="empty-state">{listBusy ? t("Chargement…") : t("Aucun échange ne correspond à votre recherche.")}</div> : (contactResults ?? mailbox.contacts).map((person) => <button className={`contact-row ${person.id === contactId ? 'selected' : ''}`} key={person.id} onClick={() => { setContactId(person.id); setNotice('') }}>
              <span className="contact-avatar">{initials(person.name)}</span><span><strong>{person.name}</strong><small>{person.company}</small></span><span className="contact-arrow"><Icon name="chevron" /></span>
            </button>)}
            </div>
          </section>

          <section className="reading-pane" ref={readingPane} tabIndex={0} aria-label={view === 'mail' ? t("Conversation sélectionnée") : t("Historique du contact")}>
            {view === 'mail' ? showConversation ? <>
              <header className="reading-context"><div><strong title={displayMode === 'threads' ? threadSubject : conversation.subject}>{displayMode === 'threads' ? threadSubject : conversation.subject}</strong><small title={participants.map(person => person.name).join(', ')}>{projectPath(mailbox.projects, project.id)} · {participants.map(person => person.name).join(', ') || replyContact.name}</small></div><span className={`status ${conversation.status}`}>{t(statuses[conversation.status])}</span><button className="icon-button" title={t('Préparer une réponse')} aria-label={t('Préparer une réponse')} onClick={() => beginReply()} disabled={conversation.outgoing}><Icon name="reply" /></button><button className="icon-button contact-toggle" aria-controls="contact-profile" aria-expanded={!contactCollapsed} aria-label={t(contactCollapsed ? 'Afficher la fiche contact' : 'Masquer la fiche contact')} title={t(contactCollapsed ? 'Afficher la fiche contact' : 'Masquer la fiche contact')} disabled={!storageReady} onClick={toggleContact}><Icon name="users" /></button></header>
              <div className="reading-toolbar"><ConversationActions unread={threadMessages.some((item) => item.unread)} status={conversation.status} disabled={stateBusy} onChange={(patch) => changeConversations(readingIds, patch)} /><LabelPicker labels={mailbox.labels ?? []} conversations={threadMessages} disabled={stateBusy} onChange={(patch) => changeConversations(readingIds, patch)} /><AssignmentPicker members={mailbox.members ?? []} currentId={mailbox.currentMemberId} conversations={threadMessages} disabled={stateBusy} onChange={(patch) => changeConversations(readingIds, patch)} /></div>
              <div className="message-heading"><span className="eyebrow">{projectPath(mailbox.projects, project.id)}</span><div className="message-subject"><h2>{displayMode === 'threads' ? threadSubject : conversation.subject}</h2>
                {filingSuggestions.length ? <div className="filing-suggestions" role="group" aria-label={t('Classement proposé')}>
                  {filingSuggestions.map((target) => {
                    const label = t(displayMode === 'threads' ? 'Ranger la conversation dans {0}' : 'Ranger le mail dans {0}', projectPath(mailbox.projects, target.id))
                    return <button key={target.id} className="filing-suggestion" title={label} aria-label={label} disabled={stateBusy || !storageReady || threadMessages.some((item) => item.imapReady === false)} onClick={() => void move(readingIds, target.id)}><Icon name="folder" />{t('Ranger → {0}', target.code ?? target.id)}</button>
                  })}
                </div> : null}
              </div><p>{t("Un échange avec")} {participants.map((person) => person.name).join(', ') || replyContact.name}</p>
                {displayMode === 'threads' ? <div className="thread-options"><span>{t("{0} mails dans ce fil", threadMessages.length)}</span><label className="mail-order"><span>{t("Ordre")}</span><select aria-label={t("Ordre des messages du fil")} value={conversationOrder} disabled={!storageReady} onChange={(event) => {
                  const drafts = composerOpen ? { ...local.drafts, [conversation.id]: draft } : local.drafts
                  const order = event.target.value === 'oldest' ? 'oldest' : 'newest'
                  if (save({ ...local, drafts, conversationOrder: order })) requestAnimationFrame(() => revealConversation(order))
                }}><option value="newest">{t("Plus récent")}</option><option value="oldest">{t("Plus ancien")}</option></select></label></div> : null}
              </div>
              {threadMessages.map((message) => {
                const sender = message.sender ?? mailbox.contacts.find((item) => item.id === message.contactId)!
                const header = <><span className="contact-avatar">{initials(sender.name)}</span><div><strong>{sender.name}</strong><small>{sender.email}</small></div><time dateTime={message.sentAt} title={message.sentAt ? new Date(message.sentAt).toLocaleString(locale === 'en' ? 'en-GB' : 'fr-FR') : undefined}>{t(message.time)}</time></>
                const body = <><MessageBody id={message.id} text={message.body} sender={sender.email} live={!!mailbox.connection} /><button className="message-reply secondary-button" disabled={message.outgoing} onClick={() => beginReply(message.id)}><Icon name="reply" />{t("Répondre à ce mail")}</button></>
                return displayMode === 'threads' ? <details className="message thread-message" key={message.id} data-message-id={message.id} open={message.id === selectedId || message.id === threadMessages[conversationOrder === 'oldest' ? threadMessages.length - 1 : 0]?.id}><summary>{header}<Icon name="chevron" /></summary>{body}</details> : <article className="message" key={message.id} data-message-id={message.id}><header>{header}</header>{body}</article>
              })}
              {composerOpen ? <Suspense fallback={<p>{t('Chargement de l’éditeur…')}</p>}><MailComposer key={`${conversation.id}:${storageKey}`} draft={draft} onReady={revealComposer} onChange={setDraft} recipient={replyContact} subject={conversation.subject} storageKey={`${storageKey}:${conversation.id}`} busy={sendBusy} feedback={notice} saved={JSON.stringify(richDraft(local.drafts[conversation.id])) === JSON.stringify(draft)} sendDisabled={!online || !mailbox.connection || !storageReady || stateBusy || !!delivery || !!conversation.outgoing} sendHint={t(!online ? 'Hors ligne : l’envoi reprendra une fois reconnecté. Le brouillon reste sur cet appareil.' : !mailbox.connection ? 'Connectez une boîte mail pour envoyer.' : delivery ? delivery.status === 'sent' ? 'Une réponse a déjà été envoyée à ce mail.' : 'Envoi en cours ou incertain : vérifiez Envoyés, ne renvoyez pas.' : 'Le brouillon sera sauvegardé avant l’envoi.')} onSave={() => { if (save({ ...localRef.current, drafts: { ...localRef.current.drafts, [conversation.id]: draft } })) setNotice(t('Brouillon enregistré dans ce navigateur. Aucun email envoyé.')) }} onFilesBusy={setComposerFilesBusy} onSend={mail => void send(mail)} /></Suspense> : <div className="reply-bar"><span>{conversation.outgoing ? t("Message envoyé") : local.drafts[conversation.id] ? t("Brouillon enregistré") : t("Aucune réponse préparée")}</span><button className="primary-button" disabled={conversation.outgoing} onClick={() => beginReply()}><Icon name="reply" />{local.drafts[conversation.id] ? t("Reprendre le brouillon") : t("Préparer une réponse")}</button></div>}
              <ConversationActivity key={conversation.id} ids={readingIds} version={readingIds.map((id) => latestStates.current.find((item) => item.id === id)?.revision).join(",") + JSON.stringify(mailbox.deliveries ?? [])} />
            </> : <div className="empty-folder"><span className="empty-folder-icon" style={{ color: projectColor(selectedProject?.color ?? 'slate') }}><Icon name="folder" /></span><span className="eyebrow">{selectedProject ? projectPath(mailbox.projects, selectedProject.id) : t("Dossier indisponible")}</span><h2>{t("Ce dossier est vide")}</h2><p>{t("Déposez des conversations dans ce dossier ou utilisez « Déplacer vers un projet » depuis la boîte de réception.")}</p></div> : <div className="contact-history"><span className="eyebrow">{t("Historique des échanges")}</span><h2>{t("Les échanges avec")} {contact.name.split(' ')[0]}</h2><p>{t("Tous les projets et conversations associés à ce contact.")}</p>{mailbox.conversations.filter((item) => includesContact(item, contact)).map((item) => <button className="history-item" key={item.id} onClick={() => selectProject(item.projectId, item.id)}><span><strong>{item.subject}</strong><small>{mailbox.projects.find((project) => project.id === item.projectId)?.name}</small></span><span className={`status ${item.status}`}>{t(statuses[item.status])}</span></button>)}</div>}
            {notice ? <p role="status" className="notice">{notice}</p> : null}
          </section>

          {(view === 'contacts' && mailbox.contacts.length > 0) || showConversation ? <aside id="contact-profile" className="contact-panel" hidden={contactCollapsed} tabIndex={0} aria-label={t("Fiche du contact")}>
            <div className="contact-panel-heading"><span className="section-label">{t("Fiche contact")}</span>{view === 'mail' ? <button className="icon-button" aria-label={t("Masquer la fiche contact")} title={t("Masquer la fiche contact")} disabled={!storageReady} onClick={toggleContact}><Icon name="close" /></button> : null}</div>
            {view === 'mail' && participants.length > 1 ? <div className="thread-participants" role="group" aria-label={t("Participants de la conversation")}><h3>{t("Participants")} <span>{participants.length}</span></h3>{participants.map((person) => <button key={person.id} aria-pressed={person.id === contact.id} onClick={() => { setInspectedContact({ threadId: threadKey(conversation), id: person.id }); setNotice('') }}><span className="contact-avatar">{initials(person.name)}</span><span><strong>{person.name}</strong><small>{person.email}</small></span></button>)}</div> : null}
            <div className="profile-avatar">{initials(contact.name)}</div><h2>{contact.name}</h2><p className="company">{contact.company}</p>
            <dl className="contact-details"><dt>{t("Email")}</dt><dd>{contact.email}</dd><dt>{t("Téléphone")}</dt><dd>{contact.phone}</dd></dl>
            <div className="panel-section"><h3>{t("Projets associés")}</h3>{mailbox.projects.filter((item) => mailbox.conversations.some((thread) => includesContact(thread, contact) && thread.projectId === item.id)).map((item) => <button key={item.id} className="linked-project" onClick={() => selectProject(item.id)}><span className="project-dot" style={{ backgroundColor: projectColor(item.color) }} /><span>{projectPath(mailbox.projects, item.id)}</span><Icon name="arrow" /></button>)}</div>
            <div className="panel-section"><h3>{t("Notes internes")} <span>{contactNotes.length}</span></h3>{contactNotes.map((item) => <article className="contact-note" key={item.id}><p>{item.body}</p><small>{mailbox.connection ? t("Note locale") : "Julie"} · {new Date(item.createdAt).toLocaleDateString(locale === 'en' ? 'en-GB' : 'fr-FR')}</small></article>)}
              <form onSubmit={(event) => { event.preventDefault(); const body = note.trim(); if (!body) return; if (save({ ...local, notes: [...local.notes, { id: crypto.randomUUID(), contactId: contact.id, body, createdAt: new Date().toISOString() }] })) { setNote(''); setNotice(t("Note enregistrée dans ce navigateur.")) } }}>
                <label className="sr-only" htmlFor="contact-note">{t("Ajouter une note sur")} {' '}{contact.name}</label><textarea id="contact-note" value={note} onChange={(event) => setNote(event.target.value)} placeholder={t("Un détail utile pour la prochaine fois…")} rows={4} maxLength={5000} />
                <button className="note-button" disabled={!storageReady || !note.trim()} type="submit"><Icon name="plus" />{t("Ajouter une note")}</button>
              </form><small className="private-hint">{t("Visible ici uniquement · jamais envoyé au contact")}</small>
            </div>
          </aside> : null}
        </div>}
      </main>
      <div className="drag-ghost" hidden ref={ghostTemplate} aria-hidden="true"><div className="ghost-card"><span className="ghost-icon"><Icon name="mail" /></span><div><strong className="ghost-title" /><small>{t("Déplacer vers un projet")}</small></div><b className="ghost-count" /></div></div>
    </div>
  )
}
