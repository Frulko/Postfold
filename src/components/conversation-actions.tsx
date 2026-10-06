import type { ConversationPatch, Conversation } from '../../shared/mailbox'
import { conversationStatuses } from '../../shared/conversation-state'
import { Icon } from './icon'

export function ConversationActions({ unread, status, disabled, onChange }: {
  unread?: boolean; status?: Conversation['status']; disabled: boolean
  onChange: (patch: ConversationPatch) => Promise<boolean>
}) {
  const bulk = unread === undefined
  return <div className={`conversation-actions ${bulk ? 'batch' : ''}`} role="group" aria-label={bulk ? 'Actions sur les conversations sélectionnées' : 'Actions sur cette conversation'}>
    {(bulk ? [false, true] : [!unread]).map((next) => <button key={String(next)} className="secondary-button read-action" disabled={disabled} title={`Marquer ${bulk ? 'le lot' : 'la conversation'} comme ${next ? 'non lu' : 'lu'}`} aria-label={bulk ? `Marquer le lot comme ${next ? 'non lu' : 'lu'}` : `Marquer comme ${next ? 'non lu' : 'lu'}`} onClick={() => void onChange({ unread: next })}><Icon name="mail" />{bulk ? next ? 'Non lu' : 'Lu' : next ? 'Marquer non lu' : 'Marquer lu'}</button>)}
    <select aria-label={bulk ? 'Changer l’état des conversations sélectionnées' : 'État de cette conversation'} disabled={disabled} value={status ?? ''} onChange={(event) => void onChange({ status: event.target.value as Conversation['status'] })}>
      {bulk ? <option value="" disabled>Changer l’état…</option> : null}
      {Object.entries(conversationStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select>
  </div>
}
