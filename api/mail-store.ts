import { BadRequestException, ConflictException, HttpException, ServiceUnavailableException } from '@nestjs/common'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { ImapFlow, type FetchMessageObject } from 'imapflow'
import nodemailer from 'nodemailer'
import { simpleParser } from 'mailparser'
import { ProjectStore } from './project-store.js'
import { loadAccount } from './mail-secrets.js'
import { isMailAddress, isReplyRequest, type MailAccount } from '../shared/mail-account.js'
import { isConversationUpdate, applyConversationStates } from '../shared/conversation-state.js'
import { isProjectSettings } from '../shared/projects.js'
import type { Conversation, ConversationUpdate, DemoMailbox, Project } from '../shared/mailbox.js'

type CachedMessage = { id: string; path: string; validity: string; uid: number; raw_id: string | null; data: Conversation & { replyTo?: string; references?: string[]; receivedAt?: string } }
type Folder = { id: string; path: string }
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24)
const emptyMailbox = { projects: [{ id: 'inbox', name: 'INBOX', color: 'blue', code: null }], contacts: [], conversations: [] }
const slot = (path: string, validity: string, uid: number) => JSON.stringify([path, validity, uid])
const folderName = (project: Project) => project.parentId || project.code === null ? project.name : `${project.code ?? project.id} - ${project.name}`

export class MailStore extends ProjectStore {
  private account!: MailAccount
  private timer?: ReturnType<typeof setInterval>
  private lastSync: string | null = null
  private syncError = false
  private delimiter = '/'
  private readonly limit = Math.max(1, Math.min(1000, Number(process.env.MAILBOX_SYNC_LIMIT) || 200))

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
  }

  startPolling() {
    this.timer = setInterval(() => void this.sync().catch(() => {}), 30_000)
    this.timer.unref()
    void this.sync().catch(() => {})
  }

  private tls() {
    return { rejectUnauthorized: true, minVersion: 'TLSv1.2' as const, ...(process.env.MAILBOX_CA_FILE ? { ca: readFileSync(process.env.MAILBOX_CA_FILE) } : {}) }
  }

  private imap() {
    const endpoint = this.account.imap
    const client = new ImapFlow({ host: endpoint.host, port: endpoint.port, secure: endpoint.security === 'tls',
      ...(endpoint.security === 'starttls' ? { doSTARTTLS: true } : {}),
      auth: { user: endpoint.user, pass: endpoint.password }, tls: this.tls(), logger: false,
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000, disableAutoIdle: true })
    // Protocol errors must not become unhandled events or expose credentials in logs.
    client.on('error', () => {})
    return client
  }

  private smtp() {
    const endpoint = this.account.smtp
    return nodemailer.createTransport({ host: endpoint.host, port: endpoint.port, secure: endpoint.security === 'tls',
      requireTLS: true, auth: { user: endpoint.user, pass: endpoint.password }, tls: this.tls(),
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000, logger: false, debug: false,
      disableFileAccess: true, disableUrlAccess: true })
  }

  private async exclusive<T>(run: () => Promise<T>): Promise<T> {
    const lock = await this.pool.connect()
    let held = false
    try {
      // ponytail: one PostgreSQL session lock per mailbox; split sync/write locks if throughput requires it.
      const { rows } = await lock.query('SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS held', ['postfold:mail', this.mailboxId])
      held = rows[0].held
      if (!held) throw new ConflictException('Mailbox operation in progress; refresh before retrying.')
      return await run()
    } catch (error) {
      if (error instanceof HttpException) throw error
      throw new ServiceUnavailableException('Mail server operation could not be confirmed. Refresh before retrying; no automatic resend was attempted.')
    } finally {
      if (held) await lock.query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2))', ['postfold:mail', this.mailboxId])
      lock.release()
    }
  }

  async mailbox(): Promise<DemoMailbox> {
    const [settings, conversationStates, messages, sends] = await Promise.all([
      this.read(), this.readConversationStates(),
      this.pool.query<CachedMessage>('SELECT * FROM mail_messages WHERE mailbox_id = $1', [this.mailboxId]),
      this.pool.query('SELECT target_id, status, sent_copy, data FROM mail_sends WHERE mailbox_id = $1', [this.mailboxId]),
    ])
    const imported = messages.rows.map((row) => row.data)
    const messageIds = new Set(imported.map((item) => item.messageId))
    const outgoing = sends.rows.filter((row) => row.status === 'sent' && !messageIds.has(row.data.messageId)).map((row) => row.data as Conversation)
    const conversations = applyConversationStates([...imported, ...outgoing], conversationStates)
      .sort((a, b) => (Date.parse(b.sentAt ?? '') || 0) - (Date.parse(a.sentAt ?? '') || 0))
    const contacts = new Map<string, { id: string; name: string; email: string; company: string; phone: string }>()
    for (const message of conversations) {
      const source = message as CachedMessage['data']
      const email = source.replyTo ?? source.sender?.email ?? ''
      contacts.set(message.contactId, { id: message.contactId, name: source.outgoing ? email : source.sender?.name || email, email, company: '', phone: '' })
    }
    const { projects, ...projectSettings } = settings
    return { projects, projectSettings, labels: settings.labels ?? [], conversations, contacts: [...contacts.values()], conversationStates,
      connection: { mode: 'imap', email: this.account.email, lastSync: this.lastSync, error: this.syncError, maxMessagesPerSync: this.limit },
      deliveries: sends.rows.map((row) => ({ targetId: row.target_id, status: row.status, sentCopy: row.sent_copy })) }
  }

  async sync() {
    try {
      await this.exclusive(async () => {
        const client = this.imap()
        try { await client.connect(); await this.importMailbox(client); this.lastSync = new Date().toISOString(); this.syncError = false }
        finally { await client.logout().catch(() => client.close()) }
      })
    } catch (error) { if (error instanceof ConflictException) return this.mailbox(); this.syncError = true; throw error }
    return this.mailbox()
  }

  private async importMailbox(client: ImapFlow) {
    let listed = await client.list()
    if (this.account.saveSent && !listed.some((item) => item.path === this.account.sentPath)) {
      await client.mailboxCreate(this.account.sentPath)
      listed = await client.list()
    }
    this.delimiter = listed.find((item) => item.path === 'INBOX')?.delimiter || '/'
    const oldSettings = await this.read()
    const { rows: oldFolders } = await this.pool.query<Folder>('SELECT id, path FROM mail_folders WHERE mailbox_id = $1', [this.mailboxId])
    const { rows: oldMessages } = await this.pool.query<CachedMessage>('SELECT * FROM mail_messages WHERE mailbox_id = $1', [this.mailboxId])
    const { rows: sent } = await this.pool.query<{ data: Conversation }>("SELECT data FROM mail_sends WHERE mailbox_id = $1 AND status = 'sent'", [this.mailboxId])
    const bySlot = new Map(oldMessages.map((row) => [slot(row.path, row.validity, Number(row.uid)), row]))
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
    const inventory: { path: string; validity: string; projectId: string; message: FetchMessageObject }[] = []
    for (const { folder, id } of folders) {
      if (folder.flags.has('\\Noselect')) continue
      const lock = await client.getMailboxLock(folder.path)
      try {
        const box = client.mailbox
        if (!box || !box.exists) continue
        for await (const message of client.fetch('1:*', { uid: true, flags: true, size: true, internalDate: true })) {
          inventory.push({ path: folder.path, validity: String(box.uidValidity), projectId: id, message })
        }
      } finally { lock.release() }
    }
    const liveSlots = new Set(inventory.map((item) => slot(item.path, item.validity, item.message.uid)))
    const staged: CachedMessage[] = []
    let importPending = false
    for (const { folder, id } of folders) {
      const items = inventory.filter((item) => item.path === folder.path)
      const uncached = items.filter((item) => !bySlot.has(slot(item.path, item.validity, item.message.uid)) && (item.message.size ?? 0) <= 10 * 1024 * 1024)
      const missing = uncached.slice(-this.limit)
      importPending ||= uncached.length > missing.length
      const raw = new Map<number, Buffer>()
      if (missing.length) {
        const lock = await client.getMailboxLock(folder.path)
        try {
          const small = missing.filter((item) => (item.message.size ?? 0) <= 10 * 1024 * 1024)
          if (small.length) for await (const message of client.fetch(small.map((item) => item.message.uid).join(','), { uid: true, source: true }, { uid: true })) {
            if (message.source) raw.set(message.uid, message.source)
          }
        } finally { lock.release() }
      }
      for (const item of items) {
        const previous = bySlot.get(slot(item.path, item.validity, item.message.uid))
        const unread = !item.message.flags?.has('\\Seen')
        if (previous) { staged.push({ ...previous, data: { ...previous.data, unread, projectId: id } }); continue }
        if (!missing.includes(item)) continue
        const source = raw.get(item.message.uid)
        // Oversized MIME messages are not downloaded; importing them later cannot consume unbounded RAM.
        if (!source) continue
        const parsed = await simpleParser(source, { skipTextToHtml: true })
        const sender = parsed.from?.value[0]
        const outgoing = sender?.address?.toLowerCase() === this.account.email.toLowerCase()
        const recipient = outgoing ? (Array.isArray(parsed.to) ? parsed.to[0] : parsed.to)?.value[0] : parsed.replyTo?.value[0] ?? sender
        const email = recipient?.address ?? ''
        const rawId = parsed.messageId ?? null
        const moved = oldMessages.filter((row) => rawId && row.raw_id === rawId && !liveSlots.has(slot(row.path, row.validity, Number(row.uid))) && !staged.some((next) => next.id === row.id))
        const references = [...(typeof parsed.references === 'string' ? [parsed.references] : parsed.references ?? []), ...(parsed.inReplyTo ? [parsed.inReplyTo] : [])]
        const date = parsed.date && Number.isFinite(parsed.date.getTime()) ? parsed.date : new Date(item.message.internalDate || Date.now())
        const sentAt = date.toISOString()
        const body = parsed.text ?? ''
        const sentCopy = rawId && outgoing ? sent.find((item) => item.data.messageId === rawId)?.data : undefined
        const sentId = sentCopy && !staged.some((row) => row.id === sentCopy.id) && !oldMessages.some((row) => row.id === sentCopy.id && liveSlots.has(slot(row.path, row.validity, Number(row.uid)))) ? sentCopy.id : undefined
        const data: CachedMessage['data'] = { id: sentId ?? (moved.length === 1 ? moved[0].id : randomUUID()), projectId: id, contactId: `c_${hash(email.toLowerCase())}`,
          threadId: sentCopy?.threadId ?? hash(references[0] ?? parsed.inReplyTo ?? rawId ?? randomUUID()), sentAt,
          sender: { name: sender?.name || sender?.address || 'Unknown sender', email: sender?.address ?? '' },
          subject: parsed.subject ?? '(No subject)', preview: body.replace(/\s+/g, ' ').slice(0, 200), body,
          time: sentAt.slice(0, 10), status: outgoing ? 'waiting' : 'open', assignee: null, unread, labelIds: [], outgoing, imapReady: true, replyTo: email, references,
          receivedAt: new Date(item.message.internalDate || date).toISOString(), ...(rawId ? { messageId: rawId } : {}) }
        staged.push({ id: data.id, path: item.path, validity: item.validity, uid: item.message.uid, raw_id: rawId, data })
      }
    }
    if (importPending) {
      // Preserve annotations on native moves larger than one import batch until their new UIDs are parsed.
      for (const previous of oldMessages) if (!staged.some((row) => row.id === previous.id)) {
        staged.push(previous)
        const project = oldSettings.projects.find((item) => item.id === previous.data.projectId)
        if (project && !projects.some((item) => item.id === project.id)) projects.push(project)
      }
    }
    const transaction = await this.pool.connect()
    try {
      await transaction.query('BEGIN')
      const { rows } = await transaction.query('SELECT settings FROM demo_project_settings WHERE mailbox_id = $1 FOR UPDATE', [this.mailboxId])
      const settings = rows[0].settings
      const merged = { ...settings, projects, order: [...settings.order.filter((id: string) => projects.some((item) => item.id === id)), ...projects.filter((item) => !settings.order.includes(item.id)).map((item) => item.id)] }
      if (JSON.stringify(settings) !== JSON.stringify(merged)) await transaction.query('UPDATE demo_project_settings SET settings = $2, revision = revision + 1 WHERE mailbox_id = $1', [this.mailboxId, merged])
      await transaction.query('DELETE FROM mail_folders WHERE mailbox_id = $1', [this.mailboxId])
      for (const { folder, id } of folders) await transaction.query('INSERT INTO mail_folders (mailbox_id, id, path) VALUES ($1, $2, $3)', [this.mailboxId, id, folder.path])
      const keep = staged.map((row) => row.id)
      await transaction.query('DELETE FROM mail_messages WHERE mailbox_id = $1 AND NOT (id = ANY($2::text[]))', [this.mailboxId, keep])
      await transaction.query('DELETE FROM demo_conversation_state WHERE mailbox_id = $1 AND NOT (id = ANY($2::text[])) AND id NOT LIKE $3', [this.mailboxId, keep, 'sent_%'])
      for (const row of staged) {
        await transaction.query(`INSERT INTO mail_messages (mailbox_id, id, path, validity, uid, raw_id, data) VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (mailbox_id,id) DO UPDATE SET path=EXCLUDED.path, validity=EXCLUDED.validity, uid=EXCLUDED.uid, raw_id=EXCLUDED.raw_id, data=EXCLUDED.data`,
        [this.mailboxId, row.id, row.path, row.validity, row.uid, row.raw_id, row.data])
        await transaction.query(`INSERT INTO demo_conversation_state (mailbox_id,id,unread,status,project_id,label_ids) VALUES ($1,$2,$3,$5,$4,ARRAY[]::text[])
          ON CONFLICT (mailbox_id,id) DO UPDATE SET unread=EXCLUDED.unread, project_id=EXCLUDED.project_id,
          revision=demo_conversation_state.revision + CASE WHEN demo_conversation_state.unread IS DISTINCT FROM EXCLUDED.unread OR demo_conversation_state.project_id IS DISTINCT FROM EXCLUDED.project_id THEN 1 ELSE 0 END`,
        [this.mailboxId, row.id, row.data.unread, row.data.projectId, row.data.status])
      }
      await transaction.query('COMMIT')
    } catch (error) { await transaction.query('ROLLBACK'); throw error } finally { transaction.release() }
  }

  override async updateConversations(input: unknown) {
    if (!isConversationUpdate(input)) throw new BadRequestException('Invalid conversation update.')
    return this.exclusive(async () => {
      const states = await this.readConversationStates()
      const settings = await this.read()
      const targets = input.targets.map((target) => states.find((item) => item.id === target.id))
      if (targets.some((item) => !item)) throw new BadRequestException('Message no longer exists.')
      if (targets.some((item, index) => item!.revision !== input.targets[index].revision)) throw new ConflictException({ message: 'Conversation changed; refresh before retrying.', states: targets })
      if ([...(input.addLabelIds ?? []), ...(input.removeLabelIds ?? [])].some((id) => !settings.labels?.some((label) => label.id === id))) throw new BadRequestException('Unknown label.')
      if (input.projectId && !settings.projects.some((item) => item.id === input.projectId)) throw new BadRequestException('Unknown destination folder.')
      if (input.unread !== undefined || input.projectId !== undefined) await this.applyImapUpdate(input)
      return super.updateConversations(input)
    })
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
              for (const [id, oldPath] of paths) if (oldPath === previous || oldPath.startsWith(previous + this.delimiter)) {
                const renamed = path + oldPath.slice(previous.length)
                await this.pool.query('UPDATE mail_folders SET path=$3 WHERE mailbox_id=$1 AND id=$2', [this.mailboxId, id, renamed])
                await this.pool.query('UPDATE mail_messages SET path=$3 WHERE mailbox_id=$1 AND path=$2', [this.mailboxId, oldPath, renamed])
                paths.set(id, renamed)
              }
            } else {
              await client.mailboxCreate(path)
              await this.pool.query('INSERT INTO mail_folders (mailbox_id,id,path) VALUES ($1,$2,$3)', [this.mailboxId, project.id, path])
              paths.set(project.id, path)
            }
          }
        } finally { await client.logout().catch(() => client.close()) }
      }
      return super.update(input)
    })
  }

  async reply(input: unknown) {
    if (!isReplyRequest(input)) throw new BadRequestException('Invalid reply.')
    return this.exclusive(async () => {
      const digest = hash(JSON.stringify([input.id, input.text]))
      const { rows: attempts } = await this.pool.query('SELECT status, body_hash, sent_copy FROM mail_sends WHERE mailbox_id=$1 AND request_id=$2', [this.mailboxId, input.requestId])
      if (attempts.length) {
        if (attempts[0].body_hash !== digest) throw new ConflictException('Request ID already used for a different reply.')
        if (attempts[0].status !== 'sent') throw new ConflictException('Delivery is pending or uncertain; inspect Sent before retrying. Automatic resend is blocked.')
        return { status: 'sent' as const, sentCopy: attempts[0].sent_copy }
      }
      // Reconcile native-client replies and newer incoming messages before claiming a send.
      const imap = this.imap()
      try { await imap.connect(); await this.importMailbox(imap); this.lastSync = new Date().toISOString(); this.syncError = false }
      finally { await imap.logout().catch(() => imap.close()) }
      const { rows } = await this.pool.query<CachedMessage>('SELECT * FROM mail_messages WHERE mailbox_id=$1 AND id=$2', [this.mailboxId, input.id])
      const message = rows[0]?.data
      if (!message || message.outgoing || !isMailAddress(message.replyTo)) throw new BadRequestException('Select a received message with a valid reply address.')
      const states = await this.readConversationStates()
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
        sender: { name: this.account.name || this.account.email, email: this.account.email }, preview: input.text.replace(/\s+/g, ' ').slice(0, 200), body: input.text, unread: false }
      const generated = await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail({
        from: { name: this.account.name, address: this.account.email }, to: message.replyTo, subject: outgoing.subject, text: input.text, date, messageId,
        inReplyTo: message.messageId, references: [...(message.references ?? []), ...(message.messageId ? [message.messageId] : [])],
        disableFileAccess: true, disableUrlAccess: true,
      })
      const raw = generated.message as Buffer
      await this.pool.query(`INSERT INTO mail_sends (mailbox_id,request_id,target_id,reply_key,body_hash,status,data) VALUES ($1,$2,$3,$4,$5,'sending',$6)`,
        [this.mailboxId, input.requestId, input.id, `${message.threadId}:${message.messageId ?? input.id}`, digest, outgoing])
      try {
        const delivered = await transport.sendMail({ envelope: { from: this.account.email, to: [message.replyTo] }, raw })
        if (!delivered.accepted?.length) throw new Error('No recipient accepted')
      } catch {
        await this.pool.query("UPDATE mail_sends SET status='uncertain' WHERE mailbox_id=$1 AND request_id=$2", [this.mailboxId, input.requestId])
        throw new ConflictException('Delivery could not be confirmed. Do not resend; inspect Sent and the mail server. Your draft is preserved.')
      }
      await this.pool.query("UPDATE mail_sends SET status='sent' WHERE mailbox_id=$1 AND request_id=$2", [this.mailboxId, input.requestId])
      await this.pool.query("UPDATE demo_conversation_state SET status='waiting', revision=revision+1 WHERE mailbox_id=$1 AND id=$2 AND status<>'waiting'", [this.mailboxId, input.id])
      await this.pool.query(`INSERT INTO demo_conversation_state (mailbox_id,id,unread,status,project_id,label_ids) VALUES ($1,$2,false,'waiting',$3,ARRAY[]::text[]) ON CONFLICT DO NOTHING`, [this.mailboxId, outgoing.id, message.projectId])
      let sentCopy = !this.account.saveSent
      if (this.account.saveSent) {
        const client = this.imap()
        try { await client.connect(); sentCopy = !!await client.append(this.account.sentPath, raw, ['\\Seen'], date) }
        catch { sentCopy = false }
        finally { await client.logout().catch(() => client.close()) }
      }
      await this.pool.query('UPDATE mail_sends SET sent_copy=$3 WHERE mailbox_id=$1 AND request_id=$2', [this.mailboxId, input.requestId, sentCopy])
      return { status: 'sent' as const, sentCopy }
    })
  }

  override async onApplicationShutdown() { clearInterval(this.timer); await super.onApplicationShutdown() }
}
