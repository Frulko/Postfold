import { BadRequestException, ConflictException, type OnApplicationShutdown } from '@nestjs/common'
import { Pool } from 'pg'
import { isProjectSettings } from '../shared/projects.js'
import type { ConversationState, ProjectSettings } from '../shared/mailbox.js'
import { isConversationUpdate } from '../shared/conversation-state.js'
import { demoMailbox } from './demo-mailbox.js'

export class ProjectStore implements OnApplicationShutdown {
  private pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgresql://mailer_demo:mailer_demo@127.0.0.1:55432/mailer_support', connectionTimeoutMillis: 5000 })
  constructor(private mailboxId = 'support-demo') {}

  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS demo_project_settings (
      mailbox_id text PRIMARY KEY, revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0), settings jsonb NOT NULL
    )`)
    await this.pool.query('INSERT INTO demo_project_settings (mailbox_id, settings) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [this.mailboxId, { projects: demoMailbox.projects, order: demoMailbox.projects.map((item) => item.id), sort: 'manual' }])
    await this.pool.query(`CREATE TABLE IF NOT EXISTS demo_conversation_state (
      mailbox_id text NOT NULL REFERENCES demo_project_settings(mailbox_id) ON DELETE CASCADE,
      id text NOT NULL, revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
      unread boolean NOT NULL, status text NOT NULL CHECK (status IN ('open', 'waiting', 'closed')),
      PRIMARY KEY (mailbox_id, id)
    )`)
    await this.pool.query(`INSERT INTO demo_conversation_state (mailbox_id, id, unread, status)
      SELECT $1, id, unread, status FROM jsonb_to_recordset($2::jsonb) AS x(id text, unread boolean, status text)
      ON CONFLICT DO NOTHING`, [this.mailboxId, JSON.stringify(demoMailbox.conversations)])
  }

  async read(): Promise<ProjectSettings> {
    const { rows } = await this.pool.query('SELECT revision, settings FROM demo_project_settings WHERE mailbox_id = $1', [this.mailboxId])
    return { revision: rows[0].revision, ...rows[0].settings }
  }

  async update(input: unknown) {
    if (!isProjectSettings(input)) throw new BadRequestException('Dossiers ou réglages invalides : codes uniques, noms et couleurs valides requis.')
    const previous = await this.read()
    if (previous.revision !== input.revision) throw new ConflictException({ message: 'Les réglages ont été modifiés par un collègue. Votre saisie est conservée ; vérifiez puis réessayez.', settings: previous })
    if (previous.projects.some((item) => !input.projects.some((next) => next.id === item.id))) throw new BadRequestException('La suppression ou le changement de code des dossiers existants est interdit.')
    const projects = input.projects.map(({ id, name, color }) => ({ id, name, color,
      createdAt: previous.projects.find((item) => item.id === id)?.createdAt ?? new Date().toISOString() }))
    // ponytail: une révision pour tous les réglages de la boîte ; passer à des révisions par dossier si les conflits deviennent fréquents.
    const { rows } = await this.pool.query(`UPDATE demo_project_settings SET settings = $1, revision = revision + 1
      WHERE mailbox_id = $2 AND revision = $3 RETURNING revision, settings`,
    [{ projects, order: input.order, sort: input.sort }, this.mailboxId, input.revision])
    if (!rows.length) throw new ConflictException({ message: 'Les réglages ont été modifiés par un collègue. Votre saisie est conservée ; vérifiez puis réessayez.', settings: await this.read() })
    return { revision: rows[0].revision, ...rows[0].settings } as ProjectSettings
  }

  async readConversationStates(): Promise<ConversationState[]> {
    const { rows } = await this.pool.query<ConversationState>('SELECT id, revision, unread, status FROM demo_conversation_state WHERE mailbox_id = $1 ORDER BY id', [this.mailboxId])
    return rows
  }

  async updateConversations(input: unknown): Promise<ConversationState[]> {
    if (!isConversationUpdate(input)) throw new BadRequestException('Sélection ou état de conversation invalide.')
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const ids = input.targets.map((target) => target.id)
      const { rows } = await client.query<ConversationState>(`SELECT id, revision, unread, status FROM demo_conversation_state
        WHERE mailbox_id = $1 AND id = ANY($2::text[]) ORDER BY id FOR UPDATE`, [this.mailboxId, ids])
      if (rows.length !== ids.length) throw new BadRequestException('Une conversation n’existe plus dans cette boîte.')
      const changes = (row: ConversationState) => (input.unread !== undefined && row.unread !== input.unread) || (input.status !== undefined && row.status !== input.status)
      if (rows.some((row) => changes(row) && row.revision !== input.targets.find((target) => target.id === row.id)!.revision)) {
        throw new ConflictException({ message: 'Un collègue a modifié une conversation. Aucun changement du lot n’a été appliqué ; vérifiez les états puis réessayez.', states: rows })
      }
      const { rows: updated } = await client.query<ConversationState>(`UPDATE demo_conversation_state
        SET unread = COALESCE($3::boolean, unread), status = COALESCE($4::text, status), revision = revision + 1
        WHERE mailbox_id = $1 AND id = ANY($2::text[]) AND
          (unread IS DISTINCT FROM COALESCE($3::boolean, unread) OR status IS DISTINCT FROM COALESCE($4::text, status))
        RETURNING id, revision, unread, status`, [this.mailboxId, ids, input.unread ?? null, input.status ?? null])
      await client.query('COMMIT')
      return rows.map((row) => updated.find((item) => item.id === row.id) ?? row)
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  async onApplicationShutdown() { await this.pool.end() }
}
