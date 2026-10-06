import { BadRequestException, ConflictException, type OnApplicationShutdown } from '@nestjs/common'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { isProjectSettings } from '../shared/projects.js'
import type { Activity, ConversationState, ConversationUpdate, Member, ProjectSettings, Mailbox } from '../shared/mailbox.js'
import { isActivityIds, isConversationUpdate } from '../shared/conversation-state.js'
import { demoMailbox, demoMembers } from './demo-mailbox.js'
import { authMode } from '../shared/auth.js'

const stateColumns = `id, revision, unread, status, project_id AS "projectId", label_ids AS "labelIds", assignee_id AS "assigneeId",
  (SELECT name FROM postfold_mailbox_members m WHERE m.mailbox_id=demo_conversation_state.mailbox_id AND m.id=demo_conversation_state.assignee_id) AS assignee`

export class ProjectStore implements OnApplicationShutdown {
  protected pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgresql://mailer_demo:mailer_demo@127.0.0.1:55432/mailer_support', connectionTimeoutMillis: 5000 })
  constructor(protected mailboxId = 'support-demo', private seedMailbox: Mailbox = demoMailbox) {}

  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS demo_project_settings (
      mailbox_id text PRIMARY KEY, revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0), settings jsonb NOT NULL
    )`)
    await this.pool.query('INSERT INTO demo_project_settings (mailbox_id, settings) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [this.mailboxId, { projects: this.seedMailbox.projects, labels: this.seedMailbox.labels ?? [], order: this.seedMailbox.projects.map((item) => item.id), sort: 'manual' }])
    await this.pool.query(`CREATE TABLE IF NOT EXISTS postfold_mailbox_members (
      mailbox_id text NOT NULL REFERENCES demo_project_settings(mailbox_id) ON DELETE CASCADE,
      id text NOT NULL, name text NOT NULL, email text NOT NULL, PRIMARY KEY (mailbox_id,id)
    )`)
    await this.pool.query('ALTER TABLE postfold_mailbox_members ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false')
    if (this.seedMailbox === demoMailbox && authMode() === 'basic') for (const member of demoMembers) await this.members(member)
    await this.pool.query(`CREATE TABLE IF NOT EXISTS postfold_activity (
      mailbox_id text NOT NULL REFERENCES demo_project_settings(mailbox_id) ON DELETE CASCADE,
      id uuid NOT NULL, conversation_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      actor jsonb, kind text NOT NULL CHECK (kind IN ('updated','reply')), data jsonb NOT NULL, PRIMARY KEY (mailbox_id,id)
    )`)
    await this.pool.query('CREATE INDEX IF NOT EXISTS postfold_activity_conversation ON postfold_activity (mailbox_id,conversation_id,created_at DESC,id DESC)')
    await this.pool.query(`CREATE TABLE IF NOT EXISTS demo_conversation_state (
      mailbox_id text NOT NULL REFERENCES demo_project_settings(mailbox_id) ON DELETE CASCADE,
      id text NOT NULL, revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
      unread boolean NOT NULL, status text NOT NULL CHECK (status IN ('open', 'waiting', 'closed')),
      PRIMARY KEY (mailbox_id, id)
    )`)
    await this.pool.query('ALTER TABLE demo_conversation_state ADD COLUMN IF NOT EXISTS project_id text, ADD COLUMN IF NOT EXISTS label_ids text[] NOT NULL DEFAULT ARRAY[]::text[], ADD COLUMN IF NOT EXISTS assignee_id text')
    const settings = await this.read()
    const seeds = this.seedMailbox.conversations.map((message) => ({ ...message,
      projectId: settings.projects.some((item) => item.id === message.projectId) ? message.projectId : settings.projects[0].id,
      labelIds: (message.labelIds ?? []).flatMap((id) => {
        const source = this.seedMailbox.labels?.find((item) => item.id === id)
        const label = settings.labels?.find((item) => item.id === id || item.name === source?.name)
        return label ? [label.id] : []
      }),
    }))
    await this.pool.query(`INSERT INTO demo_conversation_state (mailbox_id, id, unread, status, project_id, label_ids)
      SELECT $1, id, unread, status, "projectId", ARRAY(SELECT jsonb_array_elements_text(COALESCE("labelIds", '[]'::jsonb))) FROM jsonb_to_recordset($2::jsonb) AS x(id text, unread boolean, status text, "projectId" text, "labelIds" jsonb)
      ON CONFLICT DO NOTHING`, [this.mailboxId, JSON.stringify(seeds)])
    await this.pool.query(`UPDATE demo_conversation_state s SET project_id = x."projectId"
      FROM jsonb_to_recordset($2::jsonb) AS x(id text, "projectId" text)
      WHERE s.mailbox_id = $1 AND s.id = x.id AND s.project_id IS NULL`, [this.mailboxId, JSON.stringify(seeds)])
  }

  async read(): Promise<ProjectSettings> {
    const { rows } = await this.pool.query('SELECT revision, settings FROM demo_project_settings WHERE mailbox_id = $1', [this.mailboxId])
    return { revision: rows[0].revision, ...rows[0].settings, labels: rows[0].settings.labels ?? [] }
  }

  async update(input: unknown): Promise<ProjectSettings> {
    if (!isProjectSettings(input)) throw new BadRequestException('Dossiers, hiérarchie ou labels invalides : codes et noms uniques, parents et couleurs valides requis.')
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query('SELECT revision, settings FROM demo_project_settings WHERE mailbox_id = $1 FOR UPDATE', [this.mailboxId])
      const previous: ProjectSettings = { revision: rows[0].revision, ...rows[0].settings, labels: rows[0].settings.labels ?? [] }
      if (previous.revision !== input.revision) throw new ConflictException({ message: 'Les réglages ont été modifiés par un collègue. Votre saisie est conservée ; vérifiez puis réessayez.', settings: previous })
      const deleted = previous.projects.filter((item) => !input.projects.some((next) => next.id === item.id)).map((item) => item.id)
      if (deleted.length) {
        const { rowCount } = await client.query('SELECT 1 FROM demo_conversation_state WHERE mailbox_id = $1 AND project_id = ANY($2::text[]) LIMIT 1', [this.mailboxId, deleted])
        if (rowCount) throw new BadRequestException('Déplacez les conversations avant de supprimer ce dossier.')
      }
      const projects = input.projects.map(({ id, name, color, parentId, code }) => ({ id, name, color, parentId: parentId ?? null, ...(code !== undefined ? { code } : {}),
        createdAt: previous.projects.find((item) => item.id === id)?.createdAt ?? new Date().toISOString() }))
      const labels = input.labels ?? []
      const removedLabels = (previous.labels ?? []).filter((item) => !labels.some((next) => next.id === item.id)).map((item) => item.id)
      if (removedLabels.length) await client.query(`UPDATE demo_conversation_state SET label_ids = ARRAY(SELECT value FROM unnest(label_ids) value WHERE NOT value = ANY($2::text[])), revision = revision + 1
        WHERE mailbox_id = $1 AND label_ids && $2::text[]`, [this.mailboxId, removedLabels])
      const settings = { projects, labels, order: input.order, sort: input.sort }
      await client.query('UPDATE demo_project_settings SET settings = $2, revision = revision + 1 WHERE mailbox_id = $1', [this.mailboxId, settings])
      await client.query('COMMIT')
      return { revision: previous.revision + 1, ...settings }
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  async readConversationStates(): Promise<ConversationState[]> {
    const { rows } = await this.pool.query<ConversationState>(`SELECT ${stateColumns} FROM demo_conversation_state WHERE mailbox_id = $1 ORDER BY id`, [this.mailboxId])
    return rows
  }

  async members(viewer?: Member): Promise<Member[]> {
    if (viewer) await this.pool.query(`INSERT INTO postfold_mailbox_members (mailbox_id,id,name,email,is_demo) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (mailbox_id,id) DO UPDATE SET name=EXCLUDED.name,email=EXCLUDED.email,is_demo=EXCLUDED.is_demo
      WHERE postfold_mailbox_members.name IS DISTINCT FROM EXCLUDED.name OR postfold_mailbox_members.email IS DISTINCT FROM EXCLUDED.email OR postfold_mailbox_members.is_demo IS DISTINCT FROM EXCLUDED.is_demo`, [this.mailboxId, viewer.id, viewer.name, viewer.email, viewer.provider === 'demo'])
    return (await this.pool.query<Member>('SELECT id,name,email FROM postfold_mailbox_members WHERE mailbox_id=$1 AND ($2::boolean OR NOT is_demo) ORDER BY lower(name),id', [this.mailboxId, authMode() === 'basic'])).rows
  }

  async activity(ids: unknown): Promise<Activity[]> {
    if (!isActivityIds(ids)) throw new BadRequestException('Invalid activity selection.')
    const { rows } = await this.pool.query<Activity>(`SELECT id,conversation_id AS "conversationId",created_at AS "createdAt",actor,kind,data
      FROM postfold_activity WHERE mailbox_id=$1 AND conversation_id=ANY($2::text[]) ORDER BY created_at DESC,id DESC LIMIT 50`, [this.mailboxId, ids])
    return rows
  }

  protected async checkAssignee(input: ConversationUpdate) {
    if (input.assigneeId != null && !(await this.pool.query('SELECT 1 FROM postfold_mailbox_members WHERE mailbox_id=$1 AND id=$2 AND ($3::boolean OR NOT is_demo)', [this.mailboxId, input.assigneeId, authMode() === 'basic'])).rowCount) throw new BadRequestException('Ce collègue n’est pas connu dans cette boîte. Relevez puis réessayez.')
  }

  async updateConversations(input: unknown, actor?: Member): Promise<ConversationState[]> {
    if (!isConversationUpdate(input)) throw new BadRequestException('Sélection ou état de conversation invalide.')
    if (actor) await this.members(actor)
    await this.checkAssignee(input)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // ponytail: serialize demo writes per mailbox; finer catalog locks can follow if contention becomes measurable.
      const { rows: metadata } = await client.query('SELECT settings FROM demo_project_settings WHERE mailbox_id = $1 FOR UPDATE', [this.mailboxId])
      const settings: ProjectSettings = metadata[0].settings
      if (input.projectId !== undefined && !settings.projects.some((item) => item.id === input.projectId)) throw new BadRequestException('Ce dossier n’existe plus.')
      const labelIds = (settings.labels ?? []).map((item) => item.id)
      if ([...(input.addLabelIds ?? []), ...(input.removeLabelIds ?? [])].some((id) => !labelIds.includes(id))) throw new BadRequestException('Un label n’existe plus.')
      const ids = input.targets.map((target) => target.id)
      const { rows } = await client.query<ConversationState>(`SELECT ${stateColumns} FROM demo_conversation_state
        WHERE mailbox_id = $1 AND id = ANY($2::text[]) ORDER BY id FOR UPDATE`, [this.mailboxId, ids])
      if (rows.length !== ids.length) throw new BadRequestException('Une conversation n’existe plus dans cette boîte.')
      const next = rows.map((row) => ({ ...row, unread: input.unread ?? row.unread, status: input.status ?? row.status, projectId: input.projectId ?? row.projectId,
        assigneeId: input.assigneeId !== undefined ? input.assigneeId : row.assigneeId,
        labelIds: [...new Set([...(row.labelIds ?? []), ...(input.addLabelIds ?? [])])].filter((id) => !input.removeLabelIds?.includes(id)).sort() }))
      const changed = next.filter((row, index) => row.assigneeId !== rows[index].assigneeId || row.unread !== rows[index].unread || row.status !== rows[index].status || row.projectId !== rows[index].projectId || JSON.stringify(row.labelIds) !== JSON.stringify([...(rows[index].labelIds ?? [])].sort()))
      if (changed.some((row) => row.revision !== input.targets.find((target) => target.id === row.id)!.revision)) {
        throw new ConflictException({ message: 'Un collègue a modifié une conversation. Aucun changement du lot n’a été appliqué ; vérifiez les états puis réessayez.', states: rows })
      }
      if (changed.length) await client.query(`UPDATE demo_conversation_state s SET unread = x.unread, status = x.status, project_id = x."projectId", label_ids = ARRAY(SELECT jsonb_array_elements_text(x."labelIds")), assignee_id=x."assigneeId", revision = s.revision + 1
        FROM jsonb_to_recordset($2::jsonb) AS x(id text, unread boolean, status text, "projectId" text, "labelIds" jsonb, "assigneeId" text)
        WHERE s.mailbox_id = $1 AND s.id = x.id`, [this.mailboxId, JSON.stringify(changed)])
      const updated = (await client.query<ConversationState>(`SELECT ${stateColumns} FROM demo_conversation_state WHERE mailbox_id=$1 AND id=ANY($2::text[]) ORDER BY id`, [this.mailboxId, ids])).rows
      if (changed.length) await client.query(`INSERT INTO postfold_activity (mailbox_id,id,conversation_id,actor,kind,data)
        SELECT $1,x.id::uuid,x."conversationId",$3::jsonb,'updated',x.data FROM jsonb_to_recordset($2::jsonb) AS x(id text,"conversationId" text,data jsonb)`,
        [this.mailboxId, JSON.stringify(changed.map((row) => ({ id: randomUUID(), conversationId: row.id, data: { before: rows.find((item) => item.id === row.id), after: updated.find((item) => item.id === row.id) } }))), actor ? JSON.stringify({ id: actor.id, name: actor.name }) : null])
      await client.query('COMMIT')
      return updated
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  async onApplicationShutdown() { await this.pool.end() }
}
