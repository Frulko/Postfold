import { useI18n } from '../lib/i18n'
import type { ConversationPatch, Conversation } from '../../shared/mailbox'
import { conversationStatuses } from '../../shared/conversation-state'
import { Icon } from './icon'

export function ConversationActions({ unread, status, disabled, onChange }: {
  unread?: boolean; status?: Conversation['status']; disabled: boolean
  onChange: (patch: ConversationPatch) => Promise<boolean>
}) {
  const { t } = useI18n()
  const bulk = unread === undefined
  return <div className={`conversation-actions ${bulk ? 'batch' : ''}`} role="group" aria-label={bulk ? t("Actions sur les conversations sélectionnées") : t("Actions sur cette conversation")}>
    {(bulk ? [false, true] : [!unread]).map((next) => <button key={String(next)} className="secondary-button read-action" disabled={disabled} title={t("Marquer {0} comme {1}", bulk ? t("le lot") : t("la conversation"), next ? t("non lu") : t("lu"))} aria-label={bulk ? t("Marquer le lot comme {0}", next ? t("non lu") : t("lu")) : t("Marquer comme {0}", next ? t("non lu") : t("lu"))} onClick={() => void onChange({ unread: next })}><Icon name="mail" />{bulk ? next ? t("Non lu") : t("Lu") : next ? t("Marquer non lu") : t("Marquer lu")}</button>)}
    <select aria-label={bulk ? t("Changer l’état des conversations sélectionnées") : t("État de cette conversation")} disabled={disabled} value={status ?? ''} onChange={(event) => void onChange({ status: event.target.value as Conversation['status'] })}>
      {bulk ? <option value="" disabled>{t("Changer l’état…")}</option> : null}
      {Object.entries(conversationStatuses).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
    </select>
  </div>
}
