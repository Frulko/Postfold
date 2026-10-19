import { BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { ImapFlow, type FetchMessageObject, type ListResponse } from 'imapflow'
import nodemailer from 'nodemailer'
import { simpleParser } from 'mailparser'
import { cleanEmailHtml, cleanIncomingHtml } from './email-html.js'
import { ProjectStore } from './project-store.js'
import { loadAccount, saveAccount } from './mail-secrets.js'
import { isMailAccountUpdate, isMailAddress, isReplyRequest, type MailAccount, type MailAccountSettings } from '../shared/mail-account.js'
import { isConversationUpdate, applyConversationStates } from '../shared/conversation-state.js'
import { isProjectSettings, projectPath } from '../shared/projects.js'
import { isMailboxQuery, type Contact, type Conversation, type ConversationState, type ConversationUpdate, type DemoMailbox, type MailboxCounts, type MailboxQuery, type MailLogEntry, type Member, type Project, type SyncProgress } from '../shared/mailbox.js'
import { isArchiveId, isArchiveSearch, isArchiveRestore, isMessageRef, isAttachmentRef, type MailArchiveEntry, type MailArchivePage, type MessageContent } from '../shared/mail-archive.js'

type CachedMessage = { id: string; path: string; validity: string; uid: number; raw_id: string | null; source_sha256?: string | null; data: Conversation & { replyTo?: string; references?: string[]; receivedAt?: string } }
type Folder = { id: string; path: string }
type InventoryItem = { path: string; validity: string; projectId: string; message: FetchMessageObject }
class SyncPaused extends Error {}
// ponytail: fixed pacing; expose as settings if a provider needs different batch durations.
const CYCLE_IMPORT_MS = 60_000 // Import time per cycle, so the mailbox lock is released at least once a minute.
const FETCH_CHUNK = 50 // Message bodies per IMAP FETCH; the time budget is checked between chunks.
const SAVE_CHUNK = 200 // Rows per set-based upsert.
const FOLDER_LOG_MIN = 20 // Smaller folder imports are summarized in one line.
const LISTING_REUSE_MS = 5 * 60_000 // Folder listing reuse while an import continues, on servers without LIST-STATUS.
const INVENTORY_MAX_AGE_MS = 60 * 60_000 // Unchanged folders are still rescanned hourly, for servers without CONDSTORE.
const folderStatus = { messages: true, uidNext: true, uidValidity: true, unseen: true, highestModseq: true }
const cycleStarts = { scheduled: 'Synchronization started', manual: 'Synchronization started on request', resume: 'Synchronization resumed to continue the import',
  startup: 'Synchronization started after startup', settings: 'Synchronization started after a settings change' }
const LIST_PAGE = 200 // Messages per list window.
// A reply or a change of status, folder, labels or assignee counts as handling; opening a mail only marks it read.
const handledActivity = `kind = 'reply' OR ${['status', 'projectId', 'labelIds', 'assigneeId'].map((key) => `data->'before'->'${key}' IS DISTINCT FROM data->'after'->'${key}'`).join(' OR ')}`
// Diacritic-insensitive search like the browser filter; PostgreSQL extensions such as unaccent are not required.
const searchable = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('fr')
const searchText = `lower(translate(concat_ws(' ', m.data->>'subject', m.data->>'preview', m.data->'sender'->>'name', m.data->'sender'->>'email', m.data->>'replyTo', m.data->>'participants'), 'ÀÂÄÁÃÅÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÇÑÝàâäáãåéèêëíìîïóòôöõúùûüçñýÿ', 'AAAAAAEEEEIIIIOOOOOUUUUCNYaaaaaaeeeeiiiiooooouuuucnyy'))`
const descendantIds = (projects: Project[], id: string) => {
  const ids = [id]
  for (let index = 0; index < ids.length; index++) for (const project of projects) if (project.parentId === ids[index]) ids.push(project.id)
  return ids
}
const contactsOf = (conversations: Conversation[]) => {
  const contacts = new Map<string, Contact>()
  for (const message of conversations) {
    const source = message as CachedMessage['data']
    const email = source.replyTo ?? source.sender?.email ?? ''
    if (!contacts.has(message.contactId)) contacts.set(message.contactId, { id: message.contactId, name: source.outgoing ? email : source.sender?.name || email, email, company: '', phone: '' })
    for (const person of message.participants ?? []) {
      const id = `c_${hash(person.email.toLowerCase())}`
      const previous = contacts.get(id)
      if (!previous || previous.name === previous.email) contacts.set(id, { ...person, id, company: '', phone: '' })
    }
  }
  return [...contacts.values()]
}
const secondsSince = (start: number) => Math.round((Date.now() - start) / 100) / 10
const MAX_MIME_BYTES = 16 * 1024 * 1024 // Includes base64 MIME overhead for a 10 MiB attachment.
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24)
const sourceHash = (value: Buffer) => createHash('sha256').update(value).digest('hex')
const emptyMailbox = { projects: [{ id: 'inbox', name: 'INBOX', color: 'blue', code: null }], contacts: [], conversations: [] }
const stateSnapshot = "jsonb_build_object('id',s.id,'revision',s.revision,'unread',s.unread,'status',s.status,'projectId',s.project_id,'labelIds',s.label_ids,'assigneeId',s.assignee_id)"
const slot = (path: string, validity: string, uid: number) => JSON.stringify([path, validity, uid])
// PostgreSQL text/jsonb reject NUL characters and lone UTF-16 surrogates (an emoji cut by a preview slice, a broken
// header encoding); one such message used to abort every sync cycle. Lone surrogates become U+FFFD.
const cleanText = (value: string) => value.replace(/\u0000/g, '').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
export const jsonSafe = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === 'string' ? cleanText(item) : item))
// IMAP/SMTP errors carry a code and the server's response text, never the credentials.
const describeError = (error: unknown) => { const item = error as { code?: string; responseText?: string; message?: string } | undefined
  return [item?.code, item?.responseText ?? item?.message].filter(Boolean).join(' · ').slice(0, 300) || 'Unknown error' }
const folderName = (project: Project) => project.parentId || project.code === null ? project.name : `${project.code ?? project.id} - ${project.name}`

export class MailStore extends ProjectStore {
  private account!: MailAccount
  private timer?: ReturnType<typeof setInterval>
  private lastSync: string | null = null
  private syncError = false
  private delimiter = '/'
  private readonly limit = Math.max(1, Math.min(5000, Number(process.env.MAILBOX_SYNC_LIMIT) || 200))
  // ponytail: in-memory ring buffer, lost on restart; the stdout copy keeps the history in container logs.
  private logs: MailLogEntry[] = []
  private logSeq = 0
  // ponytail: per-process inventory cache, rebuilt by one full scan after a restart.
  private inventoryCache = new Map<string, { key: string; at: number; validity: string; messages: FetchMessageObject[] }>()
  private listing: { at: number; listed: ListResponse[] } | null = null
  private syncing = false
  private waiting = 0
  private progress: SyncProgress = { state: 'idle', startedAt: null, folder: null, folders: { done: 0, total: 0 }, batch: { done: 0, total: 0 }, stored: 0, total: 0, rate: null, lastCycle: null, error: null }

  constructor(private accountId = process.env.MAILBOX_ID ?? 'support') {
    super(`imap:${accountId}`, emptyMailbox)
    if (!process.env.DATABASE_URL || !/^[a-z0-9._-]{1,64}$/i.test(accountId)) throw new Error('Live mail requires DATABASE_URL and a valid MAILBOX_ID.')
  }

  override async init() {
    this.account = await loadAccount(this.pool, this.accountId)
    await super.init()
    await this.pool.query(`CREATE TABLE IF NOT EXISTS mail_folders (
      mailbox_id text NOT NULL REFERENCES demo_project_settings(mailbox_id) ON DELETE CASCADE,
      id text NOT NULL, path text NOT NULL, PRIMARY KEY (mailbox_id, id), UNIQUE (mailbox_id, path)
    )`)
    await this.pool.query(`CREATE TABLE IF NOT EXISTS mail_messages (
      mailbox_id text NOT NULL REFERENCES demo_project_settings(mailbox_id) ON DELETE CASCADE,
      id text NOT NULL, path text NOT NULL, validity text NOT NULL, uid bigint NOT NULL, raw_id text,
      data jsonb NOT NULL, PRIMARY KEY (mailbox_id, id), UNIQUE (mailbox_id, path, validity, uid)
    )`)
    await this.pool.query(`CREATE TABLE IF NOT EXISTS mail_sends (
      mailbox_id text NOT NULL REFERENCES demo_project_settings(mailbox_id) ON DELETE CASCADE,
      request_id uuid NOT NULL, target_id text NOT NULL, reply_key text NOT NULL, body_hash text NOT NULL,
      status text NOT NULL CHECK (status IN ('sending', 'sent', 'uncertain')), sent_copy boolean NOT NULL DEFAULT false,
      data jsonb NOT NULL, PRIMARY KEY (mailbox_id, request_id), UNIQUE (mailbox_id, reply_key)
    )`)
    await this.pool.query('ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS source_sha256 text')
    await this.pool.query('ALTER TABLE mail_sends ADD COLUMN IF NOT EXISTS source bytea')
    await this.pool.query('CREATE INDEX IF NOT EXISTS mail_messages_source ON mail_messages (mailbox_id,source_sha256)')
    // Bodies live in their own column: list, search and sync queries read small JSON documents only.
    await this.pool.query('ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS body text')
    for (;;) {
      const { rowCount } = await this.pool.query(`UPDATE mail_messages SET body = data->>'body', data = data - 'body'
        WHERE ctid IN (SELECT ctid FROM mail_messages WHERE mailbox_id = $1 AND data ? 'body' LIMIT 2000)`, [this.mailboxId])
      if (!rowCount) break
    }
    // Ordered windows of the list and thread lookups (assignment inheritance, newest reply, whole threads).
    await this.pool.query("CREATE INDEX IF NOT EXISTS mail_messages_sent ON mail_messages (mailbox_id,(data->>'sentAt'),id)")
    await this.pool.query("CREATE INDEX IF NOT EXISTS mail_messages_thread ON mail_messages (mailbox_id,(data->>'threadId'))")
    // ponytail: bounded MIME blobs stay in PostgreSQL; move blobs to object storage if archive size dominates backups.
    await this.pool.query(`CREATE TABLE IF NOT EXISTS mail_archives (
      mailbox_id text NOT NULL REFERENCES demo_project_settings(mailbox_id) ON DELETE CASCADE,
      id uuid NOT NULL, message_id text NOT NULL, sha256 text NOT NULL, source bytea NOT NULL,
      data jsonb NOT NULL, snapshot jsonb NOT NULL, last_path text NOT NULL, flags text[] NOT NULL,
      internal_date timestamptz NOT NULL, size_bytes integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 16777216),
      archived_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(), missing_since timestamptz,
      restore_status text CHECK (restore_status IN ('sending','sent','uncertain')), restore_request_id uuid,
      PRIMARY KEY (mailbox_id,id), UNIQUE (mailbox_id,message_id,sha256)
    )`)
    await this.pool.query('CREATE INDEX IF NOT EXISTS mail_archives_page ON mail_archives (mailbox_id,archived_at DESC,id DESC)')
    await this.pool.query('CREATE INDEX IF NOT EXISTS mail_archives_source ON mail_archives (mailbox_id,sha256)')
  }

  private async archiveMessage(message: CachedMessage, source: Buffer, flags: string[], internalDate: Date, snapshot?: ConversationState) {
    if (!source.length || source.length > MAX_MIME_BYTES) throw new BadRequestException('Message exceeds the archive size limit.')
    const state = snapshot ?? { id: message.id, revision: 0, unread: message.data.unread, status: message.data.status,
      projectId: message.data.projectId, labelIds: message.data.labelIds ?? [], assigneeId: message.data.assigneeId ?? null }
    const sha = sourceHash(source)
    await this.pool.query(`INSERT INTO mail_archives (mailbox_id,id,message_id,sha256,source,data,snapshot,last_path,flags,internal_date,size_bytes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (mailbox_id,message_id,sha256) DO UPDATE
      SET last_seen_at=now(),missing_since=NULL,restore_status=NULL,flags=EXCLUDED.flags,last_path=EXCLUDED.last_path`,
    [this.mailboxId, randomUUID(), message.id, sha, source, { ...message.data, body: undefined }, state, message.path, flags, internalDate, source.length])
    return sha
  }

  async archives(input: unknown): Promise<MailArchivePage> {
    if (!isArchiveSearch(input)) throw new BadRequestException('Invalid archive search.')
    const { rows: stats } = await this.pool.query(`SELECT count(*)::integer AS messages, COALESCE(sum(size_bytes),0)::float8 AS bytes,
      count(*) FILTER (WHERE missing_since IS NOT NULL)::integer AS missing,
      (SELECT count(*)::integer FROM mail_messages WHERE mailbox_id=$1 AND source_sha256 IS NULL) AS "cachedWithoutSource"
      FROM mail_archives WHERE mailbox_id=$1`, [this.mailboxId])
    const { rows } = await this.pool.query<MailArchiveEntry>(`SELECT id,message_id AS "messageId",data->>'subject' AS subject,
      data->'sender' AS sender,data->>'preview' AS preview,data->>'sentAt' AS "sentAt",archived_at AS "archivedAt",
      missing_since AS "missingSince",last_path AS "lastPath",size_bytes AS bytes,snapshot,restore_status AS "restoreStatus"
      FROM mail_archives a WHERE mailbox_id=$1 AND (NOT $2::boolean OR missing_since IS NOT NULL)
      AND strpos(lower(COALESCE(data->>'subject','') || ' ' || COALESCE(data->'sender'->>'email','') || ' ' || COALESCE(data->'sender'->>'name','') || ' ' || last_path),lower($3))>0
      AND ($4::uuid IS NULL OR (archived_at,id)<(SELECT archived_at,id FROM mail_archives WHERE mailbox_id=$1 AND id=$4::uuid))
      ORDER BY archived_at DESC,id DESC LIMIT 51`, [this.mailboxId, input.missingOnly, input.query.trim(), input.cursor ?? null])
    const items = rows.slice(0, 50)
    return { items, nextCursor: rows.length > 50 ? items.at(-1)!.id : null, stats: stats[0] }
  }

  private async archivedMessage(id: unknown) {
    if (!isArchiveId(id)) throw new BadRequestException('Invalid archive ID.')
    const { rows } = await this.pool.query<{ id: string; message_id: string; sha256: string; source: Buffer; data: CachedMessage['data']; snapshot: ConversationState; flags: string[]; internal_date: Date; missing_since: Date | null; restore_status: string | null }>(
      'SELECT * FROM mail_archives WHERE mailbox_id=$1 AND id=$2', [this.mailboxId, id])
    const item = rows[0]
    if (!item) throw new NotFoundException('Archived message not found.')
    if (sourceHash(item.source) !== item.sha256) throw new ServiceUnavailableException('Archive integrity check failed. The stored copy was preserved.')
    return item
  }

  async archiveSource(id: unknown) { return (await this.archivedMessage(id)).source }

  // ponytail: the archived MIME is re-parsed on each open; cache parsed parts if large mail makes reading slow.
  private async parsedMessage(id: unknown) {
    if (!isMessageRef(id)) throw new BadRequestException('Invalid message ID.')
    const { rows } = await this.pool.query<{ source: Buffer; sha256: string }>(
      'SELECT source,sha256 FROM mail_archives WHERE mailbox_id=$1 AND message_id=$2 ORDER BY last_seen_at DESC LIMIT 1', [this.mailboxId, id])
    if (!rows[0]) throw new NotFoundException('The complete message is not archived yet.')
    if (sourceHash(rows[0].source) !== rows[0].sha256) throw new ServiceUnavailableException('Archive integrity check failed. The stored copy was preserved.')
    return simpleParser(rows[0].source)
  }

  async messageContent(id: unknown): Promise<MessageContent> {
    const parsed = await this.parsedMessage(id).catch(async (error) => {
      if (!(error instanceof NotFoundException)) throw error
      // Not archived yet (or sent before archiving): serve the cached text body.
      const { rows } = await this.pool.query<{ body: string }>(`SELECT body FROM mail_messages WHERE mailbox_id=$1 AND id=$2
        UNION ALL SELECT data->>'body' FROM mail_sends WHERE mailbox_id=$1 AND data->>'id'=$2 LIMIT 1`, [this.mailboxId, id])
      if (!rows[0]) throw error
      return { html: false, text: rows[0].body ?? '', attachments: [] }
    })
    return { html: typeof parsed.html === 'string' ? cleanIncomingHtml(parsed.html) : null, text: parsed.text ?? '',
      attachments: parsed.attachments.flatMap((item, index) => item.related ? [] : [{ index, filename: item.filename || `attachment-${index + 1}`, contentType: item.contentType, size: item.size }]) }
  }

  async messageAttachment(input: unknown) {
    if (!isAttachmentRef(input)) throw new BadRequestException('Invalid attachment.')
    const item = (await this.parsedMessage(input.id)).attachments[input.index]
    if (!item || item.related) throw new NotFoundException('Attachment not found.')
    return { filename: item.filename || `attachment-${input.index + 1}`, contentType: item.contentType, content: item.content.toString('base64') }
  }

  async restoreArchive(input: unknown, actor?: Member) {
    if (!isArchiveRestore(input)) throw new BadRequestException('Invalid archive restoration.')
    if (actor) await this.members(actor)
    return this.exclusive(async () => {
      const client = this.imap()
      try {
        await client.connect()
        if (!(await this.importMailbox(client)).complete) throw new ConflictException('Finish fetching the mailbox before restoring an archive.')
        const item = await this.archivedMessage(input.id)
        const present = await this.pool.query('SELECT 1 FROM mail_messages WHERE mailbox_id=$1 AND source_sha256=$2 LIMIT 1', [this.mailboxId,item.sha256])
        if (!item.missing_since || present.rowCount) throw new ConflictException('This message is already present in IMAP. No copy was added.')
        if (item.restore_status) throw new ConflictException('Restoration is already in progress or unconfirmed. Inspect the mailbox before retrying.')
        const { rows: folders } = await this.pool.query<Folder>('SELECT id,path FROM mail_folders WHERE mailbox_id=$1 AND id=$2', [this.mailboxId, input.folderId])
        if (!folders[0]) throw new BadRequestException('Choose an existing IMAP folder.')
        const requestId = randomUUID()
        const reserved = await this.pool.query(`WITH reserved AS (
          UPDATE mail_archives SET restore_status='sending',restore_request_id=$3 WHERE mailbox_id=$1 AND id=$2 AND restore_status IS NULL RETURNING id
        ) INSERT INTO postfold_activity (mailbox_id,id,conversation_id,actor,kind,data)
          SELECT $1,$3,$4,$5::jsonb,'updated',jsonb_build_object('restoredFromArchive',id,'status','sending') FROM reserved`,
        [this.mailboxId, item.id, requestId, item.message_id, actor ? JSON.stringify({ id: actor.id, name: actor.name }) : null])
        if (reserved.rowCount !== 1) throw new ConflictException('Restoration is already in progress.')
        const finish = (status: 'sent' | 'uncertain') => this.pool.query(`WITH changed AS (
          UPDATE mail_archives SET restore_status=$3 WHERE mailbox_id=$1 AND id=$2 RETURNING restore_request_id
        ) UPDATE postfold_activity SET data=jsonb_set(data,'{status}',to_jsonb($3::text))
          WHERE mailbox_id=$1 AND id IN (SELECT restore_request_id FROM changed)`, [this.mailboxId, item.id, status])
        try {
          const flags = item.flags.filter(flag => ['\\Answered', '\\Flagged', '\\Draft'].includes(flag))
          if (!item.snapshot.unread) flags.push('\\Seen')
          if (!await client.append(folders[0].path, item.source, flags, item.internal_date)) throw new Error('APPEND was not acknowledged')
        } catch {
          await finish('uncertain')
          throw new ServiceUnavailableException('Restoration could not be confirmed. The archive is safe; inspect IMAP before retrying.')
        }
        await finish('sent')
        // An acknowledged APPEND must never become a request to append again after a read failure.
        let synchronized = true
        try { await this.importMailbox(client,item) } catch { synchronized = false; this.syncError = true }
        return { id: item.message_id, synchronized }
      } finally { await client.logout().catch(() => client.close()) }
    }, 60_000)
  }

  startPolling() {
    this.timer = setInterval(() => this.requestSync('scheduled'), 30_000)
    this.timer.unref()
    this.requestSync('startup')
  }

  private tls() {
    return { rejectUnauthorized: true, minVersion: 'TLSv1.2' as const, ...(process.env.MAILBOX_CA_FILE ? { ca: readFileSync(process.env.MAILBOX_CA_FILE) } : {}) }
  }

  private imap(account = this.account) {
    const endpoint = account.imap
    const client = new ImapFlow({ host: endpoint.host, port: endpoint.port, secure: endpoint.security === 'tls',
      ...(endpoint.security === 'starttls' ? { doSTARTTLS: true } : {}),
      auth: { user: endpoint.user, pass: endpoint.password }, tls: this.tls(), logger: false,
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000, disableAutoIdle: true })
    // Protocol errors must not become unhandled events or expose credentials in logs.
    client.on('error', () => {})
    return client
  }

  private smtp(account = this.account) {
    const endpoint = account.smtp
    return nodemailer.createTransport({ host: endpoint.host, port: endpoint.port, secure: endpoint.security === 'tls',
      requireTLS: true, auth: { user: endpoint.user, pass: endpoint.password }, tls: this.tls(),
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000, logger: false, debug: false,
      disableFileAccess: true, disableUrlAccess: true })
  }

  private async adminOnly(actor?: Member) {
    if (!await this.canAdmin(actor ?? { id: 'shared-operator', name: 'Shared operator', email: '' })) throw new ForbiddenException('Only administrators can manage the mail account.')
  }

  private log(level: MailLogEntry['level'], message: string, ...values: (string | number)[]) {
    const entry = { seq: ++this.logSeq, at: new Date().toISOString(), level, message, values }
    this.logs.push(entry)
    if (this.logs.length > 2000) this.logs.shift()
    console[level === 'error' ? 'error' : 'info'](`[postfold] ${level.toUpperCase()} ${message.replace(/\{(\d+)\}/g, (match, index) => String(values[Number(index)] ?? match))}`)
  }

  async readLogs(after: unknown, actor?: Member) {
    await this.adminOnly(actor)
    const from = Number(after) || 0
    return { latest: this.logSeq, entries: this.logs.filter((entry) => entry.seq > from) }
  }

  async accountSettings(actor?: Member): Promise<MailAccountSettings> {
    await this.adminOnly(actor)
    const { imap: { password: _imap, ...imap }, smtp: { password: _smtp, ...smtp }, ...rest } = this.account
    return { ...rest, imap, smtp }
  }

  // Changing the address means another mailbox: it is only allowed when the local cache is wiped, so two mailboxes never mix.
  async updateAccount(input: unknown, actor?: Member): Promise<MailAccountSettings> {
    await this.adminOnly(actor)
    if (!isMailAccountUpdate(input)) throw new BadRequestException('Invalid mail account settings.')
    const { reset, ...account } = input
    if (account.email.toLowerCase() !== this.account.email.toLowerCase() && !reset) throw new BadRequestException('Changing the mailbox address requires starting from zero.')
    const next: MailAccount = { ...account,
      imap: { ...account.imap, password: account.imap.password || this.account.imap.password },
      smtp: { ...account.smtp, password: account.smtp.password || this.account.smtp.password } }
    const imap = this.imap(next)
    try { await imap.connect() } catch { throw new BadRequestException('IMAP connection failed. Check the host, port, security and credentials.') }
    finally { await imap.logout().catch(() => imap.close()) }
    try { await this.smtp(next).verify() } catch { throw new BadRequestException('SMTP connection failed. Check the host, port, security and credentials.') }
    // A plain settings change needs no lock: a running sync finishes on its open connection, the next one uses the new account.
    if (!reset) { await saveAccount(this.pool, this.accountId, next); this.account = next; this.inventoryCache.clear(); this.listing = null; this.log('info', 'Mail account settings updated') }
    // Wiping must not interleave with a sync writing rows, so it waits for the current cycle (initial imports can take minutes).
    else await this.exclusive(async () => {
      const client = await this.pool.connect()
      try {
        await client.query('BEGIN')
        // Local data only: nothing is deleted on the mail server. Unconfirmed sends keep their duplicate guard.
        const { rowCount } = await client.query("SELECT 1 FROM mail_sends WHERE mailbox_id=$1 AND status IN ('sending','uncertain')", [this.mailboxId])
        if (rowCount) throw new ConflictException('A reply is still being sent or unconfirmed. Check Sent before starting from zero.')
        for (const table of ['mail_messages', 'mail_folders', 'mail_archives', 'mail_sends', 'demo_conversation_state', 'postfold_activity'])
          await client.query(`DELETE FROM ${table} WHERE mailbox_id=$1`, [this.mailboxId])
        await client.query('UPDATE demo_project_settings SET revision=revision+1, settings=$2 WHERE mailbox_id=$1',
          [this.mailboxId, { projects: emptyMailbox.projects, labels: [], order: emptyMailbox.projects.map((item) => item.id), sort: 'manual' }])
        await saveAccount(client, this.accountId, next)
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
      finally { client.release() }
      this.account = next; this.lastSync = null; this.syncError = false; this.inventoryCache.clear(); this.listing = null
      this.progress = { ...this.progress, stored: 0, total: 0, rate: null, lastCycle: null, error: null }
      this.log('warn', 'Local data cleared; resynchronizing {0} from scratch', next.email)
    }, 150_000)
    this.requestSync('settings')
    return this.accountSettings(actor)
  }

  private async exclusive<T>(run: () => Promise<T>, waitMs = 0): Promise<T> {
    const lock = await this.pool.connect()
    let held = false
    // A waiting caller makes background cycles stop at their next checkpoint and not start again until it ran.
    let waiting = waitMs > 0
    if (waiting) this.waiting++
    try {
      // ponytail: one PostgreSQL session lock per mailbox; split sync/write locks if throughput requires it.
      // Callers that may wait (settings changes) poll between sync cycles instead of failing immediately.
      for (const deadline = Date.now() + waitMs; ; await new Promise((resolve) => setTimeout(resolve, 500))) {
        const { rows } = await lock.query('SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS held', ['postfold:mail', this.mailboxId])
        held = rows[0].held
        if (held || Date.now() >= deadline) break
      }
      if (waiting) { this.waiting--; waiting = false }
      if (!held) throw new ConflictException('Mailbox operation in progress; refresh before retrying.')
      return await run()
    } catch (error) {
      if (error instanceof HttpException) throw error
      throw new ServiceUnavailableException('Mail server operation could not be confirmed. Refresh before retrying; no automatic resend was attempted.')
    } finally {
      if (waiting) this.waiting--
      if (held) await lock.query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2))', ['postfold:mail', this.mailboxId])
      lock.release()
    }
  }

  async mailbox(input: unknown = {}): Promise<DemoMailbox> {
    if (!isMailboxQuery(input)) throw new BadRequestException('Invalid mailbox query.')
    const [settings, page, counts, sends] = await Promise.all([
      this.read(), this.page(input), this.counts(),
      this.pool.query('SELECT target_id, status, sent_copy, data FROM mail_sends WHERE mailbox_id = $1', [this.mailboxId]),
    ])
    const messageIds = new Set(page.messages.map((item) => item.messageId))
    // Sent replies stay listed until their copy is imported from the Sent folder; they are few, so every window carries them.
    const pending = sends.rows.filter((row) => row.status === 'sent' && !messageIds.has(row.data.messageId)).map((row) => row.data as Conversation)
      .filter((item) => !page.messages.some((message) => message.id === item.id))
    const conversationStates = await this.readConversationStates([...page.messages, ...pending].map((item) => item.id))
    // Bodies load with the message content when opened; the list payload only needs previews.
    const conversations = applyConversationStates([...page.messages, ...pending].map((item) => ({ ...item, body: '' })), conversationStates)
    const { projects, ...projectSettings } = settings
    return { projects, projectSettings, labels: settings.labels ?? [], conversations, contacts: contactsOf(conversations), conversationStates,
      page: { total: page.total, nextCursor: page.nextCursor }, counts: { ...counts, messages: counts.messages + pending.length, threads: counts.threads + pending.length },
      connection: { mode: 'imap', email: this.account.email, lastSync: this.lastSync, error: this.syncError, maxMessagesPerSync: this.limit },
      deliveries: sends.rows.map((row) => ({ targetId: row.target_id, status: row.status, sentCopy: row.sent_copy })) }
  }

  private async page(query: MailboxQuery) {
    const projects = (await this.read()).projects
    const limit = query.limit ?? LIST_PAGE
    const oldest = query.order === 'oldest'
    const folderIds = query.projectId ? descendantIds(projects, query.projectId) : null
    const needle = searchable(query.query?.trim() ?? '')
    // Folder names and codes match like in the browser: every message of a matching folder is a match.
    const pathIds = needle ? projects.filter((project) => searchable(`${project.id} ${projectPath(projects, project.id)}`).includes(needle)).map((project) => project.id) : []
    const [cursorAt, cursorId] = query.cursor ? JSON.parse(Buffer.from(query.cursor, 'base64url').toString()) as [string, string] : [null, null]
    const filters = `m.mailbox_id = $1
      AND ($2::text[] IS NULL OR COALESCE(s.project_id, m.data->>'projectId') = ANY($2::text[]))
      AND ($3 = 'all' OR ($3 = 'unread' AND COALESCE(s.unread, (m.data->>'unread')::boolean)) OR COALESCE(s.status, m.data->>'status') = $3)
      AND ($4::text IS NULL OR $4 = ANY(COALESCE(s.label_ids, ARRAY[]::text[])))
      AND ($5 = '' OR strpos(${searchText}, $5) > 0 OR COALESCE(s.project_id, m.data->>'projectId') = ANY($6::text[]))
      AND ($7::text IS NULL OR s.assignee_id = $7 OR m.id IN (SELECT conversation_id FROM postfold_activity WHERE mailbox_id = $1 AND actor->>'id' = $7 AND (${handledActivity})))`
    const values = [this.mailboxId, folderIds, query.status ?? 'all', query.labelId ?? null, needle, pathIds, query.memberId ?? null]
    const from = 'FROM mail_messages m LEFT JOIN demo_conversation_state s ON s.mailbox_id = m.mailbox_id AND s.id = m.id'
    const [{ rows }, { rows: [total] }] = await Promise.all([
      this.pool.query<{ data: CachedMessage['data'] }>(`SELECT m.data - 'references' AS data ${from} WHERE ${filters}
        AND ($8::text IS NULL OR (m.data->>'sentAt', m.id) ${oldest ? '>' : '<'} ($8, $9))
        ORDER BY m.data->>'sentAt' ${oldest ? 'ASC' : 'DESC'}, m.id ${oldest ? 'ASC' : 'DESC'} LIMIT $10`, [...values, cursorAt, cursorId, limit + 1]),
      this.pool.query<{ messages: number; threads: number }>(`SELECT count(*)::integer AS messages, count(DISTINCT COALESCE(m.data->>'threadId', m.id))::integer AS threads ${from} WHERE ${filters}`, values),
    ])
    const messages = rows.slice(0, limit).map((row) => row.data)
    const last = messages.at(-1)
    const nextCursor = rows.length > limit && last ? Buffer.from(JSON.stringify([last.sentAt ?? '', last.id])).toString('base64url') : null
    // Threads are shown whole, and the open conversation stays loaded whatever the filters.
    const threadIds = query.threads ? [...new Set(messages.map((item) => item.threadId ?? item.id))] : []
    const extra = threadIds.length || query.include?.length ? (await this.pool.query<{ data: CachedMessage['data'] }>(`SELECT m.data - 'references' AS data FROM mail_messages m
      WHERE m.mailbox_id = $1 AND (m.data->>'threadId' = ANY($2::text[]) OR m.data->>'threadId' IN (SELECT data->>'threadId' FROM mail_messages WHERE mailbox_id = $1 AND id = ANY($3::text[])) OR m.id = ANY($3::text[]))`,
    [this.mailboxId, threadIds, query.include ?? []])).rows.map((row) => row.data) : []
    const seen = new Set(messages.map((item) => item.id))
    for (const item of extra) if (!seen.has(item.id)) { seen.add(item.id); messages.push(item) }
    return { messages, total: query.threads ? total.threads : total.messages, nextCursor }
  }

  private async counts(): Promise<MailboxCounts> {
    const [{ rows: [totals] }, { rows: labels }, { rows: folders }] = await Promise.all([
      this.pool.query<{ messages: number; threads: number }>("SELECT count(*)::integer AS messages, count(DISTINCT COALESCE(data->>'threadId', id))::integer AS threads FROM mail_messages WHERE mailbox_id = $1", [this.mailboxId]),
      this.pool.query<{ label: string; count: number }>('SELECT label, count(*)::integer AS count FROM demo_conversation_state, unnest(label_ids) AS label WHERE mailbox_id = $1 GROUP BY label', [this.mailboxId]),
      this.pool.query<{ id: string; count: number }>(`SELECT COALESCE(s.project_id, m.data->>'projectId') AS id, count(*)::integer AS count FROM mail_messages m
        LEFT JOIN demo_conversation_state s ON s.mailbox_id = m.mailbox_id AND s.id = m.id WHERE m.mailbox_id = $1 GROUP BY 1`, [this.mailboxId]),
    ])
    return { ...totals, labels: Object.fromEntries(labels.map((row) => [row.label, row.count])), folders: Object.fromEntries(folders.map((row) => [row.id, row.count])) }
  }

  // Address book for large mailboxes: contacts of the most recent matching messages, searched in PostgreSQL.
  async contacts(input: unknown): Promise<Contact[]> {
    if (!input || typeof input !== 'object' || typeof (input as { query?: unknown }).query !== 'string' || (input as { query: string }).query.length > 200) throw new BadRequestException('Invalid contact search.')
    const needle = searchable((input as { query: string }).query.trim())
    const { rows } = await this.pool.query<{ data: CachedMessage['data'] }>(`SELECT data FROM mail_messages m WHERE mailbox_id = $1 AND ($2 = '' OR strpos(${searchText}, $2) > 0)
      ORDER BY data->>'sentAt' DESC LIMIT 3000`, [this.mailboxId, needle])
    return contactsOf(rows.map((row) => row.data)).filter((person) => !needle || searchable(`${person.name} ${person.email}`).includes(needle)).slice(0, 300)
  }

  // Tests, replies and restorations need a finished cycle; the API and the timer only request one.
  async sync() {
    await this.runCycle('manual')
    return this.mailbox()
  }

  requestSync(reason: keyof typeof cycleStarts) { void this.runCycle(reason).catch(() => {}) }

  syncProgress(): SyncProgress { return { ...this.progress, folders: { ...this.progress.folders }, batch: { ...this.progress.batch } } }

  private async runCycle(reason: keyof typeof cycleStarts) {
    // One cycle per process at a time; a user action waiting for the mailbox goes first.
    if (this.syncing || this.waiting) return
    this.syncing = true
    let resume = false
    try {
      await this.exclusive(async () => {
        const started = Date.now()
        this.progress = { ...this.progress, state: 'listing', startedAt: new Date(started).toISOString(), folder: null, folders: { done: 0, total: 0 }, batch: { done: 0, total: 0 }, error: null }
        this.log('info', cycleStarts[reason])
        const client = this.imap()
        try {
          await client.connect()
          const result = await this.importMailbox(client, undefined, { budgetMs: CYCLE_IMPORT_MS, yieldable: true, resume: reason === 'resume' })
          const seconds = secondsSince(started)
          this.lastSync = new Date().toISOString(); this.syncError = false
          resume = !result.complete
          if (result.imported) this.progress.rate = Math.round(result.imported / Math.max(seconds, 0.1) * 10) / 10
          this.progress.lastCycle = { finishedAt: this.lastSync, seconds, imported: result.imported, complete: result.complete }
          this.log('info', result.complete ? 'Synchronization finished in {0} s: {1} new, {2} messages in {3} folders' : 'Synchronization step finished in {0} s: {1} new, {2} messages in {3} folders; import continues',
            seconds, result.imported, result.total, result.folders)
          const left = this.progress.total - this.progress.stored
          if (left && this.progress.rate) this.log('info', 'Stored {0} of {1} messages; {2} left, about {3} min at the current pace', this.progress.stored, this.progress.total, left, Math.ceil(left / this.progress.rate / 60))
        } catch (error) {
          if (error instanceof SyncPaused) { resume = true; this.log('info', 'Synchronization paused so a user action can run; it resumes right after'); return }
          this.progress.error = describeError(error)
          this.log('error', 'Synchronization failed: {0}', describeError(error)); throw error
        } finally {
          this.progress.state = 'idle'; this.progress.folder = null
          await client.logout().catch(() => client.close())
        }
      })
    } catch (error) { if (error instanceof ConflictException) return; this.syncError = true; throw error }
    finally {
      this.syncing = false
      // Large imports chain cycles instead of idling until the next scheduled tick.
      if (resume && this.timer) setTimeout(() => this.requestSync('resume'), 1000).unref()
    }
  }

  private async importMailbox(client: ImapFlow, restoration?: { message_id: string; sha256: string; snapshot: ConversationState; data: CachedMessage['data'] }, options: { budgetMs?: number; yieldable?: boolean; resume?: boolean } = {}) {
    const started = Date.now()
    let deadline = Infinity
    const paused = () => options.yieldable === true && this.waiting > 0
    // Without LIST-STATUS each folder status is one round trip; cycles that only continue an import reuse a recent listing,
    // so new mail arrives at most a few minutes later instead of every cycle paying for thousands of STATUS commands.
    const reuse = options.resume && !client.capabilities.has('LIST-STATUS') && this.listing && Date.now() - this.listing.at < LISTING_REUSE_MS ? this.listing : null
    let listed = reuse?.listed ?? await client.list({ statusQuery: folderStatus })
    if (this.account.saveSent && !listed.some((item) => item.path === this.account.sentPath)) {
      await client.mailboxCreate(this.account.sentPath)
      listed = await client.list({ statusQuery: folderStatus })
    }
    if (reuse) this.log('info', 'Reusing the folder listing from {0} s ago (the server has no LIST-STATUS)', secondsSince(reuse.at))
    else { this.listing = { at: Date.now(), listed }; this.log('info', 'Listed {0} folders in {1} s', listed.length, secondsSince(started)) }
    this.delimiter = listed.find((item) => item.path === 'INBOX')?.delimiter || '/'
    const oldSettings = await this.read()
    const { rows: oldFolders } = await this.pool.query<Folder>('SELECT id, path FROM mail_folders WHERE mailbox_id = $1', [this.mailboxId])
    const { rows: oldMessages } = await this.pool.query<CachedMessage>('SELECT id, path, validity, uid, raw_id, source_sha256, data FROM mail_messages WHERE mailbox_id = $1', [this.mailboxId])
    const currentStates = new Map((await this.readConversationStates()).map(state => [state.id, state]))
    const restoredStates = new Map<string, ConversationState>()
    const claimedArchiveIds = new Set<string>()
    let restorationClaimed = false
    const { rows: sent } = await this.pool.query<{ data: Conversation }>("SELECT data FROM mail_sends WHERE mailbox_id = $1 AND status = 'sent'", [this.mailboxId])
    const bySlot = new Map(oldMessages.map((row) => [slot(row.path, row.validity, Number(row.uid)), row]))
    const byRawId = new Map<string, CachedMessage[]>()
    for (const row of oldMessages) if (row.raw_id) byRawId.set(row.raw_id, [...byRawId.get(row.raw_id) ?? [], row])
    const assignedIds = new Set(['inbox', ...oldFolders.map((folder) => folder.id.toLowerCase())])
    const folders = listed.map((folder) => {
      const code = !folder.path.includes(this.delimiter) ? /^([a-z0-9][a-z0-9._-]{0,31})\s+-\s+(.+)$/i.exec(folder.name) : null
      const previous = oldFolders.find((item) => item.path === folder.path)
      let id = previous?.id ?? (folder.path === 'INBOX' ? 'inbox' : code && !assignedIds.has(code[1].toLowerCase()) ? code[1] : `f_${hash(folder.path)}`)
      if (!previous && folder.path !== 'INBOX') for (let suffix = 0; assignedIds.has(id.toLowerCase()); suffix++) id = `f_${hash(`${folder.path}:${suffix}`)}`
      assignedIds.add(id.toLowerCase())
      return { folder, id }
    })
    const projects: Project[] = folders.map(({ folder, id }) => {
      const previous = oldSettings.projects.find((item) => item.id === id)
      const parentPath = folder.path.slice(0, folder.path.lastIndexOf(this.delimiter))
      const parent = folders.find((item) => item.folder.path === parentPath)
      const match = !parent ? /^([a-z0-9][a-z0-9._-]{0,31})\s+-\s+(.+)$/i.exec(folder.name) : null
      return { id, name: match?.[2] ?? folder.name, color: previous?.color ?? 'blue', parentId: parent?.id ?? null,
        code: match?.[1] ?? previous?.code ?? null, createdAt: previous?.createdAt ?? new Date().toISOString() }
    })
    // Inventory of UIDs and flags. A folder whose STATUS (UIDVALIDITY, UIDNEXT, counts, MODSEQ) did not change reuses its
    // previous listing, so a steady mailbox costs one LIST-STATUS instead of a SELECT and a FETCH per folder.
    const inventoryStarted = Date.now()
    this.progress.state = 'inventory'
    this.progress.folders = { done: 0, total: folders.length }
    const inventory: InventoryItem[] = []
    const byPath = new Map<string, InventoryItem[]>()
    const rescanned = new Set<string>()
    for (const { folder, id } of folders) {
      if (paused()) throw new SyncPaused()
      this.progress.folders.done++
      if (folder.flags.has('\\Noselect')) continue
      const status = folder.status
      const key = status ? [status.uidValidity, status.uidNext, status.messages, status.unseen, status.highestModseq].map(String).join(':') : ''
      let listing = this.inventoryCache.get(folder.path)
      if (!key || !listing || listing.key !== key || Date.now() - listing.at > INVENTORY_MAX_AGE_MS) {
        this.progress.folder = folder.path
        listing = { key, at: Date.now(), validity: String(status?.uidValidity ?? ''), messages: [] }
        if (status?.messages !== 0) {
          const lock = await client.getMailboxLock(folder.path)
          try {
            const box = client.mailbox
            if (box && box.exists) {
              listing.validity = String(box.uidValidity)
              for await (const message of client.fetch('1:*', { uid: true, flags: true, size: true, internalDate: true })) listing.messages.push(message)
            }
          } finally { lock.release() }
        }
        if (key) this.inventoryCache.set(folder.path, listing)
        rescanned.add(folder.path)
        if (rescanned.size % 100 === 0) this.log('info', 'Inventory: {0} of {1} folders checked, {2} rescanned so far', this.progress.folders.done, folders.length, rescanned.size)
      }
      const items = listing.messages.map((message) => ({ path: folder.path, validity: listing.validity, projectId: id, message }))
      byPath.set(folder.path, items)
      for (const item of items) inventory.push(item)
    }
    this.log('info', 'Inventory: {0} messages in {1} folders in {2} s ({3} rescanned, {4} unchanged)', inventory.length, folders.length, secondsSince(inventoryStarted), rescanned.size, folders.length - rescanned.size)
    const indexedInventory = new Map(inventory.map(item => [slot(item.path,item.validity,item.message.uid),item]))
    const liveSlots = new Set(indexedInventory.keys())
    // The limit is a budget for the whole cycle, newest first, so large mailboxes become visible and committed batch by batch.
    const stored = (item: InventoryItem) => !!bySlot.get(slot(item.path, item.validity, item.message.uid))?.source_sha256
    const uncached = inventory.filter((item) => !stored(item) && (item.message.size ?? 0) <= MAX_MIME_BYTES)
    const oversized = inventory.filter((item) => !stored(item) && (item.message.size ?? 0) > MAX_MIME_BYTES).length
    if (oversized) this.log('warn', '{0} messages over 16 MiB are listed without their complete copy', oversized)
    const received = (item: InventoryItem) => new Date(item.message.internalDate ?? 0).getTime()
    // Newest first, but a folder that gets opened also gives up to one fetch chunk of its next pending messages:
    // in mailboxes with thousands of folders, opening a folder for one or two messages would dominate the import.
    uncached.sort((a, b) => received(b) - received(a))
    const pendingByPath = new Map<string, InventoryItem[]>()
    for (const item of uncached) { const list = pendingByPath.get(item.path); if (list) list.push(item); else pendingByPath.set(item.path, [item]) }
    const taken = new Map<string, number>()
    const selected = new Set<InventoryItem>()
    for (const item of uncached) {
      if (selected.size >= this.limit) break
      if (selected.has(item)) continue
      // Messages of one folder are taken in order, so `item` is that folder's newest message not selected yet.
      const list = pendingByPath.get(item.path)!
      let index = taken.get(item.path) ?? 0
      for (const end = index + FETCH_CHUNK; index < end && index < list.length && selected.size < this.limit; index++) selected.add(list[index])
      taken.set(item.path, index)
    }
    let importPending = uncached.length > selected.size
    this.progress = { ...this.progress, state: 'importing', folder: null, total: inventory.length, stored: inventory.length - uncached.length, batch: { done: 0, total: selected.size } }
    if (uncached.length) this.log('info', 'Importing {0} of {1} new messages, newest first', selected.size, uncached.length)
    // The import budget starts after listing and inventory, which a first scan of thousands of folders can make long.
    deadline = Date.now() + (options.budgetMs ?? CYCLE_IMPORT_MS)
    const staged: CachedMessage[] = []
    const stagedIds = new Set<string>()
    const unchanged = new Set<string>()
    let imported = 0
    let stopped = false
    const importStarted = Date.now()
    const small = { folders: 0, messages: 0 }
    // Imports stop at folder or chunk boundaries when the time budget is spent or a user action waits; the rest stays pending.
    const shouldStop = () => {
      if (!stopped && (paused() || Date.now() > deadline)) {
        stopped = true
        this.log('info', paused() ? 'Import paused so a user action can run' : 'Import time budget reached; the rest continues next cycle')
      }
      return stopped
    }
    // Folders are visited in the order of their newest selected message, so a short budget still imports the most recent mail.
    const rank = new Map<string, number>()
    for (const item of selected) if (!rank.has(item.path)) rank.set(item.path, rank.size)
    const visitOrder = [...folders].sort((a, b) => (rank.get(a.folder.path) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.folder.path) ?? Number.MAX_SAFE_INTEGER))
    for (const { folder, id } of visitOrder) {
      const items = byPath.get(folder.path) ?? []
      let missing = items.filter((item) => selected.has(item))
      // Stop before selecting the folder: past the budget, opening each remaining folder would cost a round trip for nothing.
      if (missing.length && shouldStop()) { for (const item of missing) selected.delete(item); importPending = true; missing = [] }
      const raw = new Map<number, Buffer>()
      const folderStarted = Date.now()
      let bytes = 0
      if (missing.length) {
        this.progress.folder = folder.path
        if (missing.length >= FOLDER_LOG_MIN) this.log('info', 'Folder {0}: importing {1} new messages ({2} in folder)', folder.path, missing.length, items.length)
        const lock = await client.getMailboxLock(folder.path)
        try {
          for (let index = 0; index < missing.length; index += FETCH_CHUNK) {
            if (index && shouldStop()) { for (const item of missing.slice(index)) selected.delete(item); importPending = true; break }
            const chunk = missing.slice(index, index + FETCH_CHUNK)
            for await (const message of client.fetch(chunk.map((item) => item.message.uid).join(','), { uid: true, source: true }, { uid: true })) {
              if (message.source) { raw.set(message.uid, message.source); bytes += message.source.length }
            }
          }
        } finally { lock.release() }
      }
      const downloaded = secondsSince(folderStarted)
      const before = imported
      for (const item of items) {
        const previous = bySlot.get(slot(item.path, item.validity, item.message.uid))
        const unread = !item.message.flags?.has('\\Seen')
        if (previous && (previous.source_sha256 || !selected.has(item))) {
          if (previous.data.unread === unread && previous.data.projectId === id) unchanged.add(previous.id)
          staged.push({ ...previous, data: { ...previous.data, unread, projectId: id } }); stagedIds.add(previous.id); continue
        }
        if (!selected.has(item)) continue
        const source = raw.get(item.message.uid)
        // Oversized MIME messages are not downloaded; importing them later cannot consume unbounded RAM.
        if (!source) { if (previous) { staged.push(previous); stagedIds.add(previous.id); unchanged.add(previous.id) } continue }
        try {
          const sha = sourceHash(source)
          const restoring = !restorationClaimed && restoration?.sha256 === sha ? restoration : undefined
          const { rows: archived } = await this.pool.query<{ message_id: string; snapshot: ConversationState; data: CachedMessage['data'] }>(`SELECT message_id,snapshot,data FROM mail_archives a
            WHERE mailbox_id=$1 AND sha256=$2 AND NOT (message_id=ANY($3::text[]))
            AND NOT EXISTS (SELECT 1 FROM mail_messages m WHERE m.mailbox_id=a.mailbox_id AND m.id=a.message_id)
            ORDER BY (restore_status IS NOT NULL) DESC,last_seen_at DESC,id DESC LIMIT 1`, [this.mailboxId, sha, [...claimedArchiveIds]])
          const parsed = await simpleParser(source, { skipTextToHtml: true })
          const sender = parsed.from?.value[0]
          const outgoing = sender?.address?.toLowerCase() === this.account.email.toLowerCase()
          const recipient = outgoing ? (Array.isArray(parsed.to) ? parsed.to[0] : parsed.to)?.value[0] : parsed.replyTo?.value[0] ?? sender
          const email = recipient?.address ?? ''
          // Visible headers only: never expose Bcc as a conversation participant.
          const addresses = [parsed.from, parsed.to, parsed.cc, parsed.replyTo].flatMap((header) => !header ? [] :
            Array.isArray(header) ? header.flatMap((group) => group.value) : header.value)
          const participants = [...new Map(addresses.filter((person) => isMailAddress(person.address) && person.address.toLowerCase() !== this.account.email.toLowerCase())
            .map((person) => [person.address!.toLowerCase(), { name: person.name || person.address!, email: person.address! }])).values()]
          const rawId = parsed.messageId ? cleanText(parsed.messageId) : null
          const moved = (rawId ? byRawId.get(rawId) ?? [] : []).filter((row) => !liveSlots.has(slot(row.path, row.validity, Number(row.uid))) && !stagedIds.has(row.id))
          const references = [...(typeof parsed.references === 'string' ? [parsed.references] : parsed.references ?? []), ...(parsed.inReplyTo ? [parsed.inReplyTo] : [])]
          const date = parsed.date && Number.isFinite(parsed.date.getTime()) ? parsed.date : new Date(item.message.internalDate || Date.now())
          const sentAt = date.toISOString()
          const body = parsed.text ?? ''
          const sentCopy = rawId && outgoing ? sent.find((item) => item.data.messageId === rawId)?.data : undefined
          const sentId = sentCopy && !stagedIds.has(sentCopy.id) && !oldMessages.some((row) => row.id === sentCopy.id && liveSlots.has(slot(row.path, row.validity, Number(row.uid)))) ? sentCopy.id : undefined
          const restoredId = restoring && !oldMessages.some(row => row.id === restoring.message_id && liveSlots.has(slot(row.path,row.validity,Number(row.uid)))) ? restoring.message_id : undefined
          const data: CachedMessage['data'] = jsonSafe({ id: previous?.id ?? sentId ?? restoredId ?? (moved.length === 1 ? moved[0].id : archived[0]?.message_id ?? randomUUID()), projectId: id, contactId: `c_${hash(email.toLowerCase())}`,
            threadId: sentCopy?.threadId ?? previous?.data.threadId ?? restoring?.data.threadId ?? archived[0]?.data.threadId ?? hash(references[0] ?? parsed.inReplyTo ?? rawId ?? randomUUID()), sentAt,
            sender: { name: sender?.name || sender?.address || 'Unknown sender', email: sender?.address ?? '' },
            participants,
            subject: parsed.subject ?? '(No subject)', preview: body.replace(/\s+/g, ' ').slice(0, 200), body,
            time: sentAt.slice(0, 10), status: outgoing ? 'waiting' : 'open', assignee: null, unread, labelIds: [], outgoing, imapReady: true, replyTo: email, references,
            receivedAt: new Date(item.message.internalDate || date).toISOString(), ...(rawId ? { messageId: rawId } : {}) })
          if (restoring) { restorationClaimed = true; restoredStates.set(data.id,restoring.snapshot) }
          else if (archived[0]?.message_id === data.id) restoredStates.set(data.id, archived[0].snapshot)
          claimedArchiveIds.add(data.id)
          const row = { id: data.id, path: item.path, validity: item.validity, uid: item.message.uid, raw_id: rawId, data, source_sha256: sha }
          await this.archiveMessage(row, source, [...(item.message.flags ?? [])], new Date(item.message.internalDate || date), currentStates.get(data.id) ?? restoredStates.get(data.id))
          imported++
          this.progress.batch.done++; this.progress.stored++
          staged.push(row); stagedIds.add(row.id)
        } catch (error) {
          // One unreadable message is reported and retried next cycle instead of blocking the whole import.
          this.log('warn', 'Skipped message UID {0} in {1}: {2}', item.message.uid, item.path, describeError(error))
          if (previous) { staged.push(previous); stagedIds.add(previous.id); unchanged.add(previous.id) }
        }
      }
      if (missing.length >= FOLDER_LOG_MIN) this.log('info', 'Folder {0}: {1} imported ({2} MB, download {3} s, processing {4} s)', folder.path, imported - before, Math.round(bytes / 104857.6) / 10, downloaded, Math.round((secondsSince(folderStarted) - downloaded) * 10) / 10)
      else if (missing.length) { small.folders++; small.messages += imported - before }
    }
    if (small.folders) this.log('info', '{0} messages imported from {1} other folders', small.messages, small.folders)
    if (imported) this.log('info', 'Imported {0} messages in {1} s ({2} per second)', imported, secondsSince(importStarted), Math.round(imported / Math.max(secondsSince(importStarted), 0.1) * 10) / 10)
    if (importPending) {
      // Preserve annotations on native moves larger than one import batch until their new UIDs are parsed.
      for (const previous of oldMessages) if (!stagedIds.has(previous.id)) {
        staged.push(previous); stagedIds.add(previous.id); unchanged.add(previous.id)
        const project = oldSettings.projects.find((item) => item.id === previous.data.projectId)
        if (project && !projects.some((item) => item.id === project.id)) projects.push(project)
      }
    }
    // Only new, changed and removed rows are written: rewriting tens of thousands of identical rows would dominate each cycle.
    this.progress.state = 'saving'; this.progress.folder = null
    const saveStarted = Date.now()
    const removed = oldMessages.filter((row) => !stagedIds.has(row.id)).map((row) => row.id)
    // Keyed by ID: one multi-row upsert cannot touch the same row twice.
    const changed = [...new Map(staged.filter((row) => !unchanged.has(row.id)).map((row) => [row.id, row])).values()]
    this.log('info', 'Saving {0} new or changed messages, {1} removed', changed.length, removed.length)
    const transaction = await this.pool.connect()
    try {
      await transaction.query('BEGIN')
      const { rows } = await transaction.query('SELECT settings FROM demo_project_settings WHERE mailbox_id = $1 FOR UPDATE', [this.mailboxId])
      const settings = rows[0].settings
      const merged = { ...settings, projects, order: [...settings.order.filter((id: string) => projects.some((item) => item.id === id)), ...projects.filter((item) => !settings.order.includes(item.id)).map((item) => item.id)] }
      if (JSON.stringify(settings) !== JSON.stringify(merged)) await transaction.query('UPDATE demo_project_settings SET settings = $2, revision = revision + 1 WHERE mailbox_id = $1', [this.mailboxId, merged])
      await transaction.query('DELETE FROM mail_folders WHERE mailbox_id = $1', [this.mailboxId])
      await transaction.query('INSERT INTO mail_folders (mailbox_id, id, path) SELECT $1, x.id, x.path FROM jsonb_to_recordset($2::jsonb) AS x(id text, path text)',
        [this.mailboxId, JSON.stringify(folders.map(({ folder, id }) => ({ id, path: folder.path })))])
      // Save the latest annotations of rows about to be removed. Sync never deletes archive bytes.
      if (removed.length) await transaction.query(`UPDATE mail_archives a SET snapshot=${stateSnapshot},data=m.data,last_path=m.path
        FROM mail_messages m JOIN demo_conversation_state s ON s.mailbox_id=m.mailbox_id AND s.id=m.id
        WHERE a.mailbox_id=$1 AND m.mailbox_id=a.mailbox_id AND m.id=a.message_id AND m.source_sha256=a.sha256 AND m.id IN (SELECT unnest($2::text[]))`, [this.mailboxId, removed])
      if (removed.length) await transaction.query('DELETE FROM mail_messages WHERE mailbox_id = $1 AND id = ANY($2::text[])', [this.mailboxId, removed])
      await transaction.query(`DELETE FROM demo_conversation_state s WHERE mailbox_id = $1 AND id NOT LIKE $3
        AND NOT EXISTS (SELECT 1 FROM unnest($2::text[]) AS k(id) WHERE k.id = s.id)`, [this.mailboxId, [...stagedIds], 'sent_%'])
      // Set-based writes in chunks: one statement per 200 rows instead of two round trips per message.
      for (let index = 0; index < changed.length; index += SAVE_CHUNK) {
        const chunk = changed.slice(index, index + SAVE_CHUNK)
        await transaction.query(`INSERT INTO mail_messages (mailbox_id, id, path, validity, uid, raw_id, data, source_sha256, body)
          SELECT $1, x.id, x.path, x.validity, x.uid, x.raw_id, x.data, x.source_sha256, x.body FROM jsonb_to_recordset($2::jsonb) AS x(id text, path text, validity text, uid bigint, raw_id text, data jsonb, source_sha256 text, body text)
          ON CONFLICT (mailbox_id,id) DO UPDATE SET path=EXCLUDED.path, validity=EXCLUDED.validity, uid=EXCLUDED.uid, raw_id=EXCLUDED.raw_id, data=mail_messages.data || EXCLUDED.data,
            source_sha256=EXCLUDED.source_sha256, body=COALESCE(EXCLUDED.body, mail_messages.body)`,
        [this.mailboxId, JSON.stringify(chunk.map(({ data: { body, ...data }, ...row }) => ({ id: row.id, path: row.path, validity: row.validity, uid: row.uid, raw_id: row.raw_id, data, body: body ?? null, source_sha256: row.source_sha256 ?? null })))])
        await transaction.query(`INSERT INTO demo_conversation_state (mailbox_id,id,unread,status,project_id,label_ids,assignee_id,revision)
          SELECT $1, x.id, x.unread, x.status, x."projectId", ARRAY(SELECT jsonb_array_elements_text(x.labels)), COALESCE(
            (SELECT id FROM postfold_mailbox_members WHERE mailbox_id=$1 AND id=x.assignee AND active),
            (SELECT s.assignee_id FROM demo_conversation_state s JOIN mail_messages m ON m.mailbox_id=s.mailbox_id AND m.id=s.id
              WHERE s.mailbox_id=$1 AND s.id<>x.id AND m.data->>'threadId'=x."threadId" ORDER BY COALESCE(m.data->>'receivedAt',m.data->>'sentAt') DESC,m.uid DESC LIMIT 1)), x.revision
          FROM jsonb_to_recordset($2::jsonb) AS x(id text, unread boolean, status text, "projectId" text, labels jsonb, assignee text, "threadId" text, revision integer)
          ON CONFLICT (mailbox_id,id) DO UPDATE SET unread=EXCLUDED.unread, project_id=EXCLUDED.project_id,
          revision=demo_conversation_state.revision + CASE WHEN demo_conversation_state.unread IS DISTINCT FROM EXCLUDED.unread OR demo_conversation_state.project_id IS DISTINCT FROM EXCLUDED.project_id THEN 1 ELSE 0 END`,
        [this.mailboxId, JSON.stringify(chunk.map((row) => {
          const restored = restoredStates.get(row.id)
          return { id: row.id, unread: row.data.unread, status: restored?.status ?? row.data.status, projectId: row.data.projectId, threadId: row.data.threadId ?? null,
            labels: (restored?.labelIds ?? []).filter(labelId => settings.labels?.some((label: { id: string }) => label.id === labelId)),
            assignee: restored?.assigneeId ?? null, revision: restored ? restored.revision + 1 : 0 }
        }))])
      }
      // Archive snapshots follow rows changed by this cycle or by the team since the last snapshot.
      await transaction.query(`UPDATE mail_archives a SET snapshot=${stateSnapshot},data=m.data,last_path=m.path,last_seen_at=now(),missing_since=NULL,restore_status=NULL
        FROM mail_messages m JOIN demo_conversation_state s ON s.mailbox_id=m.mailbox_id AND s.id=m.id
        WHERE a.mailbox_id=$1 AND m.mailbox_id=a.mailbox_id AND m.id=a.message_id AND m.source_sha256=a.sha256
        AND (m.id IN (SELECT unnest($2::text[])) OR a.snapshot->>'revision' IS DISTINCT FROM s.revision::text OR a.missing_since IS NOT NULL OR a.restore_status IS NOT NULL)`, [this.mailboxId, changed.map((row) => row.id)])
      const observed = staged.flatMap(row => {
        const item = rescanned.has(row.path) ? indexedInventory.get(slot(row.path,row.validity,Number(row.uid))) : undefined
        return item ? [{ id: row.id, sha: row.source_sha256, flags: [...(item.message.flags ?? [])] }] : []
      })
      await transaction.query(`UPDATE mail_archives a SET flags=x.flags FROM jsonb_to_recordset($2::jsonb) AS x(id text,sha text,flags text[])
        WHERE a.mailbox_id=$1 AND a.message_id=x.id AND a.sha256=x.sha AND a.flags IS DISTINCT FROM x.flags`, [this.mailboxId, JSON.stringify(observed)])
      await transaction.query(`UPDATE mail_archives a SET missing_since=now()
        WHERE mailbox_id=$1 AND missing_since IS NULL AND NOT EXISTS (SELECT 1 FROM mail_messages m WHERE m.mailbox_id=a.mailbox_id AND m.source_sha256=a.sha256)`, [this.mailboxId])
      await transaction.query(`UPDATE mail_archives a SET missing_since=NULL,restore_status=NULL
        WHERE mailbox_id=$1 AND (missing_since IS NOT NULL OR restore_status IS NOT NULL) AND EXISTS (SELECT 1 FROM mail_messages m WHERE m.mailbox_id=a.mailbox_id AND m.source_sha256=a.sha256)`, [this.mailboxId])
      await transaction.query('COMMIT')
    } catch (error) { await transaction.query('ROLLBACK'); throw error } finally { transaction.release() }
    this.log('info', 'Saved in {0} s', secondsSince(saveStarted))
    return { complete: !importPending, imported, total: inventory.length, folders: listed.length }
  }

  override async updateConversations(input: unknown, actor?: Member) {
    if (!isConversationUpdate(input)) throw new BadRequestException('Invalid conversation update.')
    if (actor) await this.members(actor)
    await this.checkAssignee(input)
    return this.exclusive(async () => {
      const states = await this.readConversationStates(input.targets.map((target) => target.id))
      const settings = await this.read()
      const targets = input.targets.map((target) => states.find((item) => item.id === target.id))
      if (targets.some((item) => !item)) throw new BadRequestException('Message no longer exists.')
      if (targets.some((item, index) => item!.revision !== input.targets[index].revision)) throw new ConflictException({ message: 'Conversation changed; refresh before retrying.', states: targets })
      if ([...(input.addLabelIds ?? []), ...(input.removeLabelIds ?? [])].some((id) => !settings.labels?.some((label) => label.id === id))) throw new BadRequestException('Unknown label.')
      if (input.projectId && !settings.projects.some((item) => item.id === input.projectId)) throw new BadRequestException('Unknown destination folder.')
      if (input.unread !== undefined || input.projectId !== undefined) await this.applyImapUpdate(input).catch((error) => { this.log('warn', 'IMAP update failed: {0}', describeError(error)); throw error })
      return super.updateConversations(input, actor)
    }, 60_000) // Opening or filing a mail makes the running sync pause at its next checkpoint instead of failing.
  }

  private async applyImapUpdate(input: ConversationUpdate) {
    const { rows: messages } = await this.pool.query<CachedMessage>('SELECT * FROM mail_messages WHERE mailbox_id=$1 AND id=ANY($2::text[])', [this.mailboxId, input.targets.map((target) => target.id)])
    if (messages.length !== input.targets.length) throw new BadRequestException('A sent copy is still pending synchronization; refresh before filing it.')
    const { rows: destination } = input.projectId ? await this.pool.query<Folder>('SELECT id,path FROM mail_folders WHERE mailbox_id=$1 AND id=$2', [this.mailboxId, input.projectId]) : { rows: [] }
    if (input.projectId && !destination.length) throw new BadRequestException('Destination folder is not synchronized.')
    const client = this.imap()
    try {
      await client.connect()
      for (const path of new Set(messages.map((item) => item.path))) {
        const lock = await client.getMailboxLock(path)
        try {
          const group = messages.filter((item) => item.path === path)
          if (!client.mailbox || group.some((item) => item.validity !== String(client.mailbox && client.mailbox.uidValidity))) throw new ConflictException('Mailbox identity changed; refresh before retrying.')
          const uids = group.map((item) => Number(item.uid)).join(',')
          const present = await client.search({ uid: uids }, { uid: true })
          if (!present || present.length !== group.length) throw new ConflictException('Messages moved in another client; refresh before retrying.')
          if (input.unread !== undefined) {
            const done = input.unread ? await client.messageFlagsRemove(uids, ['\\Seen'], { uid: true }) : await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true })
            if (!done) throw new Error('IMAP flag update failed')
          }
          if (destination.length && destination[0].path !== path) {
            if (!client.capabilities.has('MOVE') || !client.capabilities.has('UIDPLUS')) throw new BadRequestException('Safe filing requires the IMAP MOVE and UIDPLUS extensions.')
            const result = await client.messageMove(uids, destination[0].path, { uid: true })
            if (!result || !result.uidMap || !result.uidValidity) throw new Error('IMAP move result cannot be confirmed')
            for (const item of group) {
              const uid = result.uidMap.get(Number(item.uid))
              if (!uid) throw new Error('Missing destination UID')
              await this.pool.query('UPDATE mail_messages SET path=$3, validity=$4, uid=$5 WHERE mailbox_id=$1 AND id=$2', [this.mailboxId, item.id, destination[0].path, String(result.uidValidity), uid])
            }
          }
        } finally { lock.release() }
      }
      if (destination.length) this.log('info', 'Moved {0} message(s) to {1}', messages.length, destination[0].path)
      else this.log('info', input.unread ? 'Marked {0} message(s) as unread' : 'Marked {0} message(s) as read', messages.length)
    } finally { await client.logout().catch(() => client.close()) }
  }

  override async update(input: unknown) {
    if (!isProjectSettings(input)) throw new BadRequestException('Invalid folder settings.')
    return this.exclusive(async () => {
      const before = await this.read()
      if (before.revision !== input.revision) throw new ConflictException({ message: 'Folder settings changed; refresh before retrying.', settings: before })
      if (input.projects.some((project) => project.name.includes(this.delimiter))) throw new BadRequestException('Folder names cannot contain the IMAP hierarchy delimiter.')
      for (const project of input.projects) if (project.parentId && project.code === undefined) project.code = null
      const { rows: folders } = await this.pool.query<Folder>('SELECT id,path FROM mail_folders WHERE mailbox_id=$1', [this.mailboxId])
      const paths = new Map(folders.map((folder) => [folder.id, folder.path]))
      const desired = (project: Project): string => project.id === 'inbox' ? 'INBOX' : project.parentId ? `${desired(input.projects.find((item) => item.id === project.parentId)!)}${this.delimiter}${folderName(project)}` : folderName(project)
      if (new Set(input.projects.map(desired)).size !== input.projects.length) throw new BadRequestException('Folder paths must be unique.')
      const inbox = input.projects.find((item) => item.id === 'inbox')
      if (!inbox || inbox.parentId || inbox.name !== before.projects.find((item) => item.id === 'inbox')?.name) throw new BadRequestException('INBOX cannot be renamed, moved or deleted.')
      const changed = input.projects.filter((project) => paths.get(project.id) !== desired(project))
      const deleted = folders.filter((folder) => !input.projects.some((item) => item.id === folder.id))
      if (deleted.length) throw new BadRequestException('Live folder deletion is disabled; review and delete it in a native mail client.')
      if (changed.length) {
        if (folders.some((folder) => folder.path === this.account.sentPath && changed.some((project) => project.id === folder.id))) throw new BadRequestException('The configured Sent folder cannot be renamed or deleted.')
        const client = this.imap()
        try {
          await client.connect()
          const ordered = [...changed].sort((a, b) => desired(a).split(this.delimiter).length - desired(b).split(this.delimiter).length)
          for (const project of ordered) {
            const previous = paths.get(project.id)
            const path = desired(project)
            if (previous === path) continue
            if (previous) {
              await client.mailboxRename(previous, path)
              this.log('info', 'Renamed folder {0} to {1}', previous, path)
              for (const [id, oldPath] of paths) if (oldPath === previous || oldPath.startsWith(previous + this.delimiter)) {
                const renamed = path + oldPath.slice(previous.length)
                await this.pool.query('UPDATE mail_folders SET path=$3 WHERE mailbox_id=$1 AND id=$2', [this.mailboxId, id, renamed])
                await this.pool.query('UPDATE mail_messages SET path=$3 WHERE mailbox_id=$1 AND path=$2', [this.mailboxId, oldPath, renamed])
                paths.set(id, renamed)
              }
            } else {
              await client.mailboxCreate(path)
              this.log('info', 'Created folder {0}', path)
              await this.pool.query('INSERT INTO mail_folders (mailbox_id,id,path) VALUES ($1,$2,$3)', [this.mailboxId, project.id, path])
              paths.set(project.id, path)
            }
          }
        } finally { await client.logout().catch(() => client.close()) }
      }
      return super.update(input)
    }, 60_000)
  }

  async reply(input: unknown, actor?: Member) {
    if (!isReplyRequest(input)) throw new BadRequestException('Invalid reply.')
    return this.exclusive(async () => {
      const digest = hash(JSON.stringify(input.html === undefined && !input.attachments?.length ? [input.id, input.text] : [input.id, input.text, input.html ?? '', input.attachments ?? []]))
      const html = input.html === undefined ? undefined : cleanEmailHtml(input.html)
      const { rows: attempts } = await this.pool.query('SELECT status, body_hash, sent_copy FROM mail_sends WHERE mailbox_id=$1 AND request_id=$2', [this.mailboxId, input.requestId])
      if (attempts.length) {
        if (attempts[0].body_hash !== digest) throw new ConflictException('Request ID already used for a different reply.')
        if (attempts[0].status !== 'sent') throw new ConflictException('Delivery is pending or uncertain; inspect Sent before retrying. Automatic resend is blocked.')
        return { status: 'sent' as const, sentCopy: attempts[0].sent_copy }
      }
      // Reconcile native-client replies and newer incoming messages before claiming a send.
      const imap = this.imap()
      try { await imap.connect(); await this.importMailbox(imap, undefined, { budgetMs: 15_000 }); this.lastSync = new Date().toISOString(); this.syncError = false }
      finally { await imap.logout().catch(() => imap.close()) }
      const { rows } = await this.pool.query<CachedMessage>('SELECT * FROM mail_messages WHERE mailbox_id=$1 AND id=$2', [this.mailboxId, input.id])
      const message = rows[0]?.data
      if (!message || message.outgoing || !isMailAddress(message.replyTo)) throw new BadRequestException('Select a received message with a valid reply address.')
      const states = await this.readConversationStates([input.id])
      if (states.find((item) => item.id === input.id)?.revision !== input.revision) throw new ConflictException('Message changed; refresh before sending.')
      const { rows: newer } = await this.pool.query(`SELECT id FROM mail_messages WHERE mailbox_id=$1 AND data->>'threadId'=$2 AND COALESCE((data->>'outgoing')::boolean,false)=false ORDER BY COALESCE(data->>'receivedAt',data->>'sentAt') DESC, uid DESC LIMIT 1`, [this.mailboxId, message.threadId])
      if (newer[0]?.id !== input.id) throw new ConflictException('A newer message is available in this thread; reply to it instead.')
      const { rows: existing } = await this.pool.query('SELECT status FROM mail_sends WHERE mailbox_id=$1 AND reply_key=$2', [this.mailboxId, `${message.threadId}:${message.messageId ?? input.id}`])
      if (existing.length) throw new ConflictException('A reply to this message already exists or is uncertain. Refresh the conversation before sending.')
      if (message.messageId) {
        const { rows: nativeReplies } = await this.pool.query(`SELECT id FROM mail_messages WHERE mailbox_id=$1 AND data->>'threadId'=$2 AND (data->>'outgoing')::boolean=true AND COALESCE(data->'references','[]'::jsonb) ? $3 LIMIT 1`, [this.mailboxId, message.threadId, message.messageId])
        if (nativeReplies.length) throw new ConflictException('A reply from another mail client is already synchronized. Refresh the conversation before sending.')
      }
      const transport = this.smtp()
      await transport.verify()
      const messageId = `<${input.requestId}@${this.account.email.split('@')[1]}>`
      const date = new Date()
      const outgoing: CachedMessage['data'] = { ...message, id: `sent_${input.requestId}`, messageId, outgoing: true, imapReady: false,
        subject: /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`, sentAt: date.toISOString(), time: date.toISOString().slice(0, 10),
        participants: [{ name: message.participants?.find(person => person.email.toLowerCase() === message.replyTo!.toLowerCase())?.name ?? message.replyTo, email: message.replyTo }],
        sender: { name: this.account.name || this.account.email, email: this.account.email }, preview: cleanText(input.text.replace(/\s+/g, ' ').slice(0, 200)), body: input.text, unread: false }
      const generated = await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail({
        from: { name: this.account.name, address: this.account.email }, to: message.replyTo, subject: outgoing.subject, text: input.text, html, attachments: input.attachments?.map(a => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.content, 'base64') })), date, messageId,
        inReplyTo: message.messageId, references: [...(message.references ?? []), ...(message.messageId ? [message.messageId] : [])],
        disableFileAccess: true, disableUrlAccess: true,
      })
      const raw = generated.message as Buffer
      if (raw.length > MAX_MIME_BYTES) throw new BadRequestException('Message exceeds the archive size limit.')
      // The send reservation and its trusted author must be durable before SMTP begins.
      await this.pool.query(`WITH reserved AS (
        INSERT INTO mail_sends (mailbox_id,request_id,target_id,reply_key,body_hash,status,data,source) VALUES ($1,$2,$3,$4,$5,'sending',$6,$8) RETURNING request_id
      ) INSERT INTO postfold_activity (mailbox_id,id,conversation_id,actor,kind,data)
        SELECT $1,request_id,$3,$7::jsonb,'reply','{"status":"sending"}'::jsonb FROM reserved`,
        [this.mailboxId, input.requestId, input.id, `${message.threadId}:${message.messageId ?? input.id}`, digest, outgoing, actor ? JSON.stringify({ id: actor.id, name: actor.name }) : null, raw])
      try {
        const delivered = await transport.sendMail({ envelope: { from: this.account.email, to: [message.replyTo] }, raw })
        if (!delivered.accepted?.length) throw new Error('No recipient accepted')
        this.log('info', 'Reply sent to {0}', message.replyTo)
      } catch (error) {
        this.log('error', 'Reply to {0} could not be confirmed: {1}', message.replyTo, describeError(error))
        await this.pool.query(`WITH delivery AS (UPDATE mail_sends SET status='uncertain' WHERE mailbox_id=$1 AND request_id=$2 RETURNING request_id)
          UPDATE postfold_activity SET data=jsonb_set(data,'{status}','"uncertain"') WHERE mailbox_id=$1 AND id IN (SELECT request_id FROM delivery)`, [this.mailboxId, input.requestId])
        throw new ConflictException('Delivery could not be confirmed. Do not resend; inspect Sent and the mail server. Your draft is preserved.')
      }
      await this.archiveMessage({ id: outgoing.id, path: this.account.sentPath, validity: '', uid: 0, raw_id: messageId, data: outgoing }, raw, ['\\Seen'], date,
        { id: outgoing.id, revision: 0, unread: false, status: 'waiting', projectId: message.projectId, labelIds: [], assigneeId: states.find(item => item.id === input.id)?.assigneeId ?? null })
      await this.pool.query(`WITH delivery AS (UPDATE mail_sends SET status='sent',source=NULL WHERE mailbox_id=$1 AND request_id=$2 RETURNING request_id)
        UPDATE postfold_activity SET data=jsonb_set(data,'{status}','"sent"') WHERE mailbox_id=$1 AND id IN (SELECT request_id FROM delivery)`, [this.mailboxId, input.requestId])
      await this.pool.query("UPDATE demo_conversation_state SET status='waiting', revision=revision+1 WHERE mailbox_id=$1 AND id=$2 AND status<>'waiting'", [this.mailboxId, input.id])
      await this.pool.query(`INSERT INTO demo_conversation_state (mailbox_id,id,unread,status,project_id,label_ids,assignee_id)
        SELECT $1,$2,false,'waiting',$3,ARRAY[]::text[],assignee_id FROM demo_conversation_state WHERE mailbox_id=$1 AND id=$4 ON CONFLICT DO NOTHING`, [this.mailboxId, outgoing.id, message.projectId, input.id])
      let sentCopy = !this.account.saveSent
      if (this.account.saveSent) {
        const client = this.imap()
        try { await client.connect(); sentCopy = !!await client.append(this.account.sentPath, raw, ['\\Seen'], date) }
        catch (error) { sentCopy = false; this.log('warn', 'Sent copy could not be saved in {0}: {1}', this.account.sentPath, describeError(error)) }
        finally { await client.logout().catch(() => client.close()) }
      }
      await this.pool.query('UPDATE mail_sends SET sent_copy=$3 WHERE mailbox_id=$1 AND request_id=$2', [this.mailboxId, input.requestId, sentCopy])
      return { status: 'sent' as const, sentCopy }
    }, 60_000)
  }

  override async onApplicationShutdown() { clearInterval(this.timer); await super.onApplicationShutdown() }
}
