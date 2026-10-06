import { useRef, useState } from 'react'
import type { Conversation, ConversationPatch, Member } from '../../shared/mailbox'
import { useI18n } from '../lib/i18n'
import { Icon } from './icon'

export function AssignmentPicker({ members, currentId, conversations, disabled, onChange }: {
  members: Member[]; currentId?: string; conversations: Conversation[]; disabled: boolean; onChange: (patch: ConversationPatch) => Promise<boolean>
}) {
  const { t } = useI18n()
  const details = useRef<HTMLDetailsElement>(null)
  const [query, setQuery] = useState('')
  const normalize = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase()
  const ids = new Set(conversations.map((item) => item.assigneeId ?? null))
  const current = ids.size === 1 ? conversations[0]?.assignee : null
  async function assign(assigneeId: string | null) {
    if (await onChange({ assigneeId })) { if (details.current) details.current.open = false; setQuery('') }
  }
  return <details ref={details} className="label-picker assignment-picker" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false }} onKeyDown={(event) => {
    if (event.key === 'Escape' && details.current?.open) { event.preventDefault(); event.stopPropagation(); details.current.open = false; details.current.querySelector('summary')?.focus() }
  }}>
    <summary aria-label={t("Attribution")} title={current ?? t("Attribution")}><Icon name="users" /><span>{ids.size > 1 ? t("Attribution mixte") : current ?? t("Non attribué")}</span></summary>
    <div className="label-popup assignment-popup" role="group" aria-label={t("Attribuer les conversations")}>
      {currentId ? <button className="assign-self" disabled={disabled} onClick={() => void assign(currentId)}>{t("M’attribuer")}</button> : null}
      <input type="search" aria-label={t("Rechercher un collègue")} placeholder={t("Rechercher un collègue…")} value={query} onChange={(event) => setQuery(event.target.value)} />
      {members.filter((member) => normalize(member.name + ' ' + member.email).includes(normalize(query.trim()))).map((member) => <button key={member.id} disabled={disabled} title={member.email} aria-pressed={conversations.length > 0 && conversations.every((item) => item.assigneeId === member.id)} onClick={() => void assign(member.id)}><span className="user-avatar">{member.name.split(' ').map((part) => part[0]).slice(0,2).join('')}</span><span>{member.name}<small>{member.email}</small></span></button>)}
      {!members.length ? <p>{t("Les collègues apparaissent après leur première connexion à cette boîte.")}</p> : null}
      {members.length && !members.some((member) => normalize(member.name + ' ' + member.email).includes(normalize(query.trim()))) ? <p>{t("Aucun collègue trouvé.")}</p> : null}
      <button className="remove-assignment" disabled={disabled || !conversations.some((item) => item.assigneeId)} onClick={() => void assign(null)}>{t("Retirer l’attribution")}</button>
    </div>
  </details>
}
